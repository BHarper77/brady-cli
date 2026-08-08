// ---------------------------------------------------------------------------
// The review phase: once CI is green, wait for the automated reviewer to finish,
// triage its comments against the parent issue's brief, then work the ones worth
// acting on one fresh agent at a time — the ralph loop, applied to review
// feedback instead of sub-issues.
// ---------------------------------------------------------------------------

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import * as github from "../github";
import REVIEW_FIX_PROMPT from "../ralph-review-fix-prompt.md";
import REVIEW_TRIAGE_PROMPT from "../ralph-review-triage-prompt.md";
import { Ledger, delay, enforceBudget, formatDuration, runTracked } from "./iteration";

/** How long to wait for the review workflow to queue a run for our head sha. */
const RUN_APPEARS_TIMEOUT_MS = 3 * 60 * 1000;
/** How long to wait for that run to finish once it has appeared. */
const RUN_COMPLETES_TIMEOUT_MS = 30 * 60 * 1000;
/** Gap between polls of the workflow run's state. */
const POLL_INTERVAL_MS = 20_000;

export type ReviewContext = {
  branch: string;
  pr: { number: number; url: string };
  parentIssue: number;
  /** Workflow file that posts the review, e.g. "claude-code-review.yml". */
  workflow: string;
  /** How many push → review → fix rounds to run at most. */
  maxRounds: number;
  ledger: Ledger;
  /** Re-run the CI watch/fix loop after a round pushes fixes. */
  settleCi: () => Promise<void>;
  /**
   * Stop after triage: print the verdicts, post no replies, change no code.
   * Exercises the judgement half of the loop — the part worth checking before
   * trusting it — without touching the PR.
   */
  dryRun?: boolean;
};

/**
 * Why the review phase stopped. None of these is a failure: `clean` means a
 * round found nothing left to act on, `no-review` that no review was posted to
 * read, `capped` that fixes were applied and pushed but the round budget ran
 * out before the reviewer got to see them, and `dry-run` that triage reported
 * its verdicts and stopped.
 */
export type ReviewOutcome = "clean" | "no-review" | "capped" | "dry-run";

/**
 * Run the review rounds. Each round waits for a review of the *current* head
 * sha, triages it, fixes what survives triage, pushes once, and lets CI settle.
 * Returns as soon as a round finds nothing worth acting on.
 */
export async function reviewLoop(ctx: ReviewContext): Promise<ReviewOutcome> {
  for (let round = 1; round <= ctx.maxRounds; round++) {
    console.log(
      `\n──────── review round ${round}/${ctx.maxRounds} on PR #${ctx.pr.number} ────────`,
    );

    const sha = github.getPrHeadSha(ctx.branch);
    if (!sha) {
      console.error("review: could not read the PR head sha — skipping review.");
      return "no-review";
    }

    if (!(await waitForReviewRun(ctx.workflow, sha))) return "no-review";

    const reviews = github
      .listReviewsForSha(ctx.pr.number, sha)
      .filter((r) => r.state !== "APPROVED" || r.body.trim() !== "");

    if (reviews.length === 0) {
      console.log(
        `review: the workflow finished but left no review on ${sha.slice(0, 7)} — nothing to triage.`,
      );
      return "no-review";
    }

    const comments = github.listReviewComments(
      ctx.pr.number,
      reviews.map((r) => r.id),
    );

    if (comments.length === 0) {
      console.log("\n✓ review: the reviewer left no comments — PR is clean.");
      return "clean";
    }

    console.log(`review: ${comments.length} comment(s) to triage.`);

    const verdicts = await triage(ctx, reviews, comments);
    const judged = comments.map((c) => ({ comment: c, verdict: verdicts.get(c.id) }));
    const valid = judged.filter((x) => x.verdict?.valid === true);

    console.log(
      `\nreview: ${valid.length}/${comments.length} comment(s) judged worth acting on.`,
    );
    // A dry run is being read for its judgement, so show the dismissals too —
    // triage waving away a real defect is the failure mode worth catching.
    for (const { comment, verdict } of ctx.dryRun ? judged : valid) {
      const mark = verdict?.valid ? "FIX " : "SKIP";
      console.log(
        `  ${ctx.dryRun ? `${mark} ` : "• "}${comment.path}:${comment.line ?? "?"} — ${verdict?.reason ?? ""}`,
      );
      if (ctx.dryRun) console.log(`       ${comment.url}`);
    }

    if (ctx.dryRun) {
      console.log(
        "\n✓ review (dry run): triage only — no replies posted, no code changed.",
      );
      return "dry-run";
    }

    // A dismissal has had its reply posted by triage, so the thread is finished
    // business — resolve it now, before any fix runs, so a later round never
    // re-triages a comment we have already answered.
    resolveThreads(
      judged.filter((x) => x.verdict?.valid === false).map((x) => x.comment),
    );

    if (valid.length === 0) {
      console.log(
        "\n✓ review: every comment was explained away — no changes needed.",
      );
      return "clean";
    }

    for (const [i, { comment, verdict }] of valid.entries()) {
      console.log(
        `\n──────── review fix ${i + 1}/${valid.length}: ${comment.path}:${comment.line ?? "?"} ────────`,
      );

      const prompt = REVIEW_FIX_PROMPT.replaceAll("{{PR_NUMBER}}", String(ctx.pr.number))
        .replaceAll("{{BRANCH}}", ctx.branch)
        .replaceAll("{{PARENT_ISSUE}}", String(ctx.parentIssue))
        .replaceAll("{{COMMENT_ID}}", String(comment.id))
        .replaceAll("{{COMMENT_PATH}}", comment.path)
        .replaceAll(
          "{{COMMENT_LOCATION_SUFFIX}}",
          comment.line !== null ? ` line ${comment.line}` : " (line no longer in the diff)",
        )
        .replaceAll("{{COMMENT_URL}}", comment.url)
        .replaceAll("{{COMMENT_BODY}}", comment.body)
        .replaceAll("{{TRIAGE_REASON}}", verdict?.reason ?? "")
        .replaceAll("{{INDEX}}", String(i + 1))
        .replaceAll("{{TOTAL}}", String(valid.length));

      const before = headSha();
      await runTracked(`review fix ${round}.${i + 1}`, prompt, ctx.ledger);
      enforceBudget(ctx.ledger);

      // A commit is the evidence that the comment was actually acted on. An
      // agent that talked itself out of its comment leaves the thread open for
      // a human to read its reply and decide.
      if (headSha() !== before) resolveThreads([comment]);
      else
        console.log(
          `review: comment ${comment.id} produced no commit — leaving its thread open.`,
        );
    }

    // One push per round, not per comment: each push retriggers both CI and the
    // review workflow, and a round's fixes only make sense reviewed together.
    if (!pushBranch(ctx.branch)) {
      console.log("review: nothing was committed this round — stopping.");
      return "clean";
    }

    // Always let CI settle on the fixes — the run must never end on a red PR.
    await ctx.settleCi();

    // The push above retriggers the reviewer, but on the last round nobody is
    // left to read what it says, so don't pay for the wait.
    if (round === ctx.maxRounds) {
      console.log(
        `\n✓ review: ${ctx.maxRounds} round(s) done — fixes pushed and green. Any review of them is left for you.`,
      );
      return "capped";
    }
  }

  return "capped";
}

type Verdict = { valid: boolean; reason: string };

/** Current commit on the working branch, used to tell whether an agent committed. */
function headSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * Mark each comment's thread resolved. Best-effort: a thread we cannot resolve
 * (no thread id, or the API refusing) is a tidiness problem, never a reason to
 * stop the loop.
 */
function resolveThreads(comments: github.PrReviewComment[]) {
  for (const comment of comments) {
    if (!comment.threadId) continue;
    try {
      github.resolveReviewThread(comment.threadId);
      console.log(`review: resolved thread for ${comment.path}:${comment.line ?? "?"}.`);
    } catch (error) {
      console.error(
        `review: could not resolve thread for comment ${comment.id} — ${String(error)}`,
      );
    }
  }
}

/**
 * One triage iteration over the whole review. The agent judges each comment
 * against the parent issue's brief, replies to the ones it dismisses, and
 * writes its verdicts to a temp file we read back — an agent's prose is not a
 * parseable contract, but a file it was told to write is.
 */
async function triage(
  ctx: ReviewContext,
  reviews: github.PrReview[],
  comments: github.PrReviewComment[],
): Promise<Map<number, Verdict>> {
  const verdictsPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ralph-review-")),
    "verdicts.json",
  );

  const payload = comments.map((c) => ({
    commentId: c.id,
    path: c.path,
    line: c.line,
    body: c.body,
  }));

  const prompt = REVIEW_TRIAGE_PROMPT.replaceAll(
    "{{PR_NUMBER}}",
    String(ctx.pr.number),
  )
    .replaceAll("{{BRANCH}}", ctx.branch)
    .replaceAll("{{PARENT_ISSUE}}", String(ctx.parentIssue))
    .replaceAll(
      "{{REVIEW_BODY}}",
      reviews
        .map((r) => r.body.trim())
        .filter(Boolean)
        .join("\n\n---\n\n") || "(no review body)",
    )
    .replaceAll("{{COMMENTS_JSON}}", JSON.stringify(payload, null, 2))
    .replaceAll("{{VERDICTS_PATH}}", verdictsPath)
    .replaceAll(
      "{{MODE_BANNER}}",
      ctx.dryRun
        ? "\n**DRY RUN.** Write the verdicts file and nothing else. Do not post any reply to GitHub — skip the reply step in the Output section below entirely. Judge exactly as you otherwise would; only the posting is suppressed.\n"
        : "",
    );

  console.log("\n──────── review triage ────────");
  await runTracked("review triage", prompt, ctx.ledger);
  enforceBudget(ctx.ledger);

  return readVerdicts(verdictsPath, comments);
}

/**
 * Parse the verdicts file. Any comment the agent failed to judge is treated as
 * valid — an unreadable triage should send work to a fix agent that can read
 * the code, not silently drop a finding.
 */
function readVerdicts(
  verdictsPath: string,
  comments: github.PrReviewComment[],
): Map<number, Verdict> {
  const verdicts = new Map<number, Verdict>();

  let parsed: { verdicts?: { commentId?: number; valid?: boolean; reason?: string }[] };
  try {
    parsed = JSON.parse(fs.readFileSync(verdictsPath, "utf-8")) as typeof parsed;
  } catch {
    console.error(
      `review: triage wrote no readable verdicts to ${verdictsPath} — treating every comment as valid.`,
    );
    parsed = {};
  }

  for (const v of parsed.verdicts ?? []) {
    if (typeof v.commentId !== "number" || typeof v.valid !== "boolean") continue;
    verdicts.set(v.commentId, { valid: v.valid, reason: v.reason ?? "" });
  }

  for (const c of comments) {
    if (verdicts.has(c.id)) continue;
    console.error(
      `review: triage returned no verdict for comment ${c.id} (${c.path}) — treating it as valid.`,
    );
    verdicts.set(c.id, { valid: true, reason: "Triage returned no verdict for this comment." });
  }

  return verdicts;
}

/**
 * Wait for the review workflow's run against `sha` to finish. False means we
 * should skip the review phase entirely: no run ever appeared (the repo has no
 * such workflow, or it does not trigger on this PR), or it never finished.
 */
async function waitForReviewRun(workflow: string, sha: string): Promise<boolean> {
  const short = sha.slice(0, 7);
  console.log(`review: waiting for ${workflow} on ${short}…`);

  const start = Date.now();
  let appeared = false;

  for (;;) {
    const run = github.getWorkflowRunForSha(workflow, sha);

    if (run.status === "completed") {
      console.log(
        `review: ${workflow} finished on ${short} (${run.conclusion}) after ${formatDuration(Date.now() - start)}.`,
      );
      // A failed review run may still have posted its review before dying, so
      // press on and let the caller find out whether a review actually exists.
      return true;
    }

    if (run.status === "running" && !appeared) {
      appeared = true;
      console.log(`review: ${workflow} is running on ${short}.`);
    }

    const elapsed = Date.now() - start;
    const timeout = appeared ? RUN_COMPLETES_TIMEOUT_MS : RUN_APPEARS_TIMEOUT_MS;
    if (elapsed > timeout) {
      console.error(
        appeared
          ? `review: ${workflow} still running after ${formatDuration(elapsed)} — skipping review.`
          : `review: no ${workflow} run appeared for ${short} within ${formatDuration(elapsed)} — skipping review.`,
      );
      return false;
    }

    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Push the branch. False when the round produced no new commits, which means
 * every fix agent talked itself out of its comment — nothing to push, and no
 * point running another round.
 */
function pushBranch(branch: string): boolean {
  const ahead = spawnSync(
    "git",
    ["rev-list", "--count", `origin/${branch}..${branch}`],
    { encoding: "utf-8", stdio: "pipe" },
  );

  if (ahead.status === 0 && Number(ahead.stdout.trim()) === 0) return false;

  const result = spawnSync("git", ["push", "origin", branch], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`review: failed to push branch "${branch}".`);
    process.exit(1);
  }
  return true;
}

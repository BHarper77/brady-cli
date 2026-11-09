// ---------------------------------------------------------------------------
// The review phase: once CI is green, wait for the automated reviewer to finish,
// triage its comments against the parent issue's brief, then work the ones worth
// acting on one fresh agent per fix group — the ralph loop, applied to review
// feedback instead of sub-issues.
// ---------------------------------------------------------------------------

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import * as github from "../github";
import REVIEW_FIX_PROMPT from "../ralph-review-fix-prompt.md";
import REVIEW_TRIAGE_PROMPT from "../ralph-review-triage-prompt.md";
import { LoadedSkill, loadSkill } from "../skills";
import { Ledger, delay, enforceBudget, formatDuration, note, runTracked } from "./iteration";
import { Verdict, newlyReplied, parseVerdicts, partitionForResolve } from "./review-gates";

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
 * its verdicts and stopped. `aborted` is the one failure: triage produced no
 * usable verdicts, or a review skill could not be read, so nothing past that
 * point can be trusted to act on the comments.
 */
export type ReviewOutcome = "clean" | "no-review" | "capped" | "dry-run" | "aborted";

/** Triage left the loop nothing it can act on safely. */
class TriageFailed extends Error {}

/** Shout, because an aborted review leaves real findings unhandled on the PR. */
function abortReview(ledger: Ledger, reason: string): ReviewOutcome {
  const text = `\n✗ review ABORTED: ${reason}\n  Unjudged comments were left open on the PR — nothing was resolved for them.`;
  console.error(text);
  ledger.logger?.logLine(text);
  return "aborted";
}

/**
 * Run the review rounds. Each round waits for a review of the *current* head
 * sha, triages it, fixes what survives triage, pushes once, and lets CI settle.
 * Returns as soon as a round finds nothing worth acting on.
 */
export async function reviewLoop(ctx: ReviewContext): Promise<ReviewOutcome> {
  // Preflight checked these, but they are read again here: their bodies are
  // embedded in the prompts, and a skill edited away mid-run must stop the
  // phase rather than send an agent off with no instructions.
  const triageSkill = loadSkill("review-triage");
  const fixSkill = loadSkill("review-fix");
  if (!triageSkill || !fixSkill) {
    return abortReview(
      ctx.ledger,
      `could not read the ${!triageSkill ? "review-triage" : "review-fix"} skill's SKILL.md.`,
    );
  }

  for (let round = 1; round <= ctx.maxRounds; round++) {
    note(
      ctx.ledger,
      `\n──────── review round ${round}/${ctx.maxRounds} on PR #${ctx.pr.number} ────────`,
    );

    const sha = github.getPrHeadSha(ctx.branch);
    if (!sha) {
      console.error("review: could not read the PR head sha — skipping review.");
      return "no-review";
    }

    if (!(await waitForReviewRun(ctx.ledger, ctx.workflow, sha))) return "no-review";

    const reviews = github
      .listReviewsForSha(ctx.pr.number, sha)
      .filter((r) => r.state !== "APPROVED" || r.body.trim() !== "");

    if (reviews.length === 0) {
      note(
        ctx.ledger,
        `review: the workflow finished but left no review on ${sha.slice(0, 7)} — nothing to triage.`,
      );
      return "no-review";
    }

    const comments = github.listReviewComments(
      ctx.pr.number,
      reviews.map((r) => r.id),
    );

    if (comments.length === 0) {
      note(ctx.ledger, "\n✓ review: the reviewer left no comments — PR is clean.");
      return "clean";
    }

    note(ctx.ledger, `review: ${comments.length} comment(s) to triage.`);

    let verdicts: Map<number, Verdict>;
    try {
      verdicts = await triage(ctx, triageSkill, reviews, comments);
    } catch (error) {
      if (error instanceof TriageFailed) return abortReview(ctx.ledger, error.message);
      throw error;
    }
    const judged = comments.map((c) => ({ comment: c, verdict: verdicts.get(c.id) }));
    const valid = judged.filter((x) => x.verdict?.valid === true);

    note(
      ctx.ledger,
      `\nreview: ${valid.length}/${comments.length} comment(s) judged worth acting on.`,
    );
    // A dry run is being read for its judgement, so show the dismissals too —
    // triage waving away a real defect is the failure mode worth catching.
    for (const { comment, verdict } of ctx.dryRun ? judged : valid) {
      const mark = verdict?.valid ? "FIX " : "SKIP";
      const group = verdict?.valid && verdict.group ? ` [${verdict.group}]` : "";
      note(
        ctx.ledger,
        `  ${ctx.dryRun ? `${mark} ` : "• "}${comment.path}:${comment.line ?? "?"}${group} — ${verdict?.reason ?? ""}`,
      );
      if (ctx.dryRun) note(ctx.ledger, `       ${comment.url}`);
    }

    if (ctx.dryRun) {
      note(
        ctx.ledger,
        "\n✓ review (dry run): triage only — no replies posted, no code changed.",
      );
      return "dry-run";
    }

    // The review-triage skill replies to a dismissal and resolves it itself, so
    // this is a backstop for the thread it could not close — resolving an
    // already-resolved thread is a no-op. It runs before any fix, so a later
    // round never re-triages a comment we have already answered.
    resolveThreads(
      ctx.ledger,
      judged.filter((x) => x.verdict?.valid === false).map((x) => x.comment),
    );

    if (valid.length === 0) {
      note(
        ctx.ledger,
        "\n✓ review: every comment was explained away — no changes needed.",
      );
      return "clean";
    }

    // Comments triage judged to need the same change share one session: one
    // context read, one build, one test run, rather than one per comment.
    const groups = groupFixes(valid);
    if (groups.length < valid.length) {
      note(
        ctx.ledger,
        `review: ${valid.length} comment(s) grouped into ${groups.length} fix session(s).`,
      );
    }

    const unaddressed: github.PrReviewComment[] = [];
    for (const [i, group] of groups.entries()) {
      const first = group[0]!.comment;
      const more = group.length > 1 ? ` (+${group.length - 1} more)` : "";
      note(
        ctx.ledger,
        `\n──────── review fix ${i + 1}/${groups.length}: ${first.path}:${first.line ?? "?"}${more} ────────`,
      );

      const prompt = REVIEW_FIX_PROMPT.replaceAll("{{PR_NUMBER}}", String(ctx.pr.number))
        .replaceAll("{{BRANCH}}", ctx.branch)
        .replaceAll("{{PARENT_ISSUE}}", String(ctx.parentIssue))
        .replaceAll("{{COMMENT_IDS}}", group.map((x) => x.comment.id).join(", "))
        .replaceAll("{{COUNT}}", String(group.length))
        .replaceAll("{{INDEX}}", String(i + 1))
        .replaceAll("{{TOTAL}}", String(groups.length))
        .replaceAll("{{COMMENTS}}", renderFixComments(ctx.pr.number, group))
        .replaceAll("{{SKILL_DIR}}", fixSkill.dir)
        .replaceAll("{{SKILL_BODY}}", fixSkill.body);

      const ids = group.map((x) => x.comment.id);
      const before = headSha();
      const repliesBefore = safeReplyIds(ctx.pr.number);
      await runTracked(`review fix ${round}.${i + 1}`, prompt, ctx.ledger);
      enforceBudget(ctx.ledger);

      // Resolve only on evidence the agent dealt with a thread: a commit landed
      // (one fix group, one commit), or it replied on that thread. An agent
      // that refused, crashed, or did nothing leaves its threads open — closing
      // them would bury real findings unaddressed.
      const committed = headSha() !== before;
      const repliesAfter = safeReplyIds(ctx.pr.number);
      const replied =
        repliesBefore && repliesAfter
          ? newlyReplied(repliesBefore, repliesAfter, ids)
          : new Set<number>();
      const { resolve, leaveOpen } = partitionForResolve(
        group.map((x) => x.comment),
        committed,
        replied,
      );

      if (!committed) {
        note(ctx.ledger, `review: comment(s) ${ids.join(", ")} produced no commit.`);
      }
      resolveThreads(ctx.ledger, resolve);
      for (const comment of leaveOpen) {
        unaddressed.push(comment);
        note(
          ctx.ledger,
          `⚠ review: no commit and no reply for ${comment.path}:${comment.line ?? "?"} (comment ${comment.id}) — leaving its thread open. ${comment.url}`,
        );
      }
    }

    if (unaddressed.length > 0) {
      const text = `\n⚠ review: ${unaddressed.length} valid comment(s) left open unaddressed — the fix agent neither committed nor replied. Handle them by hand.`;
      console.error(text);
      ctx.ledger.logger?.logLine(text);
    }

    // One push per round, not per comment: each push retriggers both CI and the
    // review workflow, and a round's fixes only make sense reviewed together.
    if (!pushBranch(ctx.branch)) {
      note(ctx.ledger, "review: nothing was committed this round — stopping.");
      return "clean";
    }

    // Always let CI settle on the fixes — the run must never end on a red PR.
    await ctx.settleCi();

    // The push above retriggers the reviewer, but on the last round nobody is
    // left to read what it says, so don't pay for the wait.
    if (round === ctx.maxRounds) {
      note(
        ctx.ledger,
        `\n✓ review: ${ctx.maxRounds} round(s) done — fixes pushed and green. Any review of them is left for you.`,
      );
      return "capped";
    }
  }

  return "capped";
}

type Judged = { comment: github.PrReviewComment; verdict: Verdict | undefined };

/**
 * Split the valid comments into fix groups, one fix session each. Comments
 * sharing a triage `group` label land together; an unlabelled comment is a
 * group of one. Groups keep the order of their first comment.
 */
function groupFixes(valid: Judged[]): Judged[][] {
  const groups: Judged[][] = [];
  const byLabel = new Map<string, Judged[]>();

  for (const item of valid) {
    const label = item.verdict?.group;
    const existing = label !== undefined ? byLabel.get(label) : undefined;
    if (existing) {
      existing.push(item);
      continue;
    }
    const group = [item];
    groups.push(group);
    if (label !== undefined) byLabel.set(label, group);
  }

  return groups;
}

/**
 * The fix prompt's per-comment section: each comment's location, body, triage
 * brief, and the exact commands to reply on and resolve its thread — so a
 * grouped session cannot answer one thread and forget the rest.
 */
function renderFixComments(pr: number, group: Judged[]): string {
  return group
    .map(({ comment, verdict }, i) => {
      const location =
        comment.line !== null ? ` line ${comment.line}` : " (line no longer in the diff)";
      const resolve = comment.threadId
        ? `gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=${comment.threadId}`
        : "# thread id unknown: the loop resolves this one after you finish";

      return [
        `### Comment ${i + 1} of ${group.length}`,
        "",
        `- **id**: ${comment.id}`,
        `- **location**: \`${comment.path}\`${location}`,
        `- **link**: ${comment.url}`,
        "",
        "```",
        comment.body,
        "```",
        "",
        "Triage's brief:",
        "",
        `> ${verdict?.reason ?? ""}`,
        "",
        "Reply, then resolve:",
        "",
        "```bash",
        `gh api repos/{owner}/{repo}/pulls/${pr}/comments/${comment.id}/replies -f body='<what changed, and the commit sha>'`,
        resolve,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

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
function resolveThreads(ledger: Ledger, comments: github.PrReviewComment[]) {
  for (const comment of comments) {
    if (!comment.threadId) continue;
    try {
      github.resolveReviewThread(comment.threadId);
      note(ledger, `review: resolved thread for ${comment.path}:${comment.line ?? "?"}.`);
    } catch (error) {
      console.error(
        `review: could not resolve thread for comment ${comment.id} — ${String(error)}`,
      );
    }
  }
}

/** Reply ids per thread, or undefined when GitHub could not be read. */
function safeReplyIds(pr: number): Map<number, number[]> | undefined {
  try {
    return github.listReplyIds(pr);
  } catch (error) {
    console.error(`review: could not read thread replies — ${String(error)}`);
    return undefined;
  }
}

/**
 * Triage the whole review. The judgement belongs to the `review-triage` skill —
 * what counts as valid, what gets a reply, what gets resolved — whose body the
 * loop embeds in the prompt alongside the comments to judge. The one thing the
 * loop adds is the verdicts file: an agent's prose is not a parseable contract,
 * but a file it was told to write is.
 *
 * Failure handling, since a verdict decides whether a finding is acted on:
 * - no file, unparseable, or no `verdicts` array → `TriageFailed`; the caller
 *   aborts the phase rather than guessing at every comment;
 * - some comments left without a verdict → one more triage iteration over just
 *   those; if any are still missing after it, `TriageFailed`.
 */
async function triage(
  ctx: ReviewContext,
  skill: LoadedSkill,
  reviews: github.PrReview[],
  comments: github.PrReviewComment[],
): Promise<Map<number, Verdict>> {
  const first = await triageOnce(ctx, skill, reviews, comments, "review triage");
  if (first.missing.length === 0) return first.verdicts;

  const missing = comments.filter((c) => first.missing.includes(c.id));
  note(
    ctx.ledger,
    `review: triage left ${missing.length} comment(s) without a verdict (${first.missing.join(", ")}) — re-triaging just those once.`,
  );
  const retry = await triageOnce(ctx, skill, reviews, missing, "review triage (retry)");
  if (retry.missing.length > 0) {
    throw new TriageFailed(
      `triage still gave no verdict for comment(s) ${retry.missing.join(", ")} after a retry.`,
    );
  }
  for (const [id, verdict] of retry.verdicts) first.verdicts.set(id, verdict);
  return first.verdicts;
}

/** One triage iteration over `comments`, read back through its verdicts file. */
async function triageOnce(
  ctx: ReviewContext,
  skill: LoadedSkill,
  reviews: github.PrReview[],
  comments: github.PrReviewComment[],
  label: string,
): Promise<{ verdicts: Map<number, Verdict>; missing: number[] }> {
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

  const prompt = REVIEW_TRIAGE_PROMPT.replaceAll("{{PR_NUMBER}}", String(ctx.pr.number))
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
        ? "\n**DRY RUN.** Write the verdicts file and nothing else. Do not post any reply to GitHub and do not resolve any thread — skip those steps of the instructions entirely. Judge exactly as you otherwise would; only the posting is suppressed.\n"
        : "",
    )
    .replaceAll("{{SKILL_DIR}}", skill.dir)
    // Last, so text inside the skill body is never mistaken for a placeholder.
    .replaceAll("{{SKILL_BODY}}", skill.body);

  note(ctx.ledger, `\n──────── ${label} ────────`);
  // Triage changes no code, so leftovers in the tree are not its business.
  await runTracked(label, prompt, ctx.ledger, { dirtyTreeNote: false });
  enforceBudget(ctx.ledger);

  let raw: string | undefined;
  try {
    raw = fs.readFileSync(verdictsPath, "utf-8");
  } catch {
    raw = undefined;
  }

  const parsed = parseVerdicts(
    raw,
    comments.map((c) => c.id),
  );
  if (!parsed.ok) {
    throw new TriageFailed(`${parsed.error} (${verdictsPath}).`);
  }
  return { verdicts: parsed.verdicts, missing: parsed.missing };
}

/**
 * Wait for the review workflow's run against `sha` to finish. False means we
 * should skip the review phase entirely: no run ever appeared (the repo has no
 * such workflow, or it does not trigger on this PR), or it never finished.
 */
async function waitForReviewRun(
  ledger: Ledger,
  workflow: string,
  sha: string,
): Promise<boolean> {
  const short = sha.slice(0, 7);
  note(ledger, `review: waiting for ${workflow} on ${short}…`);

  const start = Date.now();
  let appeared = false;

  for (;;) {
    const run = github.getWorkflowRunForSha(workflow, sha);

    if (run.status === "completed") {
      note(
        ledger,
        `review: ${workflow} finished on ${short} (${run.conclusion}) after ${formatDuration(Date.now() - start)}.`,
      );
      // A failed review run may still have posted its review before dying, so
      // press on and let the caller find out whether a review actually exists.
      return true;
    }

    if (run.status === "running" && !appeared) {
      appeared = true;
      note(ledger, `review: ${workflow} is running on ${short}.`);
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

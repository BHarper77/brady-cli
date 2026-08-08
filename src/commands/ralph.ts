import { spawnSync } from "child_process";
import { NAMER_MODEL } from "../config";
import * as github from "../github";
import {
  Ledger,
  delay,
  enforceBudget,
  printSummary,
  runTracked,
} from "../ralph/iteration";
import { reviewLoop } from "../ralph/review";
import RALPH_PROMPT from "../ralph-prompt.md";
import RALPH_CI_PROMPT from "../ralph-ci-prompt.md";

type RalphOptions = {
  maxIterations: string;
  ciMaxIterations: string;
  ci: boolean;
  review: boolean;
  reviewMaxRounds: string;
  reviewWorkflow: string;
  branch?: string;
  budget?: string;
};

export async function ralph(issueArg: string, opts: RalphOptions) {
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(`Error: <issue> must be a positive integer, got "${issueArg}".`);
    process.exit(1);
  }

  const maxIterations = positiveInt(opts.maxIterations, "--max-iterations");
  const ciMaxIterations = positiveInt(opts.ciMaxIterations, "--ci-max-iterations");
  const reviewMaxRounds = positiveInt(opts.reviewMaxRounds, "--review-max-rounds");

  let budget: number | undefined;
  if (opts.budget !== undefined) {
    budget = Number(opts.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      console.error(`Error: --budget must be a positive number, got "${opts.budget}".`);
      process.exit(1);
    }
  }

  await ralphPreflight(issue);

  const branch = opts.branch ?? (await nameBranch(issue));
  checkoutBranch(branch);

  console.log(
    `\nralph: parent issue #${issue} on branch "${branch}" (max ${maxIterations} iterations${
      budget !== undefined ? `, budget $${budget}` : ""
    })`,
  );
  console.log(
    "Billing: under a Pro/Max subscription this draws down rate limits (no per-token bill).\n" +
      "If ANTHROPIC_API_KEY is set it wins and bills per-token — use --budget to cap that path.\n",
  );

  const ledger: Ledger = { totalCost: 0, budget, stats: [] };

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n──────── iteration ${i}/${maxIterations} ────────`);

    const prompt = RALPH_PROMPT.replaceAll("{{PARENT_ISSUE}}", String(issue));
    const { completed } = await runTracked(`iteration ${i}`, prompt, ledger);

    if (completed) {
      console.log(
        `\n✓ ralph complete — no open sub-issues remain (total $${ledger.totalCost.toFixed(4)}).`,
      );
      if (opts.ci) {
        await postRalph(branch, issue, ledger, {
          ciMaxIterations,
          review: opts.review,
          reviewMaxRounds,
          reviewWorkflow: opts.reviewWorkflow,
        });
      }
      printSummary(ledger);
      return;
    }

    enforceBudget(ledger);
  }

  console.error(
    `\nStopping: hit max iterations (${maxIterations}) without completion signal.`,
  );
  printSummary(ledger);
  process.exit(1);
}

/** Parse a count option, exiting with a labelled error when it is not a positive integer. */
function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Error: ${flag} must be a positive integer, got "${raw}".`);
    process.exit(1);
  }
  return n;
}

/** Deterministic preflight. Fails fast via console.error + exit(1). */
async function ralphPreflight(issue: number) {
  // 1. Inside a git repo.
  if (
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "pipe" })
      .status !== 0
  ) {
    console.error("Error: not inside a git repository.");
    process.exit(1);
  }

  // 2. gh authed (reuses the shared helper; prompts to log in if needed).
  await github.ensureAuth();

  // 3. claude binary present.
  if (
    spawnSync("claude", ["--version"], { stdio: "pipe", shell: true }).status !==
    0
  ) {
    console.error(
      "Error: `claude` CLI not found. Install Claude Code and ensure `claude` is on PATH.",
    );
    process.exit(1);
  }

  // 4. Clean working tree (hard abort — no bypass in v1).
  const porcelain = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf-8",
  });
  if (porcelain.stdout.trim() !== "") {
    console.error(
      "Error: working tree is not clean. Commit or stash your changes before running ralph.",
    );
    process.exit(1);
  }

  // 5. Parent issue exists and has open sub-issues.
  let subIssues: { state: string }[];
  try {
    subIssues = github.listSubIssues(issue);
  } catch {
    console.error(
      `Error: issue #${issue} not found, or it has no sub-issues. Nothing to do.`,
    );
    process.exit(1);
  }

  const open = subIssues.filter((s) => s.state === "open");
  if (open.length === 0) {
    console.error(
      `Nothing to do: issue #${issue} has no open sub-issues.`,
    );
    process.exit(1);
  }

  console.log(`Found ${open.length} open sub-issue(s) under #${issue}.`);
}

/** One-shot Haiku call that names a feat/<kebab> branch. Falls back to a slug. */
async function nameBranch(issue: number): Promise<string> {
  const title = github.getIssueTitle(issue);

  const namerPrompt =
    "Suggest a git branch name for this GitHub issue. " +
    "Respond with ONLY the branch name and nothing else. " +
    "Format must be feat/<kebab-case>, at most about four words. " +
    `Issue title: "${title}"`;

  const result = spawnSync("claude", ["-p", "--model", NAMER_MODEL], {
    input: namerPrompt,
    encoding: "utf-8",
    shell: true,
  });

  const candidate = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";

  if (/^feat\/[a-z0-9-]+$/.test(candidate)) {
    return candidate;
  }

  return fallbackBranch(title, issue);
}

/** Deterministic branch name when the namer output is unusable. */
function fallbackBranch(title: string, issue: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");

  return slug ? `feat/${slug}` : `feat/issue-${issue}`;
}

/** Create the branch, or check it out if it already exists (handles re-runs). */
function checkoutBranch(branch: string) {
  if (!/^feat\/[a-z0-9-]+$/.test(branch)) {
    console.error(
      `Error: branch "${branch}" must match feat/<kebab-case>.`,
    );
    process.exit(1);
  }

  const exists =
    spawnSync("git", ["rev-parse", "--verify", branch], { stdio: "pipe" })
      .status === 0;

  const args = exists ? ["checkout", branch] : ["checkout", "-b", branch];
  const result = spawnSync("git", args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Error: failed to checkout branch "${branch}".`);
    process.exit(1);
  }
}

/**
 * Everything that happens once the slices are done and the PR is open: get CI
 * green, then work the automated review's comments. Both phases spend against
 * the same ledger, so `--budget` still bounds the run as a whole.
 */
async function postRalph(
  branch: string,
  issue: number,
  ledger: Ledger,
  opts: {
    ciMaxIterations: number;
    review: boolean;
    reviewMaxRounds: number;
    reviewWorkflow: string;
  },
): Promise<void> {
  const pr = github.getPrForBranch(branch);
  if (!pr) {
    console.error(
      `\npost-ralph: no open PR found for branch "${branch}" — skipping CI watch.`,
    );
    return;
  }

  console.log(`\n──────── post-ralph: watching CI for PR #${pr.number} ────────`);
  console.log(pr.url);

  const settleCi = () =>
    watchAndFixCi(branch, pr.number, opts.ciMaxIterations, ledger);

  await settleCi();

  if (!opts.review) return;

  await reviewLoop({
    branch,
    pr,
    parentIssue: issue,
    workflow: opts.reviewWorkflow,
    maxRounds: opts.reviewMaxRounds,
    ledger,
    // The review loop pushes its fixes, which restarts CI; it hands the waiting
    // and any red-build repair back to the same loop that got us green.
    settleCi,
  });
}

/**
 * Watch the branch's CI, dispatching a fresh fix-it iteration on every failure
 * until the checks go green. Each fix agent reads the failing logs, repairs the
 * code, and pushes; CI re-runs and we watch again. Exits the process if the
 * checks are still red after `maxAttempts` tries.
 */
async function watchAndFixCi(
  branch: string,
  pr: number,
  maxAttempts: number,
  ledger: Ledger,
): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    // Give a freshly-pushed commit a moment to register its workflow run so
    // the watch latches onto the new checks rather than the stale ones.
    await delay(10_000);

    const verdict = github.watchCiChecks(branch);

    if (verdict === "none") {
      console.log("\npost-ralph: no CI checks configured — nothing to verify.");
      return;
    }

    if (verdict === "passing") {
      console.log(
        `\n✓ post-ralph: CI is green on PR #${pr} (total $${ledger.totalCost.toFixed(4)}).`,
      );
      return;
    }

    console.log(
      `\npost-ralph: CI failing — dispatching fix iteration ${i}/${maxAttempts}.`,
    );

    const prompt = RALPH_CI_PROMPT.replaceAll("{{PR_NUMBER}}", String(pr)).replaceAll(
      "{{BRANCH}}",
      branch,
    );

    await runTracked(`ci fix ${i}`, prompt, ledger);
    enforceBudget(ledger);
  }

  console.error(
    `\nStopping: CI still not green after ${maxAttempts} fix attempt(s).`,
  );
  printSummary(ledger);
  process.exit(1);
}

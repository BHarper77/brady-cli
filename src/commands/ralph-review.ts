import { spawnSync } from "child_process";
import * as github from "../github";
import { watchAndFixCi } from "../ralph/ci";
import { Ledger, printSummary } from "../ralph/iteration";
import { reviewLoop } from "../ralph/review";

type RalphReviewOptions = {
  ciMaxIterations: string;
  maxRounds: string;
  workflow: string;
  dryRun: boolean;
  branch?: string;
  budget?: string;
  stacked?: boolean;
};

/**
 * The review phase on its own, against a PR that already exists. `brady ralph`
 * reaches this after its slices land; this command reaches it directly, so an
 * already-open PR can be worked (or, with --dry-run, triaged and reported on)
 * without a ralph run in front of it.
 */
export async function ralphReview(issueArg: string, opts: RalphReviewOptions) {
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(
      `Error: <issue> must be a positive integer, got "${issueArg}". Pass the parent issue whose brief the comments should be judged against.`,
    );
    process.exit(1);
  }

  if (opts.stacked) {
    console.error(
      "Error: --stacked is not supported by ralph-review — it stays single-PR. " +
        "The layer → sub-issue mapping is derived by watching sub-issues close during a ralph run, and a standalone review has no loop to watch.",
    );
    process.exit(1);
  }

  const ciMaxIterations = positiveInt(opts.ciMaxIterations, "--ci-max-iterations");
  const maxRounds = positiveInt(opts.maxRounds, "--max-rounds");

  let budget: number | undefined;
  if (opts.budget !== undefined) {
    budget = Number(opts.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      console.error(`Error: --budget must be a positive number, got "${opts.budget}".`);
      process.exit(1);
    }
  }

  await preflight(opts.dryRun);

  const branch = opts.branch ?? currentBranch();
  if (!branch || branch === "HEAD") {
    console.error(
      "Error: could not determine the current branch. Pass --branch explicitly.",
    );
    process.exit(1);
  }

  const pr = github.getPrForBranch(branch);
  if (!pr) {
    console.error(`Error: no open PR found for branch "${branch}".`);
    process.exit(1);
  }

  const issueTitle = github.getIssueTitle(issue);
  console.log(
    `\nralph-review: PR #${pr.number} on "${branch}", judged against issue #${issue}` +
      (issueTitle ? ` — ${issueTitle}` : ""),
  );
  console.log(pr.url);
  if (opts.dryRun) {
    console.log(
      "\nDRY RUN: triage only. No replies posted, no code changed, nothing pushed.",
    );
  }

  const ledger: Ledger = { totalCost: 0, budget, stats: [] };

  await reviewLoop({
    branch,
    pr,
    parentIssue: issue,
    workflow: opts.workflow,
    maxRounds,
    ledger,
    dryRun: opts.dryRun,
    settleCi: () => watchAndFixCi(branch, pr.number, ciMaxIterations, ledger),
  });

  printSummary(ledger);
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

/**
 * Same deterministic checks as `brady ralph`, minus the open-sub-issue gate —
 * this command is pointed at finished work by definition. A dry run touches
 * nothing, so it does not need a clean tree.
 */
async function preflight(dryRun: boolean) {
  if (
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "pipe" })
      .status !== 0
  ) {
    console.error("Error: not inside a git repository.");
    process.exit(1);
  }

  await github.ensureAuth();

  if (spawnSync("claude", ["--version"], { stdio: "pipe", shell: true }).status !== 0) {
    console.error(
      "Error: `claude` CLI not found. Install Claude Code and ensure `claude` is on PATH.",
    );
    process.exit(1);
  }

  if (dryRun) return;

  const porcelain = spawnSync("git", ["status", "--porcelain"], { encoding: "utf-8" });
  if (porcelain.stdout.trim() !== "") {
    console.error(
      "Error: working tree is not clean. Fix agents commit, so commit or stash your changes first.",
    );
    process.exit(1);
  }
}

/** The checked-out branch, or "" if it cannot be read. */
function currentBranch(): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

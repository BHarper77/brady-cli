import { spawnSync } from "child_process";
import { NAMER_MODEL } from "../config";
import * as github from "../github";
import { watchAndFixCi } from "../ralph/ci";
import { Ledger, enforceBudget, printSummary, runTracked } from "../ralph/iteration";
import { reviewLoop } from "../ralph/review";
import {
  Layer,
  ensureStackExtension,
  layerBranch,
  printLayerSummary,
  warnIfNoDraftGuard,
} from "../ralph/stack";
import RALPH_PROMPT from "../ralph-prompt.md";
import RALPH_STACKED_PROMPT from "../ralph-stacked-prompt.md";

type RalphOptions = {
  maxIterations: string;
  ciMaxIterations: string;
  ci: boolean;
  review: boolean;
  reviewMaxRounds: string;
  reviewWorkflow: string;
  branch?: string;
  budget?: string;
  stacked?: boolean;
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

  if (opts.stacked) {
    ensureStackExtension();
  }

  await ralphPreflight(issue);

  const branch = opts.branch ?? (await nameBranch(issue));

  if (opts.stacked) {
    warnIfNoDraftGuard(opts.reviewWorkflow);
    const ledger: Ledger = { totalCost: 0, budget, stats: [] };
    await runStackedBuild(issue, branch, maxIterations, ledger, {
      ci: opts.ci,
      ciMaxIterations,
      review: opts.review,
      reviewMaxRounds,
      reviewWorkflow: opts.reviewWorkflow,
    });
    return;
  }

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
 * Build a stack of draft PRs, one layer per iteration. The loop owns every
 * stack operation — creating the layer, submitting the stack — the agent only
 * ever commits (see ralph-stacked-prompt.md). The stack walk (CI + review per
 * layer) is not implemented yet; the build ends by printing every layer.
 */
async function runStackedBuild(
  issue: number,
  stem: string,
  maxIterations: number,
  ledger: Ledger,
  opts: {
    ci: boolean;
    ciMaxIterations: number;
    review: boolean;
    reviewMaxRounds: number;
    reviewWorkflow: string;
  },
): Promise<void> {
  console.log(`\nralph --stacked: parent issue #${issue}, stem "${stem}" (max ${maxIterations} layers)`);

  github.stackInit();

  const layers: Layer[] = [];

  for (let i = 1; i <= maxIterations; i++) {
    const openBefore = github.listSubIssues(issue).filter((s) => s.state === "open");
    if (openBefore.length === 0) {
      console.log(`\n✓ stack build complete — no open sub-issues remain.`);
      break;
    }

    const branch = layerBranch(stem, i);
    console.log(`\n──────── layer ${i}/${maxIterations}: ${branch} ────────`);
    github.stackAddLayer(branch);

    const headBefore = currentHeadSha();
    const prompt = RALPH_STACKED_PROMPT.replaceAll("{{PARENT_ISSUE}}", String(issue));
    await runTracked(`layer ${i}`, prompt, ledger);
    const headAfter = currentHeadSha();

    if (headBefore === headAfter) {
      console.error(`\nStopping: layer ${i} (${branch}) produced no commit.`);
      github.stackSubmitDrafts();
      printLayerSummary(layers);
      printSummary(ledger);
      process.exit(1);
    }

    const openAfter = new Set(
      github.listSubIssues(issue).filter((s) => s.state === "open").map((s) => s.number),
    );
    const closed = openBefore.map((s) => s.number).find((n) => !openAfter.has(n));

    layers.push({ number: i, branch, subIssue: closed });
    enforceBudget(ledger);
  }

  github.stackSubmitDrafts();

  if (opts.ci) {
    await walkStack(layers, issue, ledger, opts);
  }

  printLayerSummary(layers);
  printSummary(ledger);
}

/**
 * Bottom-up stack walk: mark each layer ready only when we arrive at it, settle
 * its own CI, run its own review round, then submit the stack so the fixes
 * propagate to the (still-draft) layers above before moving up. A layer that
 * exhausts its CI budget is a hard stop — everything below it is already
 * reviewed and green, so aborting here is cheap, but there is no resume.
 */
async function walkStack(
  layers: Layer[],
  issue: number,
  ledger: Ledger,
  opts: {
    ciMaxIterations: number;
    review: boolean;
    reviewMaxRounds: number;
    reviewWorkflow: string;
  },
): Promise<void> {
  for (const layer of layers) {
    console.log(`\n──────── stack walk: layer ${layer.number}/${layers.length} (${layer.branch}) ────────`);

    github.markPrReady(layer.branch);
    const pr = github.getPrForBranch(layer.branch);
    if (!pr) {
      layer.status = "failed";
      console.error(`\nStopping: no PR found for layer ${layer.number} (${layer.branch}).`);
      printLayerSummary(layers);
      printSummary(ledger);
      process.exit(1);
    }
    layer.pr = pr;

    const onExhausted = (): never => {
      layer.status = "failed";
      printLayerSummary(layers);
      printSummary(ledger);
      process.exit(1);
    };

    const settleCi = () => watchAndFixCi(layer.branch, pr.number, opts.ciMaxIterations, ledger, onExhausted);
    await settleCi();

    if (opts.review) {
      await reviewLoop({
        branch: layer.branch,
        pr,
        parentIssue: issue,
        workflow: opts.reviewWorkflow,
        maxRounds: opts.reviewMaxRounds,
        ledger,
        settleCi,
        stacked: true,
      });
    }

    layer.status = "reviewed";
    // Submit so this layer's fixes rebase the (still-draft) layers above before
    // the walk marks the next one ready.
    github.stackSubmitDrafts();
  }

  const top = layers[layers.length - 1];
  if (top?.pr) {
    console.log(`\n──────── stack walk: final CI settle on top layer (${top.branch}) ────────`);
    await watchAndFixCi(top.branch, top.pr.number, opts.ciMaxIterations, ledger, () => {
      top.status = "failed";
      printLayerSummary(layers);
      printSummary(ledger);
      process.exit(1);
    });
  }
}

/** HEAD sha of the current branch, used to detect whether an iteration committed. */
function currentHeadSha(): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
}

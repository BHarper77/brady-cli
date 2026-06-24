import { spawn, spawnSync } from "child_process";
import readline from "readline";
import { NAMER_MODEL, SLICE_MODEL } from "../config";
import * as github from "../github";
import { IterationDigest, formatTokens } from "../ralph/stream";
import RALPH_PROMPT from "../ralph-prompt.md";
import RALPH_CI_PROMPT from "../ralph-ci-prompt.md";

type RalphOptions = {
  maxIterations: string;
  ciMaxIterations: string;
  ci: boolean;
  branch?: string;
  budget?: string;
};

export async function ralph(issueArg: string, opts: RalphOptions) {
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(`Error: <issue> must be a positive integer, got "${issueArg}".`);
    process.exit(1);
  }

  const maxIterations = Number(opts.maxIterations);
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    console.error(
      `Error: --max-iterations must be a positive integer, got "${opts.maxIterations}".`,
    );
    process.exit(1);
  }

  const ciMaxIterations = Number(opts.ciMaxIterations);
  if (!Number.isInteger(ciMaxIterations) || ciMaxIterations <= 0) {
    console.error(
      `Error: --ci-max-iterations must be a positive integer, got "${opts.ciMaxIterations}".`,
    );
    process.exit(1);
  }

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

  let totalCost = 0;

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n──────── iteration ${i}/${maxIterations} ────────`);
    const prompt = RALPH_PROMPT.replaceAll("{{PARENT_ISSUE}}", String(issue));
    const start = Date.now();
    const { completed, cost, tokens } = await runIteration(prompt);
    totalCost += cost;

    console.log(
      `\n[iteration ${i}: ${formatTokens(tokens)} tokens, ${formatDuration(Date.now() - start)}` +
        (cost > 0 ? `, $${cost.toFixed(4)}, total $${totalCost.toFixed(4)}` : "") +
        `]`,
    );

    if (completed) {
      console.log(`\n✓ ralph complete — no open sub-issues remain (total $${totalCost.toFixed(4)}).`);
      if (opts.ci) {
        await postRalph(branch, { ciMaxIterations, budget, totalCost });
      }
      return;
    }

    if (budget !== undefined && totalCost >= budget) {
      console.error(
        `\nStopping: budget of $${budget} reached (spent $${totalCost.toFixed(4)}).`,
      );
      process.exit(1);
    }
  }

  console.error(
    `\nStopping: hit max iterations (${maxIterations}) without completion signal.`,
  );
  process.exit(1);
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
 * After the slices are done and the PR is open: watch its CI, and dispatch a
 * fresh fix-it iteration on every failure until the checks go green. Each fix
 * agent reads the failing logs, repairs the code, and pushes; CI re-runs and we
 * watch again. Exits the process on budget or attempt exhaustion.
 */
async function postRalph(
  branch: string,
  ctx: { ciMaxIterations: number; budget?: number; totalCost: number },
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

  let totalCost = ctx.totalCost;

  for (let i = 1; i <= ctx.ciMaxIterations; i++) {
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
        `\n✓ post-ralph: CI is green on PR #${pr.number} (total $${totalCost.toFixed(4)}).`,
      );
      return;
    }

    console.log(
      `\npost-ralph: CI failing — dispatching fix iteration ${i}/${ctx.ciMaxIterations}.`,
    );

    const prompt = RALPH_CI_PROMPT.replaceAll(
      "{{PR_NUMBER}}",
      String(pr.number),
    ).replaceAll("{{BRANCH}}", branch);

    const start = Date.now();
    const { cost, tokens } = await runIteration(prompt);
    totalCost += cost;

    console.log(
      `\n[ci fix ${i}: ${formatTokens(tokens)} tokens, ${formatDuration(Date.now() - start)}` +
        (cost > 0 ? `, $${cost.toFixed(4)}, total $${totalCost.toFixed(4)}` : "") +
        `]`,
    );

    if (ctx.budget !== undefined && totalCost >= ctx.budget) {
      console.error(
        `\nStopping: budget of $${ctx.budget} reached (spent $${totalCost.toFixed(4)}).`,
      );
      process.exit(1);
    }
  }

  console.error(
    `\nStopping: CI still not green after ${ctx.ciMaxIterations} fix attempt(s).`,
  );
  process.exit(1);
}

/** Promise-based sleep. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human elapsed time, e.g. 4500 → "4.5s", 90000 → "1m 30s". */
function formatDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

/**
 * Spawn one `claude -p` iteration, stream a live digest, and watch for the
 * completion signal and accumulated cost.
 */
function runIteration(
  prompt: string,
): Promise<{ completed: boolean; cost: number; tokens: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        SLICE_MODEL,
      ],
      { shell: true },
    );

    child.stdin.write(prompt);
    child.stdin.end();

    child.stderr.pipe(process.stderr);

    const digest = new IterationDigest((chunk) => process.stdout.write(chunk));

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => digest.processLine(line));

    child.on("close", () => {
      rl.close();
      resolve({ completed: digest.completed, cost: digest.cost, tokens: digest.tokens });
    });

    child.on("error", (err) => {
      console.error(`\nError spawning claude: ${err.message}`);
      rl.close();
      resolve({ completed: digest.completed, cost: digest.cost, tokens: digest.tokens });
    });
  });
}

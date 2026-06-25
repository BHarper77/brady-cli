import { spawn, spawnSync } from "child_process";
import readline from "readline";
import { NAMER_MODEL, SLICE_MODEL } from "../config";
import * as github from "../github";
import { IterationDigest, RateLimitInfo, formatTokens } from "../ralph/stream";
import RALPH_PROMPT from "../ralph-prompt.md";
import RALPH_CI_PROMPT from "../ralph-ci-prompt.md";

type RalphOptions = {
  maxIterations: string;
  ciMaxIterations: string;
  ci: boolean;
  branch?: string;
  budget?: string;
};

/**
 * How many times we'll sleep-through a 5h reset before giving up. Resets to
 * zero whenever an iteration gets past the rate-limit check, so this only trips
 * when the window keeps reporting "rejected" right after a reset (e.g. a weekly
 * cap is the real blocker) — a guard against an unbounded wait loop.
 */
const MAX_RATE_LIMIT_WAITS = 3;

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
  let rateLimitWaits = 0;
  const summary: IterationStat[] = [];

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n──────── iteration ${i}/${maxIterations} ────────`);
    const prompt = RALPH_PROMPT.replaceAll("{{PARENT_ISSUE}}", String(issue));
    const start = Date.now();
    const { completed, cost, contextTokens, outputTokens, rateLimit } =
      await runIteration(prompt);
    totalCost += cost;
    const durationMs = Date.now() - start;
    summary.push({ label: `iteration ${i}`, contextTokens, outputTokens, durationMs, cost });

    console.log(
      `\n[iteration ${i}: ${formatTokens(contextTokens)} ctx, ${formatTokens(outputTokens)} out, ${formatDuration(durationMs)}` +
        (cost > 0 ? `, $${cost.toFixed(4)}, total $${totalCost.toFixed(4)}` : "") +
        `]`,
    );

    if (completed) {
      console.log(`\n✓ ralph complete — no open sub-issues remain (total $${totalCost.toFixed(4)}).`);
      printSummary(summary, totalCost);
      if (opts.ci) {
        await postRalph(branch, { ciMaxIterations, budget, totalCost });
      }
      return;
    }

    // Pause rather than abort when we're near/over the 5h rate limit. The
    // headless stream exposes only a status enum (no %), so we react to the
    // CLI's own "approaching"/"reached" signal, sleep until the window resets,
    // and resume the loop — so an overnight run survives the limit at a safe
    // iteration boundary instead of being killed mid-iteration (which would
    // force the half-done work to be discarded).
    if (rateLimitNearLimit(rateLimit)) {
      if (rateLimitWaits >= MAX_RATE_LIMIT_WAITS) {
        console.error(
          `\nStopping: still 5h rate-limited after ${rateLimitWaits} reset wait(s) — giving up.`,
        );
        printSummary(summary, totalCost);
        process.exit(1);
      }
      rateLimitWaits++;
      console.log(
        `\n5h rate limit ${rateLimit?.status === "rejected" ? "reached" : "approaching"} (status "${rateLimit?.status}").`,
      );
      await waitForRateLimitReset(rateLimit?.resetsAt);
      continue;
    }
    rateLimitWaits = 0;

    if (budget !== undefined && totalCost >= budget) {
      console.error(
        `\nStopping: budget of $${budget} reached (spent $${totalCost.toFixed(4)}).`,
      );
      printSummary(summary, totalCost);
      process.exit(1);
    }
  }

  console.error(
    `\nStopping: hit max iterations (${maxIterations}) without completion signal.`,
  );
  printSummary(summary, totalCost);
  process.exit(1);
}

/** Per-iteration stats collected for the end-of-run summary. */
type IterationStat = {
  label: string;
  contextTokens: number;
  outputTokens: number;
  durationMs: number;
  cost: number;
};

/** Print an aligned per-iteration table once the run is done. */
function printSummary(stats: IterationStat[], totalCost: number) {
  if (stats.length === 0) return;

  const rows = stats.map((s) => ({
    label: s.label,
    ctx: `${formatTokens(s.contextTokens)} ctx`,
    out: `${formatTokens(s.outputTokens)} out`,
    time: formatDuration(s.durationMs),
    cost: s.cost > 0 ? `$${s.cost.toFixed(4)}` : "",
  }));

  const w = (key: keyof (typeof rows)[number]) =>
    Math.max(...rows.map((r) => r[key].length));
  const wl = w("label");
  const wc = w("ctx");
  const wo = w("out");
  const wt = w("time");

  const totalMs = stats.reduce((a, s) => a + s.durationMs, 0);
  const peakCtx = Math.max(...stats.map((s) => s.contextTokens));

  console.log(`\n──────── summary (${stats.length} iteration(s)) ────────`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(wl)}  ${r.ctx.padStart(wc)}  ${r.out.padStart(wo)}  ${r.time.padStart(wt)}` +
        (r.cost ? `  ${r.cost}` : ""),
    );
  }
  console.log(
    `\npeak context ${formatTokens(peakCtx)}, total ${formatDuration(totalMs)}` +
      (totalCost > 0 ? `, $${totalCost.toFixed(4)}` : ""),
  );
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
  let rateLimitWaits = 0;

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
    const { cost, contextTokens, outputTokens, rateLimit } =
      await runIteration(prompt);
    totalCost += cost;

    console.log(
      `\n[ci fix ${i}: ${formatTokens(contextTokens)} ctx, ${formatTokens(outputTokens)} out, ${formatDuration(Date.now() - start)}` +
        (cost > 0 ? `, $${cost.toFixed(4)}, total $${totalCost.toFixed(4)}` : "") +
        `]`,
    );

    if (rateLimitNearLimit(rateLimit)) {
      if (rateLimitWaits >= MAX_RATE_LIMIT_WAITS) {
        console.error(
          `\nStopping: still 5h rate-limited after ${rateLimitWaits} reset wait(s) — giving up.`,
        );
        process.exit(1);
      }
      rateLimitWaits++;
      console.log(
        `\n5h rate limit ${rateLimit?.status === "rejected" ? "reached" : "approaching"} (status "${rateLimit?.status}").`,
      );
      await waitForRateLimitReset(rateLimit?.resetsAt);
      continue;
    }
    rateLimitWaits = 0;

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

/**
 * True once the CLI signals we're at/near the five-hour cap. The headless
 * stream carries no usage percentage, so anything past plain "allowed" — i.e.
 * "allowed_warning" or "rejected" — is treated as the stop signal.
 */
function rateLimitNearLimit(info: RateLimitInfo | undefined): boolean {
  return info?.status !== undefined && info.status !== "allowed";
}

/**
 * Sleep until the 5h window resets, then return so the loop can resume. Wakes a
 * minute past the reported reset to be safe; if the stream carried no resetsAt,
 * falls back to a full 5h wait. Logs the resume time up front and a heartbeat
 * every 15 minutes so a long pause doesn't look like a hang.
 */
async function waitForRateLimitReset(resetsAt: number | undefined): Promise<void> {
  const bufferMs = 60_000; // wake a minute past the reported reset
  const fallbackMs = 5 * 60 * 60 * 1000; // no resetsAt → assume a fresh window in 5h
  const target =
    resetsAt !== undefined ? resetsAt * 1000 + bufferMs : Date.now() + fallbackMs;
  // Never busy-spin: wait at least the buffer even if the reset already passed.
  const totalMs = Math.max(target - Date.now(), bufferMs);
  const resumeTime = Date.now() + totalMs;

  console.log(
    `Pausing for the 5h rate limit to reset — resuming ~${new Date(resumeTime).toLocaleString()} (in ${formatDuration(totalMs)}).`,
  );

  const heartbeatMs = 15 * 60 * 1000;
  let remaining = totalMs;
  while (remaining > 0) {
    await delay(Math.min(remaining, heartbeatMs));
    remaining = resumeTime - Date.now();
    if (remaining > 0) {
      console.log(`  …${formatDuration(remaining)} until ralph resumes`);
    }
  }
  console.log(`Rate-limit window reset — resuming ralph.`);
}

/** Human elapsed time, e.g. 4500 → "4.5s", 90000 → "1m 30s", 9000000 → "2h 30m". */
function formatDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const totalMin = Math.floor(secs / 60);
  if (totalMin < 60) {
    const s = Math.round(secs % 60);
    return `${totalMin}m ${s}s`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

/**
 * Spawn one `claude -p` iteration, stream a live digest, and watch for the
 * completion signal and accumulated cost.
 */
function runIteration(
  prompt: string,
): Promise<{
  completed: boolean;
  cost: number;
  contextTokens: number;
  outputTokens: number;
  rateLimit?: RateLimitInfo;
}> {
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
      resolve({
        completed: digest.completed,
        cost: digest.cost,
        contextTokens: digest.contextTokens,
        outputTokens: digest.outputTokens,
        rateLimit: digest.rateLimit,
      });
    });

    child.on("error", (err) => {
      console.error(`\nError spawning claude: ${err.message}`);
      rl.close();
      resolve({
        completed: digest.completed,
        cost: digest.cost,
        contextTokens: digest.contextTokens,
        outputTokens: digest.outputTokens,
        rateLimit: digest.rateLimit,
      });
    });
  });
}

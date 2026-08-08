// ---------------------------------------------------------------------------
// One ralph iteration: spawn a fresh `claude -p`, stream a digest, account for
// what it cost. Shared by every loop in the run (slices, CI fixes, review
// triage, review fixes) so they all sleep through rate limits and report their
// numbers the same way.
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import readline from "readline";
import { SLICE_MODEL } from "../config";
import { IterationDigest, RateLimitInfo, formatTokens } from "./stream";

/**
 * How many times we'll sleep-through a 5h reset before giving up on a single
 * iteration. Only trips when the window keeps reporting "rejected" right after
 * a reset (e.g. a weekly cap is the real blocker) — a guard against an
 * unbounded wait loop.
 */
const MAX_RATE_LIMIT_WAITS = 3;

export type IterationResult = {
  completed: boolean;
  cost: number;
  contextTokens: number;
  outputTokens: number;
  rateLimit?: RateLimitInfo;
};

/** Per-iteration stats collected for the end-of-run summary. */
export type IterationStat = {
  label: string;
  contextTokens: number;
  outputTokens: number;
  durationMs: number;
  cost: number;
};

/**
 * Running totals for a whole `brady ralph` run. Passed by reference through
 * every phase so cost and the summary table survive across the loops.
 */
export type Ledger = {
  totalCost: number;
  budget?: number;
  stats: IterationStat[];
};

/**
 * Run one iteration and fold it into the ledger. Pauses and re-dispatches the
 * same prompt when the 5h window is near/over its cap — every prompt we send is
 * self-contained, so re-running one is always safe. Exits the process if the
 * window still reports rate-limited after several resets.
 */
export async function runTracked(
  label: string,
  prompt: string,
  ledger: Ledger,
): Promise<IterationResult> {
  for (let wait = 0; wait <= MAX_RATE_LIMIT_WAITS; wait++) {
    const start = Date.now();
    const result = await runIteration(prompt);
    const durationMs = Date.now() - start;

    ledger.totalCost += result.cost;
    ledger.stats.push({
      label,
      contextTokens: result.contextTokens,
      outputTokens: result.outputTokens,
      durationMs,
      cost: result.cost,
    });

    console.log(
      `\n[${label}: ${formatTokens(result.contextTokens)} ctx, ${formatTokens(result.outputTokens)} out, ${formatDuration(durationMs)}` +
        (result.cost > 0
          ? `, $${result.cost.toFixed(4)}, total $${ledger.totalCost.toFixed(4)}`
          : "") +
        `]`,
    );

    if (!rateLimitNearLimit(result.rateLimit)) return result;
    if (wait === MAX_RATE_LIMIT_WAITS) break;

    console.log(
      `\n5h rate limit ${result.rateLimit?.status === "rejected" ? "reached" : "approaching"} (status "${result.rateLimit?.status}").`,
    );
    await waitForRateLimitReset(result.rateLimit?.resetsAt);
  }

  console.error(
    `\nStopping: still 5h rate-limited after ${MAX_RATE_LIMIT_WAITS} reset wait(s) — giving up.`,
  );
  printSummary(ledger);
  process.exit(1);
}

/** Abort the run when the ledger has crossed its ceiling. No-op without a budget. */
export function enforceBudget(ledger: Ledger) {
  if (ledger.budget !== undefined && ledger.totalCost >= ledger.budget) {
    console.error(
      `\nStopping: budget of $${ledger.budget} reached (spent $${ledger.totalCost.toFixed(4)}).`,
    );
    printSummary(ledger);
    process.exit(1);
  }
}

/** Print an aligned per-iteration table once the run is done. */
export function printSummary(ledger: Ledger) {
  const stats = ledger.stats;
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
      (ledger.totalCost > 0 ? `, $${ledger.totalCost.toFixed(4)}` : ""),
  );
}

/** Promise-based sleep. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Human elapsed time, e.g. 4500 → "4.5s", 90000 → "1m 30s", 9000000 → "2h 30m". */
export function formatDuration(ms: number): string {
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

/**
 * Spawn one `claude -p` iteration, stream a live digest, and watch for the
 * completion signal and accumulated cost.
 */
function runIteration(prompt: string): Promise<IterationResult> {
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

    const finish = () => {
      rl.close();
      resolve({
        completed: digest.completed,
        cost: digest.cost,
        contextTokens: digest.contextTokens,
        outputTokens: digest.outputTokens,
        rateLimit: digest.rateLimit,
      });
    };

    child.on("close", finish);
    child.on("error", (err) => {
      console.error(`\nError spawning claude: ${err.message}`);
      finish();
    });
  });
}

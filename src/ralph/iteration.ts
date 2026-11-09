// ---------------------------------------------------------------------------
// One ralph iteration: spawn a fresh `claude -p`, stream a digest, account for
// what it cost. Shared by every loop in the run (slices, CI fixes, review
// triage, review fixes) so they all sleep through usage limits, pick up an
// interrupted predecessor's leftovers, and report their numbers the same way.
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import readline from "readline";
import { SLICE_MODEL } from "../config";
import { isUsageLimitMessage, limitVerdict } from "./limits";
import { RunLogger } from "./log";
import { IterationDigest, RateLimitInfo, formatTokens } from "./stream";
import { withDirtyTreeNote } from "./worktree";

/**
 * How many times we'll sleep through a known reset before giving up on a
 * single iteration. Only trips when the window keeps rejecting right after a
 * reset — a guard against an unbounded wait loop.
 */
const MAX_RATE_LIMIT_WAITS = 3;
/** Retries at a fixed interval when the limit message's reset time is unreadable. */
const MAX_UNKNOWN_RESET_RETRIES = 24;
/** Gap between those retries. */
const UNKNOWN_RESET_RETRY_MS = 15 * 60 * 1000;
/** Margin past the reported reset before re-running, so we don't wake a hair early. */
const RESET_BUFFER_MS = 2 * 60 * 1000;

export type IterationResult = {
  completed: boolean;
  cost: number;
  contextTokens: number;
  outputTokens: number;
  rateLimit?: RateLimitInfo;
  /** The CLI's usage-limit notice, when the session was cut off by one. */
  limitMessage?: string;
  sessionId?: string;
  digest: string;
};

/** Per-iteration stats collected for the end-of-run summary. */
export type IterationStat = {
  label: string;
  contextTokens: number;
  outputTokens: number;
  durationMs: number;
  cost: number;
  sessionId?: string;
};

/**
 * Running totals for a whole `brady ralph` run. Passed by reference through
 * every phase so cost and the summary table survive across the loops.
 */
export type Ledger = {
  totalCost: number;
  budget?: number;
  stats: IterationStat[];
  logger?: RunLogger;
};

export type RunOptions = {
  /**
   * Prefix the prompt with a note about uncommitted leftovers in the tree, for
   * iterations that change code. Default true; triage changes none, so it
   * opts out.
   */
  dirtyTreeNote?: boolean;
};

/**
 * Run one iteration and fold it into the ledger.
 *
 * When the session is cut off by a usage limit — the CLI's "You've hit your
 * 5-hour limit · resets …" message, or a `rejected` rate-limit event — sleep
 * until the reset and re-run the *same* prompt. The caller sees one call, so no
 * iteration, CI-fix, or review counter is spent on the interrupted attempt.
 * Every prompt is self-contained, and the dirty-tree note tells the re-run
 * about whatever the cut-off attempt left uncommitted.
 *
 * When the session finished but the window is nearly spent, wait for the reset
 * before returning, so the next iteration starts on a fresh window.
 *
 * Exits the process if the limit is still hit after several resets.
 */
export async function runTracked(
  label: string,
  prompt: string,
  ledger: Ledger,
  opts: RunOptions = {},
): Promise<IterationResult> {
  let knownWaits = 0;
  let unknownWaits = 0;

  for (let attempt = 1; ; attempt++) {
    const attemptLabel = attempt === 1 ? label : `${label} (resumed)`;

    // Read the tree per attempt: the attempt before this one may be the very
    // thing that left it dirty.
    const fullPrompt = opts.dirtyTreeNote === false ? prompt : withDirtyTreeNote(prompt);
    if (fullPrompt !== prompt) {
      note(
        ledger,
        `${attemptLabel}: working tree has uncommitted changes — telling the agent to review them first.`,
      );
    }

    const start = Date.now();
    const result = await runIteration(fullPrompt);
    const durationMs = Date.now() - start;

    ledger.totalCost += result.cost;
    const stat: IterationStat = {
      label: attemptLabel,
      contextTokens: result.contextTokens,
      outputTokens: result.outputTokens,
      durationMs,
      cost: result.cost,
      sessionId: result.sessionId,
    };
    ledger.stats.push(stat);

    const statsLine =
      `[${attemptLabel}: ${formatTokens(result.contextTokens)} ctx, ${formatTokens(result.outputTokens)} out, ${formatDuration(durationMs)}` +
      (result.cost > 0
        ? `, $${result.cost.toFixed(4)}, total $${ledger.totalCost.toFixed(4)}`
        : "") +
      `]`;

    console.log(`\n${statsLine}`);
    ledger.logger?.logIteration(stat, result.digest, statsLine);

    const verdict = limitVerdict(result.limitMessage, result.rateLimit, Date.now());

    if (verdict.kind === "none") return result;

    if (verdict.kind === "warning") {
      if (verdict.resetsAt !== undefined) {
        await waitUntil(
          ledger,
          verdict.resetsAt + RESET_BUFFER_MS,
          `usage window nearly spent after ${attemptLabel} (status "${result.rateLimit?.status}")`,
          "before the next iteration",
        );
      }
      return result;
    }

    // Cut off by the limit: this attempt did not finish its work.
    const why = `usage limit hit during ${attemptLabel}${verdict.message ? ` ("${verdict.message}")` : ""}`;
    if (verdict.resetsAt !== undefined) {
      if (++knownWaits > MAX_RATE_LIMIT_WAITS) {
        giveUp(ledger, `still usage-limited after ${MAX_RATE_LIMIT_WAITS} reset wait(s)`);
      }
      await waitUntil(ledger, verdict.resetsAt + RESET_BUFFER_MS, why, `then re-running ${label}`);
    } else {
      if (++unknownWaits > MAX_UNKNOWN_RESET_RETRIES) {
        giveUp(ledger, `still usage-limited after ${MAX_UNKNOWN_RESET_RETRIES} retries`);
      }
      await waitUntil(
        ledger,
        Date.now() + UNKNOWN_RESET_RETRY_MS,
        `${why}; reset time unreadable, retrying every ${formatDuration(UNKNOWN_RESET_RETRY_MS)}`,
        `then re-running ${label}`,
      );
    }
  }
}

/** Stop the run for good on a limit that will not lift. */
function giveUp(ledger: Ledger, reason: string): never {
  console.error(`\nStopping: ${reason} — giving up.`);
  printSummary(ledger);
  ledger.logger?.writeFooter(buildSummaryTable(ledger), "rate-limit give-up");
  process.exit(1);
}


/** Abort the run when the ledger has crossed its ceiling. No-op without a budget. */
export function enforceBudget(ledger: Ledger) {
  if (ledger.budget !== undefined && ledger.totalCost >= ledger.budget) {
    console.error(
      `\nStopping: budget of $${ledger.budget} reached (spent $${ledger.totalCost.toFixed(4)}).`,
    );
    printSummary(ledger);
    ledger.logger?.writeFooter(buildSummaryTable(ledger), "budget reached");
    process.exit(1);
  }
}

/** Build the aligned per-iteration table as a single string. */
export function buildSummaryTable(ledger: Ledger): string {
  const stats = ledger.stats;
  if (stats.length === 0) return "";

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

  const lines = [`──────── summary (${stats.length} iteration(s)) ────────`];
  for (const r of rows) {
    lines.push(
      `${r.label.padEnd(wl)}  ${r.ctx.padStart(wc)}  ${r.out.padStart(wo)}  ${r.time.padStart(wt)}` +
        (r.cost ? `  ${r.cost}` : ""),
    );
  }
  lines.push(
    `\npeak context ${formatTokens(peakCtx)}, total ${formatDuration(totalMs)}` +
      (ledger.totalCost > 0 ? `, $${ledger.totalCost.toFixed(4)}` : ""),
  );
  return lines.join("\n");
}

/** Print the summary table once the run is done. */
export function printSummary(ledger: Ledger) {
  const table = buildSummaryTable(ledger);
  if (table) console.log(`\n${table}`);
}

/** Print a line of narration and mirror it into the run log, if one is attached. */
export function note(ledger: Ledger, text: string) {
  console.log(text);
  ledger.logger?.logLine(text);
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
 * Sleep until `target` (epoch ms), saying why up front — into the run log too,
 * so a long gap there is explained — with a console heartbeat every 15 minutes
 * so a long pause doesn't look like a hang.
 */
async function waitUntil(
  ledger: Ledger,
  target: number,
  why: string,
  then: string,
): Promise<void> {
  // Never busy-spin: wait at least a minute even if the target already passed.
  const totalMs = Math.max(target - Date.now(), 60_000);
  const resumeTime = Date.now() + totalMs;

  note(
    ledger,
    `\n⏸ ${why}.\n  Waiting until ${new Date(resumeTime).toLocaleString()} (${formatDuration(totalMs)}), ${then}.`,
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
  note(ledger, "▶ usage window reset — resuming.");
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

    const digest = new IterationDigest((chunk) => process.stdout.write(chunk));

    // The limit notice usually arrives in the stream, but watch stderr for it
    // too: missing it means counting a cut-off iteration as finished.
    let stderrLimit: string | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        if (isUsageLimitMessage(line)) stderrLimit = line.trim();
      }
    });

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
        limitMessage: digest.limitMessage ?? stderrLimit,
        sessionId: digest.sessionId,
        digest: digest.text,
      });
    };

    child.on("close", finish);
    child.on("error", (err) => {
      console.error(`\nError spawning claude: ${err.message}`);
      finish();
    });
  });
}

// ---------------------------------------------------------------------------
// One ralph iteration: spawn a fresh `claude -p`, stream a digest, account for
// what it cost. Shared by every loop in the run (slices, CI fixes, review
// triage, review fixes) so they all sleep through usage limits, pick up an
// interrupted predecessor's leftovers, and report their numbers the same way.
// ---------------------------------------------------------------------------

import { ChildProcess, spawn, spawnSync } from "child_process";
import readline from "readline";
import { SLICE_MODEL } from "../config";
import { isUsageLimitMessage, limitVerdict } from "./limits";
import { RunLogger } from "./log";
import { IterationDigest, RateLimitInfo, formatTokens } from "./stream";
import { withDirtyTreeNote } from "./worktree";

/** Sent to a session resumed after the usage limit that cut it off has reset. */
const RESUME_PROMPT =
  "The usage limit that interrupted you has reset. Continue the task from where you stopped. " +
  "If you are unsure what you already finished, check `git status` and `git log` first.";
/** Gap between retries when the limit's reset time is unreadable. */
const UNKNOWN_RESET_RETRY_MS = 15 * 60 * 1000;
/**
 * How long to wait for the CLI's output pipes to close after it exits. A
 * process the agent left running (a dev server, say) can inherit those pipes
 * and hold them open indefinitely, so exit, not close, ends the iteration.
 */
const EXIT_GRACE_MS = 5_000;
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
  /** Whether the session started; false when a resume found nothing to resume. */
  started: boolean;
  /** The session's final message. */
  finalResult?: string;
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
  /** Model for the session. Default `SLICE_MODEL`. */
  model?: string;
};

/**
 * Run one iteration and fold it into the ledger.
 *
 * When the session is cut off by a usage limit — the CLI's "You've hit your
 * 5-hour limit · resets …" message, or a `rejected` rate-limit event — sleep
 * until the reset and resume the *same* session (`--resume`), so the agent
 * carries on with its context. The caller sees one call, so no iteration,
 * CI-fix, or review counter is spent on the interrupted attempt. If the
 * session cannot be resumed, re-run the prompt fresh: every prompt is
 * self-contained, and the dirty-tree note tells the re-run about whatever the
 * cut-off attempt left uncommitted.
 *
 * When the session finished but the window is nearly spent, wait for the reset
 * before returning, so the next iteration starts on a fresh window.
 *
 * Never gives up on a limit: it waits out as many resets as it takes.
 */
export async function runTracked(
  label: string,
  prompt: string,
  ledger: Ledger,
  opts: RunOptions = {},
): Promise<IterationResult> {
  // The session a limit cut off, to pick up once the limit resets.
  let resumeId: string | undefined;

  for (let attempt = 1; ; attempt++) {
    const resuming = resumeId !== undefined;
    const attemptLabel =
      attempt === 1 ? label : resuming ? `${label} (resumed)` : `${label} (re-run)`;

    let fullPrompt = RESUME_PROMPT;
    if (!resuming) {
      // Read the tree per attempt: the attempt before this one may be the very
      // thing that left it dirty.
      fullPrompt = opts.dirtyTreeNote === false ? prompt : withDirtyTreeNote(prompt);
      if (fullPrompt !== prompt) {
        note(
          ledger,
          `${attemptLabel}: working tree has uncommitted changes — telling the agent to review them first.`,
        );
      }
    }

    const start = Date.now();
    const result = await runIteration(fullPrompt, opts.model ?? SLICE_MODEL, resumeId);
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

    // A resume that never started a session (expired or missing transcript)
    // falls back to a fresh run of the original prompt. No wait: the limit
    // has already reset.
    if (resuming && !result.started) {
      note(ledger, `${attemptLabel}: could not resume session ${resumeId} — re-running ${label} from scratch.`);
      resumeId = undefined;
      continue;
    }

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

    // Cut off by the limit: this attempt did not finish its work. Wait however
    // long it takes (a limit always lifts eventually), then resume the same
    // session so the agent keeps its context.
    resumeId = result.sessionId ?? resumeId;
    const then = resumeId
      ? `then resuming session ${resumeId}`
      : `then re-running ${label}`;
    const why = `usage limit hit during ${attemptLabel}${verdict.message ? ` ("${verdict.message}")` : ""}`;
    if (verdict.resetsAt !== undefined) {
      await waitUntil(ledger, verdict.resetsAt + RESET_BUFFER_MS, why, then);
    } else {
      await waitUntil(
        ledger,
        Date.now() + UNKNOWN_RESET_RETRY_MS,
        `${why}; reset time unreadable, retrying every ${formatDuration(UNKNOWN_RESET_RETRY_MS)}`,
        then,
      );
    }
  }
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


/** The `claude -p` session currently running, so a signal handler can stop it. */
let activeChild: ChildProcess | undefined;

/** Kill the running session and everything it spawned. No-op when idle. */
export function killActiveIteration() {
  if (activeChild) killTree(activeChild);
}

/**
 * Kill a process and its descendants. On Windows `child.kill()` only reaches
 * the shell wrapper, so taskkill walks the tree instead.
 */
function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * Spawn one `claude -p` iteration, stream a live digest, and watch for the
 * completion signal and accumulated cost. Stops the session as soon as it is
 * refused by a usage limit: nothing it does past that point lands, and a
 * session left waiting on background tasks could otherwise sit there.
 */
function runIteration(
  prompt: string,
  model: string,
  resumeId?: string,
): Promise<IterationResult> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      model,
    ];
    if (resumeId) args.push("--resume", resumeId);
    const child = spawn("claude", args, { shell: true });
    activeChild = child;

    child.stdin.write(prompt);
    child.stdin.end();

    const digest = new IterationDigest((chunk) => process.stdout.write(chunk));

    let stopped = false;
    const stopOnLimit = () => {
      if (stopped) return;
      stopped = true;
      console.log("\nusage limit hit — stopping this session.");
      killTree(child);
    };

    // The limit notice usually arrives in the stream, but watch stderr for it
    // too: missing it means counting a cut-off iteration as finished.
    let stderrLimit: string | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        if (isUsageLimitMessage(line)) {
          stderrLimit = line.trim();
          stopOnLimit();
        }
      }
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      digest.processLine(line);
      if (digest.limitMessage !== undefined) stopOnLimit();
    });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      rl.close();
      // Drop our end of pipes an orphaned grandchild may still hold.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        completed: digest.completed,
        cost: digest.cost,
        contextTokens: digest.contextTokens,
        outputTokens: digest.outputTokens,
        rateLimit: digest.rateLimit,
        limitMessage: digest.limitMessage ?? stderrLimit,
        finalResult: digest.finalResult,
        started: digest.started,
        sessionId: digest.sessionId,
        digest: digest.text,
      });
    };

    child.on("close", finish);
    // Exit with a grace period for the last buffered lines, in case close
    // never comes (see EXIT_GRACE_MS).
    child.on("exit", () => setTimeout(finish, EXIT_GRACE_MS));
    child.on("error", (err) => {
      console.error(`\nError spawning claude: ${err.message}`);
      finish();
    });
  });
}

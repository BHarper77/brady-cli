// ---------------------------------------------------------------------------
// The run log: one file per `brady ralph` run at
// ~/.brady/logs/ralph-<repo>-<issue>-<timestamp>.log. Appended as the run
// goes so a dying process still leaves a log. A write failure warns once and
// never kills the run.
// ---------------------------------------------------------------------------

import fs from "fs";
import os from "os";
import path from "path";
import { IterationStat } from "./iteration";

export type RunLogHeader = {
  repoPath: string;
  branch: string;
  parentIssue: number;
  cliVersion: string;
  model: string;
  flags: string;
};

/** Build the fixed, never-pruned path for a new run's log file. */
export function runLogPath(repoPath: string, parentIssue: number): string {
  const repoName = path.basename(repoPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    os.homedir(),
    ".brady",
    "logs",
    `ralph-${repoName}-${parentIssue}-${timestamp}.log`,
  );
}

/**
 * Appends sections to one run log. Every method swallows its own write
 * errors: the first failure prints a warning and disables further writes,
 * the run itself is never affected.
 */
export class RunLogger {
  private fd: number | undefined;
  private warned = false;

  constructor(private readonly filePath: string) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fd = fs.openSync(filePath, "a");
    } catch (err) {
      this.warnOnce(err);
    }
  }

  writeHeader(header: RunLogHeader) {
    this.append(
      `repo: ${header.repoPath}\n` +
        `branch: ${header.branch}\n` +
        `parent issue: #${header.parentIssue}\n` +
        `cli version: ${header.cliVersion}\n` +
        `model: ${header.model}\n` +
        `flags: ${header.flags}\n` +
        `${"=".repeat(40)}\n`,
    );
  }

  /** One section per iteration: label, session id, digest prose, stats line. */
  logIteration(stat: IterationStat, digest: string, statsLine: string) {
    this.append(
      `\n---- ${stat.label} ----\n` +
        `session: ${stat.sessionId ?? "(none)"}\n` +
        `${digest.trim()}\n` +
        `${statsLine}\n`,
    );
  }

  /** Summary table followed by the closing outcome line. Only the first call writes. */
  writeFooter(summaryTable: string, outcome: string) {
    if (this.hasFooter) return;
    this.hasFooter = true;
    this.append(`\n${summaryTable}\n\noutcome: ${outcome}\n`);
  }

  /** Whether the run's outcome has been written. */
  hasFooter = false;

  /** One line of narration outside an iteration section, e.g. CI watch or review triage status. */
  logLine(text: string) {
    this.append(`${text}\n`);
  }

  private append(text: string) {
    if (this.fd === undefined) return;
    try {
      fs.appendFileSync(this.fd, text);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private warnOnce(err: unknown) {
    if (this.warned) return;
    this.warned = true;
    this.fd = undefined;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: could not write run log at ${this.filePath}: ${message}`);
  }
}

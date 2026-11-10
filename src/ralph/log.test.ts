import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunLogger, runLogPath } from "./log";

function tmpLogPath(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "brady-log-test-")),
    "run.log",
  );
}

test("runLogPath builds the fixed, home-rooted path", () => {
  const p = runLogPath("/repos/brady-cli", 26);
  assert.match(p, /\.brady[/\\]logs[/\\]ralph-brady-cli-26-.+\.log$/);
});

test("writes header, iteration sections, and footer in order", () => {
  const filePath = tmpLogPath();
  const logger = new RunLogger(filePath);

  logger.writeHeader({
    repoPath: "/repos/brady-cli",
    branch: "feat/capture-logs",
    parentIssue: 26,
    cliVersion: "1.14.0",
    model: "claude-sonnet-5",
    flags: "--max-iterations 20",
  });

  logger.logIteration(
    { label: "iteration 1", contextTokens: 1000, outputTokens: 200, durationMs: 1500, cost: 0.1 },
    "digging into the sub-issue",
    "[iteration 1: 1.0k ctx, 200 out, 1.5s]",
  );

  logger.writeFooter("──────── summary ────────", "complete");

  const content = fs.readFileSync(filePath, "utf-8");
  const headerIdx = content.indexOf("parent issue: #26");
  const iterIdx = content.indexOf("---- iteration 1 ----");
  const digestIdx = content.indexOf("digging into the sub-issue");
  const footerIdx = content.indexOf("outcome: complete");

  assert.ok(headerIdx >= 0);
  assert.ok(iterIdx > headerIdx);
  assert.ok(digestIdx > iterIdx);
  assert.ok(footerIdx > digestIdx);
});

test("logs a CI fix iteration with its session id", () => {
  const filePath = tmpLogPath();
  const logger = new RunLogger(filePath);

  logger.logIteration(
    {
      label: "ci fix 1",
      contextTokens: 500,
      outputTokens: 50,
      durationMs: 1000,
      cost: 0.02,
      sessionId: "ci-session-abc",
    },
    "repaired the failing lint step",
    "[ci fix 1: 500 ctx, 50 out, 1.0s]",
  );

  const content = fs.readFileSync(filePath, "utf-8");
  assert.match(content, /---- ci fix 1 ----/);
  assert.match(content, /session: ci-session-abc/);
  assert.match(content, /repaired the failing lint step/);
});

test("logs a review fix iteration with its session id", () => {
  const filePath = tmpLogPath();
  const logger = new RunLogger(filePath);

  logger.logIteration(
    {
      label: "review fix 1.1",
      contextTokens: 800,
      outputTokens: 120,
      durationMs: 2000,
      cost: 0.05,
      sessionId: "review-session-xyz",
    },
    "addressed the reviewer's comment on error handling",
    "[review fix 1.1: 800 ctx, 120 out, 2.0s]",
  );

  const content = fs.readFileSync(filePath, "utf-8");
  assert.match(content, /---- review fix 1\.1 ----/);
  assert.match(content, /session: review-session-xyz/);
  assert.match(content, /addressed the reviewer's comment on error handling/);
});

test("logLine appends a bare narration line", () => {
  const filePath = tmpLogPath();
  const logger = new RunLogger(filePath);

  logger.logLine("review: waiting for claude-code-review.yml on abc1234…");

  const content = fs.readFileSync(filePath, "utf-8");
  assert.match(content, /review: waiting for claude-code-review\.yml on abc1234…/);
});

test("creates the log directory if it does not exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brady-log-test-"));
  const nested = path.join(dir, "nested", "deeper", "run.log");

  new RunLogger(nested).writeHeader({
    repoPath: "/repos/brady-cli",
    branch: "feat/x",
    parentIssue: 1,
    cliVersion: "1.0.0",
    model: "claude-sonnet-5",
    flags: "",
  });

  assert.ok(fs.existsSync(nested));
});

test("an unwritable log location warns once and does not throw", () => {
  const originalError = console.error;
  const warnings: string[] = [];
  console.error = (msg: string) => warnings.push(msg);

  try {
    // A path through a file (not a directory) can never be created.
    const blocker = tmpLogPath();
    fs.writeFileSync(blocker, "not a directory");
    const impossiblePath = path.join(blocker, "run.log");

    const logger = new RunLogger(impossiblePath);
    assert.doesNotThrow(() => {
      logger.writeHeader({
        repoPath: "/repos/brady-cli",
        branch: "feat/x",
        parentIssue: 1,
        cliVersion: "1.0.0",
        model: "claude-sonnet-5",
        flags: "",
      });
      logger.logIteration(
        { label: "iteration 1", contextTokens: 0, outputTokens: 0, durationMs: 0, cost: 0 },
        "",
        "",
      );
    });

    assert.equal(warnings.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("writeFooter only writes the first outcome", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brady-log-test-")), "run.log");
  const logger = new RunLogger(filePath);
  logger.writeFooter("table", "complete");
  logger.writeFooter("table", "exited (code 0)");
  const content = fs.readFileSync(filePath, "utf-8");
  assert.match(content, /outcome: complete/);
  assert.doesNotMatch(content, /exited/);
  assert.equal(logger.hasFooter, true);
});

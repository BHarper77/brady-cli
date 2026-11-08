import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { enforceBudget, Ledger } from "./iteration";
import { RunLogger } from "./log";

function tmpLogger(): { logger: RunLogger; filePath: string } {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "brady-iteration-test-")),
    "run.log",
  );
  return { logger: new RunLogger(filePath), filePath };
}

test("enforceBudget writes a 'budget reached' footer and exits when over budget", () => {
  const { logger, filePath } = tmpLogger();
  const ledger: Ledger = { totalCost: 5, budget: 5, stats: [], logger };

  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("exit");
  }) as typeof process.exit;

  try {
    assert.throws(() => enforceBudget(ledger));
  } finally {
    process.exit = originalExit;
  }

  assert.equal(exitCode, 1);
  const content = fs.readFileSync(filePath, "utf-8");
  assert.match(content, /outcome: budget reached/);
});

test("enforceBudget is a no-op under budget", () => {
  const { logger, filePath } = tmpLogger();
  const ledger: Ledger = { totalCost: 1, budget: 5, stats: [], logger };

  enforceBudget(ledger);

  const content = fs.readFileSync(filePath, "utf-8");
  assert.equal(content, "");
});

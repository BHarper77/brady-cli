import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmCompletion } from "./completion";
import { Ledger } from "./iteration";

function setup() {
  const lines: string[] = [];
  const ledger: Ledger = {
    totalCost: 0,
    stats: [],
    logger: { logLine: (t: string) => lines.push(t) } as unknown as Ledger["logger"],
  };
  const originalLog = console.log;
  console.log = () => {};
  return { ledger, lines, restore: () => (console.log = originalLog) };
}

test("confirms completion when every sub-issue is closed", () => {
  const { ledger, lines, restore } = setup();
  try {
    const ok = confirmCompletion(399, ledger, () => [
      { number: 1, title: "a", state: "closed" },
    ]);
    assert.equal(ok, true);
    assert.deepEqual(lines, []);
  } finally {
    restore();
  }
});

test("ignores the signal and names the open sub-issues", () => {
  const { ledger, lines, restore } = setup();
  try {
    const ok = confirmCompletion(399, ledger, () => [
      { number: 402, title: "done", state: "closed" },
      { number: 403, title: "second", state: "open" },
      { number: 404, title: "third", state: "open" },
    ]);
    assert.equal(ok, false);
    assert.match(lines[0], /IGNORED/);
    assert.match(lines[0], /#403 second/);
    assert.match(lines[0], /#404 third/);
    assert.doesNotMatch(lines[0], /#402/);
  } finally {
    restore();
  }
});

test("does not trust the signal when the check itself fails", () => {
  const { ledger, lines, restore } = setup();
  try {
    const ok = confirmCompletion(399, ledger, () => {
      throw new Error("gh: network down");
    });
    assert.equal(ok, false);
    assert.match(lines[0], /NOT trusted/);
    assert.match(lines[0], /network down/);
  } finally {
    restore();
  }
});

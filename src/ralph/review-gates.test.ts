import assert from "node:assert/strict";
import { test } from "node:test";
import { newlyReplied, parseVerdicts, partitionForResolve } from "./review-gates";

const IDS = [1, 2, 3];

test("parseVerdicts: no file fails, never defaults to valid", () => {
  const r = parseVerdicts(undefined, IDS);
  assert.equal(r.ok, false);
});

test("parseVerdicts: unparseable JSON fails", () => {
  assert.equal(parseVerdicts("{not json", IDS).ok, false);
  assert.equal(parseVerdicts("", IDS).ok, false);
});

test("parseVerdicts: JSON without a verdicts array fails", () => {
  assert.equal(parseVerdicts("{}", IDS).ok, false);
  assert.equal(parseVerdicts("null", IDS).ok, false);
  assert.equal(parseVerdicts('{"verdicts": {}}', IDS).ok, false);
});

test("parseVerdicts: full coverage parses with no missing", () => {
  const raw = JSON.stringify({
    verdicts: [
      { commentId: 1, valid: true, reason: "real", group: " g " },
      { commentId: 2, valid: false, reason: "settled" },
      { commentId: 3, valid: true, reason: "real", group: "" },
    ],
  });
  const r = parseVerdicts(raw, IDS);
  assert.ok(r.ok);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.verdicts.get(1), { valid: true, reason: "real", group: "g" });
  assert.deepEqual(r.verdicts.get(2), { valid: false, reason: "settled", group: undefined });
  assert.equal(r.verdicts.get(3)?.group, undefined);
});

test("parseVerdicts: partial coverage reports the missing ids, skips malformed and unknown entries", () => {
  const raw = JSON.stringify({
    verdicts: [
      { commentId: 1, valid: true, reason: "real" },
      { commentId: 2, reason: "no valid flag" },
      { commentId: "3", valid: true },
      { commentId: 99, valid: true, reason: "not ours" },
    ],
  });
  const r = parseVerdicts(raw, IDS);
  assert.ok(r.ok);
  assert.deepEqual(r.missing, [2, 3]);
  assert.equal(r.verdicts.has(99), false);
});

test("parseVerdicts: empty verdicts array leaves everything missing", () => {
  const r = parseVerdicts('{"verdicts": []}', IDS);
  assert.ok(r.ok);
  assert.deepEqual(r.missing, IDS);
});

test("newlyReplied: only replies not in the before snapshot count", () => {
  const before = new Map([
    [1, [100]], // triage's reply
    [2, [200]],
  ]);
  const after = new Map([
    [1, [100]], // nothing new
    [2, [200, 201]], // fix agent replied
    [3, [300]], // first reply ever
    [4, [400]], // not in this group
  ]);
  assert.deepEqual([...newlyReplied(before, after, [1, 2, 3])].sort(), [2, 3]);
});

test("partitionForResolve: no commit and no reply leaves every thread open", () => {
  const group = [{ id: 1 }, { id: 2 }];
  const r = partitionForResolve(group, false, new Set());
  assert.deepEqual(r.resolve, []);
  assert.deepEqual(r.leaveOpen, group);
});

test("partitionForResolve: a commit resolves the whole group", () => {
  const group = [{ id: 1 }, { id: 2 }];
  const r = partitionForResolve(group, true, new Set());
  assert.deepEqual(r.resolve, group);
  assert.deepEqual(r.leaveOpen, []);
});

test("partitionForResolve: without a commit, only replied threads resolve", () => {
  const r = partitionForResolve([{ id: 1 }, { id: 2 }], false, new Set([2]));
  assert.deepEqual(r.resolve, [{ id: 2 }]);
  assert.deepEqual(r.leaveOpen, [{ id: 1 }]);
});

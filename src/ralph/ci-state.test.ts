import assert from "node:assert/strict";
import { test } from "node:test";
import { ciState } from "./ci-state";

const check = (name: string, bucket: string, workflow = "CI") => ({ name, bucket, workflow });

test("ciState: no checks → none", () => {
  assert.equal(ciState([]), "none");
});

test("ciState: any red check fails fast, even with others pending", () => {
  assert.equal(ciState([check("a", "pending"), check("b", "fail")]), "failing");
  assert.equal(ciState([check("a", "pass"), check("b", "cancel")]), "failing");
});

test("ciState: pending until every check settles; skipped counts as settled", () => {
  assert.equal(ciState([check("a", "pass"), check("b", "pending")]), "pending");
  assert.equal(ciState([check("a", "pass"), check("b", "skipping")]), "passing");
});

test("ciState: the review workflow's checks are not CI", () => {
  const checks = [check("Frontend", "pass"), check("claude-review", "fail", "Claude Code Review")];
  assert.equal(ciState(checks), "failing");
  assert.equal(ciState(checks, "Claude Code Review"), "passing");
  assert.equal(ciState([check("claude-review", "pending", "Claude Code Review")], "Claude Code Review"), "none");
});

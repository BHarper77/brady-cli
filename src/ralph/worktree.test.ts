import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatDirtyTreeNote, readDirtyTree, withDirtyTreeNote } from "./worktree";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
}

/** A throwaway repo with one commit, standing in for the target repo. */
function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brady-worktree-test-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("clean tree: prompt passes through untouched", () => {
  const dir = tmpRepo();
  assert.equal(readDirtyTree(dir), undefined);
  assert.equal(withDirtyTreeNote("PROMPT", dir), "PROMPT");
});

test("dirty tree: note lists the diff stat and untracked files, then the prompt", () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "new.ts"), "x\n");

  const out = withDirtyTreeNote("PROMPT", dir);
  assert.match(out, /previous iteration was interrupted/);
  assert.match(out, /a\.txt \| 1 \+/);
  assert.match(out, /- `new\.ts`/);
  assert.ok(out.endsWith("PROMPT"));
  assert.ok(out.indexOf("a.txt") < out.indexOf("PROMPT"));
});

test("staged-only changes still count as dirty", () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  git(dir, "add", "a.txt");
  assert.match(readDirtyTree(dir)?.diffStat ?? "", /a\.txt/);
});

test("reads the given repo, not the process's own cwd", () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, "only-here.txt"), "x\n");
  assert.deepEqual(readDirtyTree(dir)?.untracked, ["only-here.txt"]);
});

test("not a repo: no note", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brady-worktree-norepo-"));
  assert.equal(withDirtyTreeNote("PROMPT", dir), "PROMPT");
});

test("long untracked lists are capped", () => {
  const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
  const note = formatDirtyTreeNote("", files);
  assert.match(note, /- `f39\.ts`/);
  assert.doesNotMatch(note, /- `f40\.ts`/);
  assert.match(note, /and 10 more/);
});

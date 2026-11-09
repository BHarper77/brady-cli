// ---------------------------------------------------------------------------
// Leftovers from an interrupted iteration. An agent killed mid-run (usage
// limit, crash) leaves its uncommitted work in the target repo's tree; the next
// fresh agent knows nothing of it unless told. Always run against the repo
// ralph was started in (`process.cwd()` by default) — never brady-cli's own.
// ---------------------------------------------------------------------------

import { spawnSync } from "child_process";

/** Most untracked paths to list before summarising the rest as a count. */
const MAX_UNTRACKED = 40;

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  return result.status === 0 ? result.stdout : undefined;
}

/** The tree's uncommitted state, or undefined when it is clean (or not a repo). */
export function readDirtyTree(
  cwd: string,
): { diffStat: string; untracked: string[] } | undefined {
  const porcelain = git(cwd, ["status", "--porcelain"]);
  if (porcelain === undefined || porcelain.trim() === "") return undefined;

  // Against HEAD so staged and unstaged changes both show; a repo with no
  // commits yet has no HEAD, so fall back to the unstaged diff.
  const diffStat = (git(cwd, ["diff", "--stat", "HEAD"]) ?? git(cwd, ["diff", "--stat"]) ?? "").trim();
  const untracked = (git(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (diffStat === "" && untracked.length === 0) return undefined;
  return { diffStat, untracked };
}

/** The prompt note describing a dirty tree. */
export function formatDirtyTreeNote(diffStat: string, untracked: string[]): string {
  const lines = [
    "## First: the working tree has uncommitted changes",
    "",
    "A previous iteration was interrupted (usage limit, crash) before it committed, and left this work behind:",
    "",
  ];
  if (diffStat) lines.push("```", diffStat, "```", "");
  if (untracked.length > 0) {
    lines.push("Untracked files:", "");
    for (const file of untracked.slice(0, MAX_UNTRACKED)) lines.push(`- \`${file}\``);
    if (untracked.length > MAX_UNTRACKED) {
      lines.push(`- …and ${untracked.length - MAX_UNTRACKED} more`);
    }
    lines.push("");
  }
  lines.push(
    "Before anything else, review it (`git status`, `git diff`). If it is work towards the task below, verify it, finish it and commit it, then carry on. If it is unrelated or broken, say so and decide deliberately; do not discard it blindly.",
    "",
    "---",
    "",
  );
  return lines.join("\n");
}

/** `prompt`, prefixed with the dirty-tree note when `cwd`'s tree is dirty. */
export function withDirtyTreeNote(prompt: string, cwd: string = process.cwd()): string {
  const dirty = readDirtyTree(cwd);
  return dirty ? formatDirtyTreeNote(dirty.diffStat, dirty.untracked) + prompt : prompt;
}

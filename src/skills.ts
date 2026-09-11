// ---------------------------------------------------------------------------
// Where a skill lives on disk, and the preflight that insists it does. The
// review loops delegate their judgement to skills rather than carrying their own
// prompts, so a missing skill is a missing half of the loop — worth catching
// before the first iteration spends anything, not twenty minutes in when the
// review phase finally reaches for it.
// ---------------------------------------------------------------------------

import fs from "fs";
import os from "os";
import path from "path";
import { SKILL_DESTINATIONS } from "./config";

/** Directories `claude` resolves a skill name against, nearest first. */
function searchRoots(): string[] {
  return [
    ...SKILL_DESTINATIONS.map((dest) => path.join(process.cwd(), dest.path)),
    path.join(os.homedir(), ".claude", "skills"),
  ];
}

/**
 * Absolute path to a skill's SKILL.md, or undefined when no search root holds
 * it. A directory without a SKILL.md does not count: that is what a half-failed
 * download leaves behind, and `claude` cannot enter it either.
 */
export function findSkill(name: string): string | undefined {
  for (const root of searchRoots()) {
    const file = path.join(root, name, "SKILL.md");
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Exit unless every named skill is installed. `purpose` says what needs them,
 * so the error explains why the run is stopping rather than only what is absent.
 */
export function requireSkills(names: string[], purpose: string) {
  const missing = names.filter((name) => findSkill(name) === undefined);
  if (missing.length === 0) return;

  console.error(
    `Error: ${purpose} ${missing.length === 1 ? "needs a skill that is" : "needs skills that are"} not installed here: ${missing.join(", ")}.`,
  );
  console.error(
    `\nInstall ${missing.length === 1 ? "it" : "them"} with:\n` +
      missing.map((name) => `  brady skills add ${name}`).join("\n"),
  );
  // Project roots read better relative, the home one only as itself.
  console.error(
    `\nSearched: ${searchRoots()
      .map((root) => {
        const rel = path.relative(process.cwd(), root);
        return rel && !rel.startsWith("..") ? rel : root;
      })
      .join(", ")}.`,
  );
  process.exit(1);
}

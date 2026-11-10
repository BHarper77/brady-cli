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

/** A skill read off disk: where it lives, and its instructions minus frontmatter. */
export type LoadedSkill = { name: string; file: string; dir: string; body: string };

/** Drop a leading `---` YAML frontmatter block, if any, and trim. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
}

/**
 * Read a skill's instructions so the loop can embed them in a prompt. The
 * review skills set `disable-model-invocation`, which makes the `Skill` tool
 * refuse them from a headless agent, so the loop hands the agent the body
 * itself instead. Undefined when the skill is missing, unreadable, or has no
 * body past its frontmatter.
 */
export function loadSkill(name: string): LoadedSkill | undefined {
  const file = findSkill(name);
  if (!file) return undefined;
  let body: string;
  try {
    body = stripFrontmatter(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  if (body === "") return undefined;
  return { name, file, dir: path.dirname(file), body };
}

/**
 * Exit unless every named skill is installed with a readable, non-empty body —
 * the loop embeds that body in its prompts, so an empty SKILL.md is as fatal as
 * a missing one. `purpose` says what needs them, so the error explains why the
 * run is stopping rather than only what is absent.
 */
export function requireSkills(names: string[], purpose: string) {
  const missing = names.filter((name) => loadSkill(name) === undefined);
  if (missing.length === 0) return;

  console.error(
    `Error: ${purpose} ${missing.length === 1 ? "needs a skill that is" : "needs skills that are"} missing or empty here: ${missing.join(", ")}.`,
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

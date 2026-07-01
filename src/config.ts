// ---------------------------------------------------------------------------
// Fixed facts about the dotfiles repo, skill layout, and per-role models.
// ---------------------------------------------------------------------------

export const DOTFILES_OWNER = "bharper77";
export const DOTFILES_REPO = "dotfiles";

/** Path inside the dotfiles repo where skills are read from and pushed to. Fixed. */
export const REMOTE_SKILLS_PATH = ".agents/skills";

/** Local destinations a skill can be downloaded into / pushed from. First entry is listed first. */
export const SKILL_DESTINATIONS = [
  { label: ".claude/skills", path: ".claude/skills" },
  { label: ".agents/skills", path: ".agents/skills" },
] as const;

/** Cheap model for the one-shot branch namer. */
export const NAMER_MODEL = "claude-haiku-4-5-20251001";

/** Model for the ralph implementation slice loop. */
export const SLICE_MODEL = "claude-sonnet-5";

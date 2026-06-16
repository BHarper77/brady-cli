# brady-cli

A personal CLI for scaffolding TypeScript projects and managing agent skills sourced from a personal dotfiles repository.

## Language

**Skill**:
A named, self-contained bundle of files (a directory) that teaches an agent a capability. Stored remotely in the dotfiles repo and downloaded into a project locally.

**Dotfiles repo**:
The remote source of truth (`bharper77/dotfiles`) where canonical skills live under `.agents/skills/`. This remote layout is fixed and does not change.
_Avoid_: "upstream" when ambiguous.

**Remote skills path**:
The path inside the dotfiles repo where skills are read from and pushed to. Always `.agents/skills/`.

**Local skills destination**:
The directory in the current project where a downloaded skill is written. Historically `.agents/skills/`; now chosen at download time from a fixed pick-list (`.claude/skills/` listed first, then `.agents/skills/`). The user is always prompted for this — in both the interactive picker and the direct `add <name>` path. The list is driven by a single shared constant so both `add` and `push` read the same options. No semantic default is set (no `initialValue`), consistent with the existing skills multiselect. The directory prompt always comes last — after the skill(s) are determined (multiselect → directory in `add`; the skill arg is already known in `push`).

## Relationships

- A **Skill** is read from the **Remote skills path** and written to the **Local skills destination**
- The **Remote skills path** and **Local skills destination** are independent — changing one does not change the other
- `push` resolves the **Local skills destination** by auto-detection: it checks both known destinations, uses the one present, and only prompts when the skill exists in both

## Flagged ambiguities

- `SKILLS_PATH` originally meant both the remote source and the local destination. Resolved: these are distinct concepts — **Remote skills path** (fixed, `.agents/skills`) vs **Local skills destination** (selectable).

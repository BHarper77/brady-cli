# Plan: brady-cli revival + skills commands

## Context

- Repo: `c:\Users\brady\Documents\Repositories\brady-cli`
- dotfiles repo: `bharper77/dotfiles` (private), skills at `.agents/skills/{skill-name}/` (folders with SKILL.md + other md files)
- Skills land in: `.agents/skills/` relative to cwd
- GitHub access: `gh api` (gh CLI). Pre-flight: run `gh auth status` before any api call; on failure, throw actionable error "Run `gh auth login` to authenticate, then retry." Offer to spawn `gh auth login` inline if not authed.
- TUI library: `@clack/prompts`
- Windows-only CLI (exec uses powershell.exe)
- Current structure: single `src/index.ts` file with `init` command

## Key Technical Decisions

- gh api for fetching: `gh api repos/bharper77/dotfiles/contents/.agents/skills`
- Files are base64-encoded in GitHub API response → decode with `Buffer.from(content, "base64")`
- Commander subcommand nesting: `program.command("skills")` → `.addCommand(listCmd)` + `.addCommand(addCmd)`
- `brady skills add [skill]` — optional positional arg: if present download directly, else show @clack/prompts multiselect
- Add `"brady": "node dist/index.js"` script to package.json for `pnpm brady skills list` local dev invocation
- Move `@changesets/cli` from dependencies → devDependencies

## Plan

### Phase 1: Dependencies & Tooling

1. Update package.json: bump all deps to latest, add @clack/prompts (prod), move @changesets/cli to devDeps, add packageManager field
2. Install deps with pnpm (user runs this)

### Phase 2: Skills Commands in src/index.ts

3. Add skills parent command, list subcommand, add subcommand
4. Helper: fetchGhJson(apiPath) — runs `gh api {path}` via execSync, returns parsed JSON
5. Helper: downloadSkill(skillName) — fetches file list for `.agents/skills/{skillName}`, decodes base64 content, writes files to `.agents/skills/{skillName}/` relative to process.cwd()
6. ensureGhAuth() — runs `gh auth status`; on failure, uses @clack/prompts to ask if user wants to run `gh auth login` now; if yes, spawns it interactively; if no, exits with actionable error message
7. listSkills() — calls ensureGhAuth(), fetches skill dirs, prints each skill name
8. addSkill(skill?) — calls ensureGhAuth(); if skill arg provided: downloadSkill directly; else fetch list, @clack/prompts multiselect (space = toggle, enter = confirm), downloadSkill for each selected

### Phase 3: README

9. Create README.md covering: installation, commands (brady init, brady skills list, brady skills add, brady skills add <name>), local dev workflow, changeset releasing workflow

## Dependency updates

- Update all existing deps to latest at implementation time (check npm registry)
- Note: `@commander-js/extra-typings` must match the major version of `commander`
- Move `@changesets/cli` from dependencies → devDependencies
- NEW: `@clack/prompts` (prod dep, latest)

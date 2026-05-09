# brady-cli

Personal CLI for project scaffolding and agent skill management.

## Installation

```sh
npm install -g brady-cli
# or
pnpm add -g brady-cli
```

Requires [GitHub CLI](https://cli.github.com/) (`gh`) to be installed and authenticated for skills commands.

## Commands

### `brady init`

Scaffold a new TypeScript Node.js project.

```sh
brady init -d my-project
```

| Option                        | Description                        |
| ----------------------------- | ---------------------------------- |
| `-d, --directory <directory>` | Directory name for the new project |

---

### `brady skills list`

List all available skills from the dotfiles repo.

```sh
brady skills list
```

Prints each skill name fetched from `bharper77/dotfiles` → `.agents/skills/`.

---

### `brady skills add`

Interactively select and download one or more skills into `.agents/skills/` relative to your current working directory.

```sh
brady skills add
```

Use **space** to toggle skills and **enter** to confirm your selection.

---

### `brady skills add <name>`

Download a specific skill directly without the interactive picker.

```sh
brady skills add my-skill
```

---

## Local Dev Workflow

```sh
# Install dependencies
pnpm install

# Build
pnpm run build

# Run locally (after build)
pnpm brady skills list
pnpm brady init -d my-project
```

## Releasing

This package uses [semantic-release](https://github.com/semantic-release/semantic-release) for fully automated versioning and publishing based on [Conventional Commits](https://www.conventionalcommits.org/).

### How it works

Merging to `main` triggers the Publish workflow, which:

1. Analyzes commits since the last release to determine the semver bump (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE` → major)
2. Updates `CHANGELOG.md` and bumps the version in `package.json`
3. Publishes to npm via `pnpm publish`
4. Commits the updated files back and creates a GitHub release

**No manual steps are needed.** Just write commits using Conventional Commit messages:

| Commit prefix                            | Version bump |
| ---------------------------------------- | ------------ |
| `fix:`                                   | patch        |
| `feat:`                                  | minor        |
| `feat!:` or `BREAKING CHANGE:` in footer | major        |

### Your workflow

1. **Make changes** using Conventional Commit messages, e.g.:

   ```sh
   git commit -m "feat: add new scaffold template"
   git commit -m "fix: correct output path for init command"
   ```

2. **Push to a branch and open a PR.** The Build workflow runs typecheck + build on every push.

3. **Merge to `main`.** semantic-release automatically determines the version, publishes to npm, and creates a GitHub release.

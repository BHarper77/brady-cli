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

This package uses [Changesets](https://github.com/changesets/changesets) for versioning. Publishing is fully automated via CI — you only need one local step.

### Your workflow

1. **Make your changes**, then run:

   ```sh
   pnpm changeset
   ```

   Follow the prompts to select a bump type (`patch` / `minor` / `major`) and describe what changed. This creates a `.changeset/*.md` file — commit it with your changes.

2. **Push to a branch and open a PR.** The Build workflow runs typecheck + build on every push.

3. **Merge to `main`.** The Publish workflow runs and the changesets bot automatically opens a **"Version Packages"** PR that bumps the version and updates `CHANGELOG.md`.

4. **Merge the "Version Packages" PR.** CI runs again and changesets publishes the new version to npm automatically.

> **Nothing else is needed locally.** `changeset version` and `changeset publish` are handled entirely by the `changesets/action` in `.github/workflows/publish.yml`.

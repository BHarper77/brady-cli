#!/usr/bin/env node

import * as p from "@clack/prompts";
import { execSync, spawnSync } from "child_process";
import { Command } from "commander";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import path from "path";

const DOTFILES_OWNER = "bharper77";
const DOTFILES_REPO = "dotfiles";
const SKILLS_PATH = ".agents/skills";

const program = new Command();

program
  .command("init")
  .option("-d, --directory <directory>", "Directory name for project")
  .action(init);

const skillsCmd = new Command("skills").description(
  "Manage agent skills from dotfiles",
);

skillsCmd.addCommand(
  new Command("list")
    .description("List available skills from dotfiles")
    .action(listSkills),
);

skillsCmd.addCommand(
  new Command("add")
    .description("Download one or more skills into .agents/skills/")
    .argument(
      "[skill]",
      "Skill name to download directly (omit for interactive picker)",
    )
    .action(addSkill),
);

skillsCmd.addCommand(
  new Command("push")
    .description("Push a local skill back to the dotfiles repo")
    .argument("<skill>", "Skill name to push")
    .option("--pr", "Create a pull request instead of pushing directly to main")
    .action(pushSkill),
);

program.addCommand(skillsCmd);

program.parseAsync(process.argv);

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

async function init(opts: Options) {
  // project dir
  exec(`mkdir ${opts.directory}`);
  exec("mkdir src", opts.directory);
  exec("new-item index.ts", `${opts.directory}/src`);

  // initialise git repo
  exec("git init", opts.directory);
  exec("echo 'node_modules' 'dist' > .gitignore", opts.directory);

  // initialise Node project
  exec("npm init -y", opts.directory);

  const packageJson = JSON.parse(
    (await readFile(`${opts.directory}/package.json`)).toString(),
  );
  packageJson.scripts = {
    start: "node src/index.js",
    build: "tsc",
  };

  await writeFile(
    `${opts.directory}/package.json`,
    JSON.stringify(packageJson, null, 2),
  );

  const devDependencies = [
    "typescript",
    "@types/node",
    "@total-typescript/ts-reset",
    "eslint",
    "@bharper7/eslint-config",
    "@typescript-eslint/eslint-plugin",
    "eslint-plugin-import",
  ].join(" ");
  exec(`npm i -D ${devDependencies}`, opts.directory);
  exec("tsc --init", opts.directory);

  exec("echo 'node_modules' 'dist' > .eslintignore", opts.directory);
}

// ---------------------------------------------------------------------------
// skills commands
// ---------------------------------------------------------------------------

async function listSkills() {
  await ensureGhAuth();

  const entries = fetchGhJson<GhContentEntry[]>(
    `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}`,
  );
  const skills = entries.filter((e) => e.type === "dir").map((e) => e.name);

  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  console.log("Available skills:");
  for (const skill of skills) {
    console.log(`  • ${skill}`);
  }
}

async function addSkill(skill?: string) {
  await ensureGhAuth();

  if (skill) {
    await downloadSkill(skill);
  } else {
    const entries = fetchGhJson<GhContentEntry[]>(
      `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}`,
    );
    const skills = entries.filter((e) => e.type === "dir").map((e) => e.name);

    if (skills.length === 0) {
      console.log("No skills available.");
      return;
    }

    p.intro("brady skills add");

    const selected = await p.multiselect<string>({
      message: "Select skills to download (space = toggle, enter = confirm):",
      options: skills.map((s) => ({ value: s, label: s })),
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    const chosen = selected as string[];
    for (const s of chosen) {
      await downloadSkill(s);
    }

    p.outro(`Downloaded ${chosen.length} skill(s).`);
  }
}

async function pushSkill(skill: string, options: { pr?: boolean }) {
  await ensureGhAuth();

  const localSkillDir = path.join(process.cwd(), SKILLS_PATH, skill);

  let dirEntries: Awaited<ReturnType<typeof readdir<true>>>;
  try {
    dirEntries = await readdir(localSkillDir, { withFileTypes: true });
  } catch {
    console.error(
      `Error: Skill "${skill}" not found locally. Run \`brady skills add ${skill}\` first.`,
    );
    process.exit(1);
  }

  const files = dirEntries.filter((e) => e.isFile()).map((e) => e.name);
  if (files.length === 0) {
    console.error(`Error: No files found in skill "${skill}".`);
    process.exit(1);
  }

  let targetBranch = "main";

  if (options.pr) {
    p.intro("brady skills push");

    const branchInput = await p.text({
      message: "Branch name for the pull request:",
      placeholder: `brady/skill-push-${skill}`,
      validate: (v) => (!v.trim() ? "Branch name is required." : undefined),
    });

    if (p.isCancel(branchInput)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    targetBranch = branchInput as string;

    const mainRef = fetchGhJson<GhRef>(
      `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/git/refs/heads/main`,
    );

    try {
      execSync(
        `gh api --method POST repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/git/refs --input -`,
        {
          input: JSON.stringify({
            ref: `refs/heads/${targetBranch}`,
            sha: mainRef.object.sha,
          }),
          encoding: "utf-8",
        },
      );
    } catch {
      console.error(
        `Error: Branch "${targetBranch}" already exists or could not be created.`,
      );
      process.exit(1);
    }
  }

  for (const filename of files) {
    const localContent = await readFile(
      path.join(localSkillDir, filename),
      "utf-8",
    );
    const base64Content = Buffer.from(localContent, "utf-8").toString("base64");
    const apiPath = `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}/${skill}/${filename}`;

    let sha: string | undefined;
    try {
      const existing = fetchGhJson<GhFileEntry>(apiPath);
      sha = existing.sha;
    } catch {
      // File does not exist upstream — will be created
    }

    const body: Record<string, string> = {
      message: `chore: update skill ${skill}`,
      content: base64Content,
      branch: targetBranch,
    };
    if (sha !== undefined) {
      body.sha = sha;
    }

    try {
      execSync(`gh api --method PUT ${apiPath} --input -`, {
        input: JSON.stringify(body),
        encoding: "utf-8",
      });
    } catch {
      console.error(
        `Error: Failed to push "${filename}". The file may have been modified upstream.`,
      );
      process.exit(1);
    }

    console.log(`  ✓ ${filename}`);
  }

  if (options.pr) {
    const prUrl = execSync(
      `gh pr create --repo ${DOTFILES_OWNER}/${DOTFILES_REPO} --head ${targetBranch} --base main --title "chore: update skill ${skill}" --body ""`,
      { encoding: "utf-8", shell: "powershell.exe" },
    ).trim();
    p.outro(`Pull request created: ${prUrl}`);
  } else {
    console.log(`✓ Pushed skill: ${skill}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureGhAuth() {
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch {
    p.intro("GitHub authentication required");
    const answer = await p.confirm({
      message:
        "You are not authenticated with GitHub CLI. Run `gh auth login` now?",
    });

    if (p.isCancel(answer) || !answer) {
      console.error(
        "Error: Not authenticated. Run `gh auth login` to authenticate, then retry.",
      );
      process.exit(1);
    }

    const result = spawnSync("gh", ["auth", "login"], {
      stdio: "inherit",
      shell: "powershell.exe",
    });
    if (result.status !== 0) {
      console.error(
        "Authentication failed. Run `gh auth login` to authenticate, then retry.",
      );
      process.exit(1);
    }
  }
}

function fetchGhJson<T>(apiPath: string): T {
  const output = execSync(`gh api ${apiPath}`, { encoding: "utf-8" });
  return JSON.parse(output) as T;
}

async function downloadSkill(skillName: string) {
  const apiPath = `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}/${skillName}`;
  const files = fetchGhJson<GhContentEntry[]>(apiPath);

  const destDir = path.join(process.cwd(), SKILLS_PATH, skillName);
  await mkdir(destDir, { recursive: true });

  for (const file of files) {
    if (file.type !== "file") continue;
    const fileEntry = fetchGhJson<GhFileEntry>(
      `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}/${skillName}/${file.name}`,
    );
    const content = Buffer.from(fileEntry.content, "base64").toString("utf-8");
    await writeFile(path.join(destDir, file.name), content, "utf-8");
  }

  console.log(`✓ Downloaded skill: ${skillName}`);
}

function exec(command: string, cwd?: string) {
  return execSync(command, {
    cwd,
    shell: "powershell.exe",
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Options = {
  directory: string;
};

type GhContentEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
  path: string;
};

type GhFileEntry = GhContentEntry & {
  content: string;
  encoding: string;
  sha: string;
};

type GhRef = {
  object: { sha: string };
};

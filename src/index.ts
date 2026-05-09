#!/usr/bin/env node

import * as p from "@clack/prompts";
import { execSync, spawnSync } from "child_process";
import { Command } from "commander";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import eslintConfigTemplate from "./eslintConfig.json";

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

  // eslint
  await writeFile(
    `${opts.directory}/.eslintrc.json`,
    JSON.stringify(eslintConfigTemplate),
  );
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
};

#!/usr/bin/env node

import * as p from "@clack/prompts";
import { execSync, spawn, spawnSync } from "child_process";
import { Command } from "commander";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import path from "path";
import readline from "readline";
import RALPH_PROMPT from "./ralph-prompt.md";

const DOTFILES_OWNER = "bharper77";
const DOTFILES_REPO = "dotfiles";

/** Path inside the dotfiles repo where skills are read from and pushed to. Fixed. */
const REMOTE_SKILLS_PATH = ".agents/skills";

/** Local destinations a skill can be downloaded into / pushed from. First entry is listed first. */
const SKILL_DESTINATIONS = [
  { label: ".claude/skills", path: ".claude/skills" },
  { label: ".agents/skills", path: ".agents/skills" },
] as const;

/** Cheap model for the one-shot branch namer. */
const NAMER_MODEL = "claude-haiku-4-5-20251001";

/** Model for the ralph implementation slice loop. */
const SLICE_MODEL = "claude-sonnet-4-6";

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
    .description("Download one or more skills into a chosen local skills directory")
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

program
  .command("ralph")
  .description(
    "Autonomously work a parent issue's sub-issues with a fresh claude -p per iteration",
  )
  .argument("<issue>", "Parent issue number")
  .option("--max-iterations <n>", "Maximum loop iterations", "20")
  .option("-b, --branch <name>", "Use this exact branch name (skip the namer)")
  .option("--budget <usd>", "Optional cost ceiling in USD (off by default)")
  .action(ralph);

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
    `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${REMOTE_SKILLS_PATH}`,
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
    p.intro("brady skills add");
    const destination = await promptDestination();
    await downloadSkill(skill, destination);
    p.outro(`Downloaded skill: ${skill}`);
  } else {
    const entries = fetchGhJson<GhContentEntry[]>(
      `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${REMOTE_SKILLS_PATH}`,
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

    const destination = await promptDestination();

    const chosen = selected as string[];
    for (const s of chosen) {
      await downloadSkill(s, destination);
    }

    p.outro(`Downloaded ${chosen.length} skill(s) into ${destination}/.`);
  }
}

/**
 * Find which local skills directory holds a skill. Uses the only directory that
 * contains it; prompts when more than one does; exits when none do.
 * Returns the absolute path to the local skill directory.
 */
async function resolveSkillSource(skill: string): Promise<string> {
  const present: { label: string; dir: string }[] = [];

  for (const dest of SKILL_DESTINATIONS) {
    const dir = path.join(process.cwd(), dest.path, skill);
    const isDir = await stat(dir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (isDir) {
      present.push({ label: dest.path, dir });
    }
  }

  if (present.length === 0) {
    console.error(
      `Error: Skill "${skill}" not found locally. Run \`brady skills add ${skill}\` first.`,
    );
    process.exit(1);
  }

  if (present.length === 1) {
    return present[0]!.dir;
  }

  const choice = await p.select<string>({
    message: `Skill "${skill}" exists in multiple directories. Which one?`,
    options: present.map((d) => ({ value: d.dir, label: d.label })),
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return choice as string;
}

/** Prompt for which local skills directory to use. Exits on cancel. */
async function promptDestination(): Promise<string> {
  const choice = await p.select<string>({
    message: "Which directory?",
    options: SKILL_DESTINATIONS.map((d) => ({ value: d.path, label: d.label })),
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return choice as string;
}

async function pushSkill(skill: string, options: { pr?: boolean }) {
  await ensureGhAuth();

  const localSkillDir = await resolveSkillSource(skill);

  const dirEntries = await readdir(localSkillDir, {
    withFileTypes: true,
  }).catch(() => {
    console.error(
      `Error: Skill "${skill}" not found locally. Run \`brady skills add ${skill}\` first.`,
    );
    process.exit(1);
  });

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
      validate: (v) => (!v?.trim() ? "Branch name is required." : undefined),
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
    const apiPath = `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${REMOTE_SKILLS_PATH}/${skill}/${filename}`;

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
// ralph command
// ---------------------------------------------------------------------------

type RalphOptions = {
  maxIterations: string;
  branch?: string;
  budget?: string;
};

async function ralph(issueArg: string, opts: RalphOptions) {
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(`Error: <issue> must be a positive integer, got "${issueArg}".`);
    process.exit(1);
  }

  const maxIterations = Number(opts.maxIterations);
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    console.error(
      `Error: --max-iterations must be a positive integer, got "${opts.maxIterations}".`,
    );
    process.exit(1);
  }

  let budget: number | undefined;
  if (opts.budget !== undefined) {
    budget = Number(opts.budget);
    if (!Number.isFinite(budget) || budget <= 0) {
      console.error(`Error: --budget must be a positive number, got "${opts.budget}".`);
      process.exit(1);
    }
  }

  await ralphPreflight(issue);

  const branch = opts.branch ?? (await nameBranch(issue));
  checkoutBranch(branch);

  console.log(
    `\nralph: parent issue #${issue} on branch "${branch}" (max ${maxIterations} iterations${
      budget !== undefined ? `, budget $${budget}` : ""
    })`,
  );
  console.log(
    "Billing: under a Pro/Max subscription this draws down rate limits (no per-token bill).\n" +
      "If ANTHROPIC_API_KEY is set it wins and bills per-token — use --budget to cap that path.\n",
  );

  let totalCost = 0;

  for (let i = 1; i <= maxIterations; i++) {
    console.log(`\n──────── iteration ${i}/${maxIterations} ────────`);
    const prompt = RALPH_PROMPT.replaceAll("{{PARENT_ISSUE}}", String(issue));
    const { completed, cost } = await runIteration(prompt);
    totalCost += cost;

    if (cost > 0) {
      console.log(
        `\n[iteration ${i}: $${cost.toFixed(4)}, total $${totalCost.toFixed(4)}]`,
      );
    }

    if (completed) {
      console.log(`\n✓ ralph complete — no open sub-issues remain (total $${totalCost.toFixed(4)}).`);
      return;
    }

    if (budget !== undefined && totalCost >= budget) {
      console.error(
        `\nStopping: budget of $${budget} reached (spent $${totalCost.toFixed(4)}).`,
      );
      process.exit(1);
    }
  }

  console.error(
    `\nStopping: hit max iterations (${maxIterations}) without completion signal.`,
  );
  process.exit(1);
}

/** Deterministic preflight. Fails fast via console.error + exit(1). */
async function ralphPreflight(issue: number) {
  // 1. Inside a git repo.
  if (
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "pipe" })
      .status !== 0
  ) {
    console.error("Error: not inside a git repository.");
    process.exit(1);
  }

  // 2. gh authed (reuses the shared helper; prompts to log in if needed).
  await ensureGhAuth();

  // 3. claude binary present.
  if (
    spawnSync("claude", ["--version"], { stdio: "pipe", shell: true }).status !==
    0
  ) {
    console.error(
      "Error: `claude` CLI not found. Install Claude Code and ensure `claude` is on PATH.",
    );
    process.exit(1);
  }

  // 4. Clean working tree (hard abort — no bypass in v1).
  const porcelain = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf-8",
  });
  if (porcelain.stdout.trim() !== "") {
    console.error(
      "Error: working tree is not clean. Commit or stash your changes before running ralph.",
    );
    process.exit(1);
  }

  // 5. Parent issue exists and has open sub-issues.
  let subIssues: { state: string }[];
  try {
    subIssues = fetchGhJson<{ state: string }[]>(
      `repos/{owner}/{repo}/issues/${issue}/sub_issues`,
    );
  } catch {
    console.error(
      `Error: issue #${issue} not found, or it has no sub-issues. Nothing to do.`,
    );
    process.exit(1);
  }

  const open = subIssues.filter((s) => s.state === "open");
  if (open.length === 0) {
    console.error(
      `Nothing to do: issue #${issue} has no open sub-issues.`,
    );
    process.exit(1);
  }

  console.log(`Found ${open.length} open sub-issue(s) under #${issue}.`);
}

/** One-shot Haiku call that names a feat/<kebab> branch. Falls back to a slug. */
async function nameBranch(issue: number): Promise<string> {
  let title = "";
  try {
    title = execSync(`gh issue view ${issue} --json title -q .title`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    // Fall through to the (empty-title) fallback slug.
  }

  const namerPrompt =
    "Suggest a git branch name for this GitHub issue. " +
    "Respond with ONLY the branch name and nothing else. " +
    "Format must be feat/<kebab-case>, at most about four words. " +
    `Issue title: "${title}"`;

  const result = spawnSync("claude", ["-p", "--model", NAMER_MODEL], {
    input: namerPrompt,
    encoding: "utf-8",
    shell: true,
  });

  const candidate = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";

  if (/^feat\/[a-z0-9-]+$/.test(candidate)) {
    return candidate;
  }

  return fallbackBranch(title, issue);
}

/** Deterministic branch name when the namer output is unusable. */
function fallbackBranch(title: string, issue: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");

  return slug ? `feat/${slug}` : `feat/issue-${issue}`;
}

/** Create the branch, or check it out if it already exists (handles re-runs). */
function checkoutBranch(branch: string) {
  if (!/^feat\/[a-z0-9-]+$/.test(branch)) {
    console.error(
      `Error: branch "${branch}" must match feat/<kebab-case>.`,
    );
    process.exit(1);
  }

  const exists =
    spawnSync("git", ["rev-parse", "--verify", branch], { stdio: "pipe" })
      .status === 0;

  const args = exists ? ["checkout", branch] : ["checkout", "-b", branch];
  const result = spawnSync("git", args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Error: failed to checkout branch "${branch}".`);
    process.exit(1);
  }
}

/**
 * Spawn one `claude -p` iteration, stream a live digest, and watch for the
 * completion signal and accumulated cost.
 */
function runIteration(
  prompt: string,
): Promise<{ completed: boolean; cost: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        SLICE_MODEL,
      ],
      { shell: true },
    );

    child.stdin.write(prompt);
    child.stdin.end();

    child.stderr.pipe(process.stderr);

    let completed = false;
    let cost = 0;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let evt: StreamEvent;
      try {
        evt = JSON.parse(trimmed) as StreamEvent;
      } catch {
        return;
      }

      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            process.stdout.write(block.text);
            if (block.text.includes(COMPLETION_SIGNAL)) completed = true;
          } else if (block.type === "tool_use") {
            process.stdout.write(`\n  → ${block.name ?? "tool"}\n`);
          }
        }
      }

      if (evt.type === "result") {
        if (typeof evt.total_cost_usd === "number") cost = evt.total_cost_usd;
        if (
          typeof evt.result === "string" &&
          evt.result.includes(COMPLETION_SIGNAL)
        ) {
          completed = true;
        }
      }
    });

    child.on("close", () => {
      rl.close();
      resolve({ completed, cost });
    });

    child.on("error", (err) => {
      console.error(`\nError spawning claude: ${err.message}`);
      rl.close();
      resolve({ completed, cost });
    });
  });
}

const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

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

async function downloadSkill(skillName: string, destination: string) {
  const apiPath = `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${REMOTE_SKILLS_PATH}/${skillName}`;
  const files = fetchGhJson<GhContentEntry[]>(apiPath);

  const destDir = path.join(process.cwd(), destination, skillName);
  await mkdir(destDir, { recursive: true });

  for (const file of files) {
    if (file.type !== "file") continue;
    const fileEntry = fetchGhJson<GhFileEntry>(
      `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${REMOTE_SKILLS_PATH}/${skillName}/${file.name}`,
    );
    const content = Buffer.from(fileEntry.content, "base64").toString("utf-8");
    await writeFile(path.join(destDir, file.name), content, "utf-8");
  }

  console.log(`✓ Downloaded skill: ${skillName} → ${destination}/`);
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

type StreamEvent = {
  type: string;
  message?: {
    content?: {
      type: string;
      text?: string;
      name?: string;
    }[];
  };
  total_cost_usd?: number;
  result?: string;
};

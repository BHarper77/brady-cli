import * as p from "@clack/prompts";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import path from "path";
import { SKILL_DESTINATIONS } from "../config";
import * as github from "../github";
import { promptOrExit } from "../shell";

export async function listSkills() {
  await github.ensureAuth();

  const skills = github.listSkillNames();

  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  console.log("Available skills:");
  for (const skill of skills) {
    console.log(`  • ${skill}`);
  }
}

export async function addSkill(skill?: string) {
  await github.ensureAuth();

  if (skill) {
    p.intro("brady skills add");
    const destination = await promptDestination();
    await downloadSkill(skill, destination);
    p.outro(`Downloaded skill: ${skill}`);
    return;
  }

  const skills = github.listSkillNames();

  if (skills.length === 0) {
    console.log("No skills available.");
    return;
  }

  p.intro("brady skills add");

  const selected = promptOrExit(
    await p.multiselect<string>({
      message: "Select skills to download (space = toggle, enter = confirm):",
      options: skills.map((s) => ({ value: s, label: s })),
      required: true,
    }),
  );

  const destination = await promptDestination();

  for (const s of selected) {
    await downloadSkill(s, destination);
  }

  p.outro(`Downloaded ${selected.length} skill(s) into ${destination}/.`);
}

export async function pushSkill(skill: string, options: { pr?: boolean }) {
  await github.ensureAuth();

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

    const branchInput = promptOrExit(
      await p.text({
        message: "Branch name for the pull request:",
        placeholder: `brady/skill-push-${skill}`,
        validate: (v) => (!v?.trim() ? "Branch name is required." : undefined),
      }),
    );

    targetBranch = branchInput;

    try {
      github.createBranch(targetBranch);
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
    const sha = github.getSkillFileSha(skill, filename);

    try {
      github.putSkillFile({
        skill,
        filename,
        content: localContent,
        branch: targetBranch,
        sha,
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
    const prUrl = github.createSkillPr(skill, targetBranch);
    p.outro(`Pull request created: ${prUrl}`);
  } else {
    console.log(`✓ Pushed skill: ${skill}`);
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

  return promptOrExit(
    await p.select<string>({
      message: `Skill "${skill}" exists in multiple directories. Which one?`,
      options: present.map((d) => ({ value: d.dir, label: d.label })),
    }),
  );
}

/** Prompt for which local skills directory to use. Exits on cancel. */
async function promptDestination(): Promise<string> {
  return promptOrExit(
    await p.select<string>({
      message: "Which directory?",
      options: SKILL_DESTINATIONS.map((d) => ({ value: d.path, label: d.label })),
    }),
  );
}

async function downloadSkill(skillName: string, destination: string) {
  const files = github.listSkillFiles(skillName);

  const destDir = path.join(process.cwd(), destination, skillName);
  await mkdir(destDir, { recursive: true });

  for (const filename of files) {
    const content = github.readSkillFile(skillName, filename);
    await writeFile(path.join(destDir, filename), content, "utf-8");
  }

  console.log(`✓ Downloaded skill: ${skillName} → ${destination}/`);
}

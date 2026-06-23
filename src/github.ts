import * as p from "@clack/prompts";
import { execSync, spawnSync } from "child_process";
import { DOTFILES_OWNER, DOTFILES_REPO, REMOTE_SKILLS_PATH } from "./config";

// ---------------------------------------------------------------------------
// The single place that knows the `gh` CLI exists. Everything above this seam
// talks in terms of skills, issues, and branches — never API paths, base64,
// or sha-before-PUT.
// ---------------------------------------------------------------------------

/** GitHub `gh api` contents entry. Private wire shape. */
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

/** Read a `gh api` endpoint and parse it as JSON. */
function ghApiJson<T>(apiPath: string): T {
  const output = execSync(`gh api ${apiPath}`, { encoding: "utf-8" });
  return JSON.parse(output) as T;
}

/** Write to a `gh api` endpoint with a JSON body on stdin. */
function ghApiWrite(method: "POST" | "PUT", apiPath: string, body: unknown) {
  execSync(`gh api --method ${method} ${apiPath} --input -`, {
    input: JSON.stringify(body),
    encoding: "utf-8",
  });
}

const dotfilesContents = (subPath: string) =>
  `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${REMOTE_SKILLS_PATH}/${subPath}`;

/**
 * Ensure the `gh` CLI is authenticated, prompting an interactive login when it
 * is not. Exits the process if the user declines or login fails.
 */
export async function ensureAuth() {
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

// --- Skills in the dotfiles repo -------------------------------------------

/** Directory names under the remote skills path — the available skills. */
export function listSkillNames(): string[] {
  const entries = ghApiJson<GhContentEntry[]>(dotfilesContents(""));
  return entries.filter((e) => e.type === "dir").map((e) => e.name);
}

/** File names inside a remote skill directory. */
export function listSkillFiles(skill: string): string[] {
  const entries = ghApiJson<GhContentEntry[]>(dotfilesContents(skill));
  return entries.filter((e) => e.type === "file").map((e) => e.name);
}

/** Decoded UTF-8 contents of a single remote skill file. */
export function readSkillFile(skill: string, filename: string): string {
  const entry = ghApiJson<GhFileEntry>(dotfilesContents(`${skill}/${filename}`));
  return Buffer.from(entry.content, "base64").toString("utf-8");
}

/** The sha of an existing remote skill file, or undefined if it does not exist. */
export function getSkillFileSha(
  skill: string,
  filename: string,
): string | undefined {
  try {
    return ghApiJson<GhFileEntry>(dotfilesContents(`${skill}/${filename}`)).sha;
  } catch {
    return undefined;
  }
}

/**
 * Create or update a remote skill file on the given branch. Pass the current
 * sha when overwriting an existing file (omit to create). Throws on failure.
 */
export function putSkillFile(args: {
  skill: string;
  filename: string;
  content: string;
  branch: string;
  sha?: string;
}) {
  const body: Record<string, string> = {
    message: `chore: update skill ${args.skill}`,
    content: Buffer.from(args.content, "utf-8").toString("base64"),
    branch: args.branch,
  };
  if (args.sha !== undefined) {
    body.sha = args.sha;
  }
  ghApiWrite("PUT", dotfilesContents(`${args.skill}/${args.filename}`), body);
}

/** Branch off the dotfiles repo's `main`. Throws if the branch already exists. */
export function createBranch(branch: string) {
  const mainRef = ghApiJson<GhRef>(
    `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/git/refs/heads/main`,
  );
  ghApiWrite("POST", `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: mainRef.object.sha,
  });
}

/** Open a PR for a skill update on the dotfiles repo. Returns the PR URL. */
export function createSkillPr(skill: string, branch: string): string {
  return execSync(
    `gh pr create --repo ${DOTFILES_OWNER}/${DOTFILES_REPO} --head ${branch} --base main --title "chore: update skill ${skill}" --body ""`,
    { encoding: "utf-8", shell: "powershell.exe" },
  ).trim();
}

// --- Issues in the current repo --------------------------------------------

/** Open + closed sub-issues of a parent issue in the current repo. */
export function listSubIssues(issue: number): { state: string }[] {
  return ghApiJson<{ state: string }[]>(
    `repos/{owner}/{repo}/issues/${issue}/sub_issues`,
  );
}

/** Title of an issue in the current repo, or "" if it cannot be read. */
export function getIssueTitle(issue: number): string {
  try {
    return execSync(`gh issue view ${issue} --json title -q .title`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

// --- Pull requests + CI in the current repo --------------------------------

/** The open PR for a branch, or undefined if none exists. */
export function getPrForBranch(
  branch: string,
): { number: number; url: string } | undefined {
  try {
    const output = execSync(`gh pr view ${branch} --json number,url`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return JSON.parse(output) as { number: number; url: string };
  } catch {
    return undefined;
  }
}

/** Whether the PR for a branch has any CI checks reported at all. */
function hasAnyChecks(branch: string): boolean {
  try {
    const output = execSync(
      `gh pr view ${branch} --json statusCheckRollup -q ".statusCheckRollup | length"`,
      { encoding: "utf-8", stdio: "pipe" },
    );
    return Number(output.trim()) > 0;
  } catch {
    return false;
  }
}

/**
 * Block until the branch's CI checks finish, streaming gh's live table, then
 * report the verdict: "passing" when every check is green, "none" when the PR
 * has no checks configured, "failing" otherwise.
 */
export function watchCiChecks(branch: string): "passing" | "failing" | "none" {
  const result = spawnSync(
    "gh",
    ["pr", "checks", branch, "--watch", "--fail-fast"],
    { stdio: "inherit", shell: "powershell.exe" },
  );

  if (result.status === 0) return "passing";
  if (!hasAnyChecks(branch)) return "none";
  return "failing";
}

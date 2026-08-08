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

/** The sha currently at the head of a branch's PR, or undefined if unreadable. */
export function getPrHeadSha(branch: string): string | undefined {
  try {
    return execSync(`gh pr view ${branch} --json headRefOid -q .headRefOid`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
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

// --- Automated PR reviews ---------------------------------------------------
//
// The review is posted by a GitHub Actions workflow as a *native* PR review:
// a body plus line-anchored review comments. Everything here is scoped to one
// head sha, so a review left on an earlier push is never mistaken for the
// review of the code we just pushed.

/** A workflow run's state, as far as the review wait cares. */
export type WorkflowRunState =
  | { status: "missing" }
  | { status: "running" }
  | { status: "completed"; conclusion: string };

type GhRun = {
  headSha: string;
  status: string;
  conclusion: string;
  databaseId: number;
};

/**
 * State of the most recent run of `workflow` against `sha`. "missing" covers
 * both "not queued yet" and "this repo has no such workflow" — the caller
 * distinguishes them by how long it has been waiting.
 */
export function getWorkflowRunForSha(
  workflow: string,
  sha: string,
): WorkflowRunState {
  let runs: GhRun[];
  try {
    const output = execSync(
      `gh run list --workflow ${workflow} --limit 30 --json headSha,status,conclusion,databaseId`,
      { encoding: "utf-8", stdio: "pipe" },
    );
    runs = JSON.parse(output) as GhRun[];
  } catch {
    return { status: "missing" };
  }

  // gh lists newest first, so the first match is the latest attempt for the sha.
  const run = runs.find((r) => r.headSha === sha);
  if (!run) return { status: "missing" };
  if (run.status !== "completed") return { status: "running" };
  return { status: "completed", conclusion: run.conclusion };
}

/** A submitted PR review. */
export type PrReview = {
  id: number;
  body: string;
  state: string;
  commitId: string;
  author: string;
};

/** A line-anchored comment belonging to a review. */
export type PrReviewComment = {
  id: number;
  reviewId: number;
  path: string;
  line: number | null;
  body: string;
  url: string;
};

type GhReview = {
  id: number;
  body: string;
  state: string;
  commit_id: string;
  user: { login: string } | null;
};

type GhReviewComment = {
  id: number;
  pull_request_review_id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
  html_url: string;
  in_reply_to_id?: number | null;
};

/**
 * Reviews submitted against exactly `sha`. Excludes reviews with no substance
 * (an approval carrying no body and no comments still shows up here, but the
 * caller drops it once it sees zero comments).
 */
export function listReviewsForSha(pr: number, sha: string): PrReview[] {
  const reviews = ghApiJson<GhReview[]>(
    `repos/{owner}/{repo}/pulls/${pr}/reviews --paginate`,
  );
  return reviews
    .filter((r) => r.commit_id === sha && r.state !== "PENDING")
    .map((r) => ({
      id: r.id,
      body: r.body ?? "",
      state: r.state,
      commitId: r.commit_id,
      author: r.user?.login ?? "",
    }));
}

/**
 * Top-level review comments belonging to any of `reviewIds`. Replies (comments
 * with `in_reply_to_id`) are dropped — a thread's reply is our own answer from
 * a previous round, not a finding to triage.
 */
export function listReviewComments(
  pr: number,
  reviewIds: number[],
): PrReviewComment[] {
  const comments = ghApiJson<GhReviewComment[]>(
    `repos/{owner}/{repo}/pulls/${pr}/comments --paginate`,
  );
  const wanted = new Set(reviewIds);
  return comments
    // `in_reply_to_id` is absent on some payloads and explicitly null on others,
    // so test for both rather than for `undefined`.
    .filter(
      (c) => wanted.has(c.pull_request_review_id) && c.in_reply_to_id == null,
    )
    .map((c) => ({
      id: c.id,
      reviewId: c.pull_request_review_id,
      path: c.path,
      // A comment whose line has since shifted out of the diff reports a null
      // `line`; `original_line` still points at where it was written.
      line: c.line ?? c.original_line,
      body: c.body,
      url: c.html_url,
    }));
}

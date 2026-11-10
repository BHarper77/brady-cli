// ---------------------------------------------------------------------------
// Opening the run's PR once every slice is committed. The loop owns the push
// and the `gh pr create`; a cheap agent only drafts the title and body.
// ---------------------------------------------------------------------------

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PR_MODEL } from "../config";
import * as github from "../github";
import RALPH_PR_PROMPT from "../ralph-pr-prompt.md";
import { Ledger, note, runTracked } from "./iteration";
import { PrDraft, parsePrDraft } from "./pr-draft";

/** Title and body to use when the agent's draft is unusable. */
function fallbackDraft(parentIssue: number, base: string): PrDraft {
  const title = github.getIssueTitle(parentIssue) || `Parent issue #${parentIssue}`;
  const log = spawnSync("git", ["log", "--reverse", "--format=- %s", `origin/${base}..HEAD`], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  const commits = log.status === 0 ? log.stdout.trim() : "";
  return {
    title,
    body: `${commits ? `${commits}\n\n` : ""}Closes #${parentIssue}`,
  };
}

/**
 * Push the branch and open its PR, or reuse the one already open (a re-run).
 * Returns undefined when the push or the PR creation fails.
 */
export async function pushAndOpenPr(
  branch: string,
  parentIssue: number,
  ledger: Ledger,
): Promise<{ number: number; url: string } | undefined> {
  note(ledger, `\npr: pushing ${branch}.`);
  const push = spawnSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
  if (push.status !== 0) {
    note(ledger, `pr: failed to push ${branch}.`);
    return undefined;
  }

  const existing = github.getPrForBranch(branch);
  if (existing) {
    note(ledger, `pr: #${existing.number} is already open — pushed to it. ${existing.url}`);
    return existing;
  }

  let base: string;
  try {
    base = github.getDefaultBranch();
  } catch {
    note(ledger, "pr: could not read the repo's default branch.");
    return undefined;
  }

  const prompt = RALPH_PR_PROMPT.replaceAll("{{BRANCH}}", branch)
    .replaceAll("{{BASE}}", base)
    .replaceAll("{{PARENT_ISSUE}}", String(parentIssue));
  const result = await runTracked("pr body", prompt, ledger, {
    model: PR_MODEL,
    dirtyTreeNote: false,
  });

  let draft = parsePrDraft(result.finalResult ?? result.digest, parentIssue);
  if (!draft) {
    note(ledger, "pr: the agent's draft was unusable — falling back to the issue title and commit list.");
    draft = fallbackDraft(parentIssue, base);
  }

  const bodyFile = path.join(os.tmpdir(), `ralph-pr-body-${process.pid}.md`);
  try {
    fs.writeFileSync(bodyFile, draft.body);
    const url = github.createPr({ head: branch, base, title: draft.title, bodyFile });
    note(ledger, `pr: opened ${url}`);
  } catch (err) {
    note(ledger, `pr: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }

  return github.getPrForBranch(branch);
}

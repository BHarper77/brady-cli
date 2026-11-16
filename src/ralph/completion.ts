// ---------------------------------------------------------------------------
// The completion signal is the agent's claim, not proof: a forked subagent can
// echo the token while sub-issues remain open. Before the loop pushes and opens
// a PR, GitHub gets the final say.
// ---------------------------------------------------------------------------

import * as github from "../github";
import { Ledger, note } from "./iteration";

type SubIssue = { number: number; title: string; state: string };

/**
 * Double-check a completion signal against the parent issue's sub-issues.
 * True only when GitHub confirms none are open.
 *
 * Open sub-issues: the signal is ignored, logged with the ones remaining, and
 * the loop carries on. If GitHub cannot be read the signal is also not trusted
 * (the loop never opens a PR on unverified work), and the loop carries on; the
 * next signal gets checked again, and --max-iterations bounds the retries.
 */
export function confirmCompletion(
  issue: number,
  ledger: Ledger,
  list: (issue: number) => SubIssue[] = github.listSubIssues,
): boolean {
  let subIssues: SubIssue[];
  try {
    subIssues = list(issue);
  } catch (error) {
    note(
      ledger,
      `completion signal NOT trusted: could not read sub-issues of #${issue} to verify it (${String(error).split("\n")[0]}). Carrying on with the next iteration.`,
    );
    return false;
  }

  const open = subIssues.filter((s) => s.state === "open");
  if (open.length === 0) return true;

  note(
    ledger,
    `completion signal IGNORED: ${open.length} sub-issue(s) of #${issue} still open: ${open
      .map((s) => `#${s.number} ${s.title}`)
      .join("; ")}. Carrying on with the next iteration.`,
  );
  return false;
}

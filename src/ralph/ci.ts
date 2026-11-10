// ---------------------------------------------------------------------------
// Getting a branch's CI green. Shared by post-ralph (after the slices land) and
// by the review loop (after a round pushes its fixes) — both need the same
// watch, the same fix agent, and the same attempt cap.
// ---------------------------------------------------------------------------

import * as github from "../github";
import RALPH_CI_PROMPT from "../ralph-ci-prompt.md";
import { CiState, ciState, isCiCheck } from "./ci-state";
import {
  Ledger,
  buildSummaryTable,
  delay,
  enforceBudget,
  note,
  printSummary,
  runTracked,
} from "./iteration";

/** Gap between polls of the PR's checks. */
const POLL_INTERVAL_MS = 20_000;
/** How long to wait for a fresh push to report any checks before calling it "none". */
const CHECKS_APPEAR_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Watch the branch's CI, dispatching a fresh fix-it iteration on every failure
 * until the checks go green. Each fix agent reads the failing logs, repairs the
 * code, and pushes; CI re-runs and we watch again. Exits the process if the
 * checks are still red after `maxAttempts` tries.
 *
 * `reviewWorkflow` is the automated review's workflow file; its checks are
 * not counted as CI.
 */
export async function watchAndFixCi(
  branch: string,
  pr: number,
  maxAttempts: number,
  ledger: Ledger,
  reviewWorkflow?: string,
): Promise<void> {
  const reviewName = reviewWorkflow ? github.getWorkflowName(reviewWorkflow) : undefined;

  for (let i = 1; i <= maxAttempts; i++) {
    const verdict = await waitForChecks(branch, reviewName);

    if (verdict === "none") {
      note(ledger, "\nci: no CI checks configured — nothing to verify.");
      return;
    }

    if (verdict === "passing") {
      note(
        ledger,
        `\n✓ ci: green on PR #${pr} (total $${ledger.totalCost.toFixed(4)}).`,
      );
      return;
    }

    note(ledger, `\nci: failing — dispatching fix iteration ${i}/${maxAttempts}.`);

    const prompt = RALPH_CI_PROMPT.replaceAll("{{PR_NUMBER}}", String(pr))
      .replaceAll("{{BRANCH}}", branch)
      .replaceAll("{{REVIEW_WORKFLOW}}", reviewName ?? reviewWorkflow ?? "automated review");

    await runTracked(`ci fix ${i}`, prompt, ledger);
    enforceBudget(ledger);
  }

  console.error(`\nStopping: CI still not green after ${maxAttempts} fix attempt(s).`);
  printSummary(ledger);
  ledger.logger?.writeFooter(buildSummaryTable(ledger), "ci still failing");
  process.exit(1);
}

/** Poll the PR's checks until CI settles, printing progress as it changes. */
async function waitForChecks(
  branch: string,
  reviewName: string | undefined,
): Promise<Exclude<CiState, "pending">> {
  // Give a freshly-pushed commit a moment to register its workflow runs so the
  // watch latches onto the new checks rather than the stale ones.
  await delay(10_000);

  const start = Date.now();
  let lastProgress = "";

  for (;;) {
    const checks = github.listPrChecks(branch);
    const state = ciState(checks, reviewName);

    if (state === "passing" || state === "failing") {
      if (state === "failing") {
        const red = checks
          .filter((c) => isCiCheck(c, reviewName) && (c.bucket === "fail" || c.bucket === "cancel"))
          .map((c) => c.name);
        console.log(`ci: failing — ${red.join(", ")}`);
      }
      return state;
    }

    if (state === "none" && Date.now() - start > CHECKS_APPEAR_TIMEOUT_MS) return "none";

    if (state === "pending") {
      const waiting = checks
        .filter((c) => isCiCheck(c, reviewName) && c.bucket === "pending")
        .map((c) => c.name);
      const progress = `ci: waiting on ${waiting.join(", ")}`;
      if (progress !== lastProgress) console.log(progress);
      lastProgress = progress;
    }

    await delay(POLL_INTERVAL_MS);
  }
}

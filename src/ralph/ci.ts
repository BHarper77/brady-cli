// ---------------------------------------------------------------------------
// Getting a branch's CI green. Shared by post-ralph (after the slices land) and
// by the review loop (after a round pushes its fixes) — both need the same
// watch, the same fix agent, and the same attempt cap.
// ---------------------------------------------------------------------------

import * as github from "../github";
import RALPH_CI_PROMPT from "../ralph-ci-prompt.md";
import { Ledger, delay, enforceBudget, printSummary, runTracked } from "./iteration";

/**
 * Watch the branch's CI, dispatching a fresh fix-it iteration on every failure
 * until the checks go green. Each fix agent reads the failing logs, repairs the
 * code, and pushes; CI re-runs and we watch again. Exits the process if the
 * checks are still red after `maxAttempts` tries.
 */
export async function watchAndFixCi(
  branch: string,
  pr: number,
  maxAttempts: number,
  ledger: Ledger,
): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    // Give a freshly-pushed commit a moment to register its workflow run so
    // the watch latches onto the new checks rather than the stale ones.
    await delay(10_000);

    const verdict = github.watchCiChecks(branch);

    if (verdict === "none") {
      console.log("\nci: no CI checks configured — nothing to verify.");
      return;
    }

    if (verdict === "passing") {
      console.log(
        `\n✓ ci: green on PR #${pr} (total $${ledger.totalCost.toFixed(4)}).`,
      );
      return;
    }

    console.log(`\nci: failing — dispatching fix iteration ${i}/${maxAttempts}.`);

    const prompt = RALPH_CI_PROMPT.replaceAll("{{PR_NUMBER}}", String(pr)).replaceAll(
      "{{BRANCH}}",
      branch,
    );

    await runTracked(`ci fix ${i}`, prompt, ledger);
    enforceBudget(ledger);
  }

  console.error(`\nStopping: CI still not green after ${maxAttempts} fix attempt(s).`);
  printSummary(ledger);
  process.exit(1);
}

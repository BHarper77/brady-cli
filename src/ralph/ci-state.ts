// ---------------------------------------------------------------------------
// Pure verdict over a PR's checks, apart from ci.ts so it can be tested
// without loading the prompt.
// ---------------------------------------------------------------------------

import type { PrCheck } from "../github";

export type CiState = "passing" | "failing" | "pending" | "none";

/** Whether a check counts as CI, i.e. is not from the automated review's workflow. */
export function isCiCheck(check: PrCheck, ignoreWorkflow?: string): boolean {
  return ignoreWorkflow === undefined || check.workflow !== ignoreWorkflow;
}

/**
 * Where a PR's CI stands. Checks from `ignoreWorkflow` (the automated review)
 * are left out: the review is not CI, and the review loop handles it. Fails
 * fast — one red check is enough, without waiting on the rest.
 */
export function ciState(checks: PrCheck[], ignoreWorkflow?: string): CiState {
  const ci = checks.filter((c) => isCiCheck(c, ignoreWorkflow));
  if (ci.length === 0) return "none";
  if (ci.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "failing";
  if (ci.some((c) => c.bucket === "pending")) return "pending";
  return "passing";
}

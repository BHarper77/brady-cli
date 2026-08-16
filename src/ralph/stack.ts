// ---------------------------------------------------------------------------
// `--stacked` build phase: one layer branch + draft PR per loop iteration,
// each layered on the one below. The loop owns every stack operation; the
// agent only ever commits (see ralph-stacked-prompt.md).
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import * as github from "../github";

export type Layer = {
  number: number;
  branch: string;
  subIssue?: number;
  pr?: { number: number; url: string };
  /** Walk status: absent/"draft" until the walk reaches it, "reviewed" once it clears its round, "failed" if it exhausted its CI budget. */
  status?: "draft" | "reviewed" | "failed";
};

/** Fails fast, before the branch namer spends a call, if the extension is missing. */
export function ensureStackExtension() {
  if (!github.hasGhStackExtension()) {
    console.error(
      "Error: the `gh stack` extension is not installed. Run `gh extension install github/gh-stack` before using --stacked.",
    );
    process.exit(1);
  }
}

/** Warns but proceeds when the review workflow has no draft guard. */
export function warnIfNoDraftGuard(workflowFile: string) {
  const path = `.github/workflows/${workflowFile}`;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    console.warn(
      `Warning: could not read "${path}" to check for a draft guard on the review job — ` +
        "if it lacks one, each layer's PR may be reviewed more than once during the build.",
    );
    return;
  }

  if (!/draft\s*==\s*false/.test(content)) {
    console.warn(
      `Warning: "${path}" has no draft guard (e.g. "if: github.event.pull_request.draft == false") on its review job. ` +
        "--stacked pushes every layer as a draft during the build, so without a guard each layer may be reviewed more than once.",
    );
  }
}

/** Layer branch name, numbered off the stem: <stem>-01, <stem>-02, ... */
export function layerBranch(stem: string, layer: number): string {
  return `${stem}-${String(layer).padStart(2, "0")}`;
}

/** Print every layer built so far — its number, sub-issue, and branch. Used on success and abort alike. */
export function printLayerSummary(layers: Layer[]) {
  if (layers.length === 0) {
    console.log("\nNo layers were built.");
    return;
  }

  console.log(`\n──────── stack summary (${layers.length} layer(s)) ────────`);
  for (const layer of layers) {
    const sub = layer.subIssue !== undefined ? `sub-issue #${layer.subIssue}` : "sub-issue unknown";
    const status = layer.status ?? "draft";
    const pr = layer.pr ? ` — ${layer.pr.url}` : "";
    console.log(`  layer ${layer.number}: ${layer.branch} — ${sub} — ${status}${pr}`);
  }
}

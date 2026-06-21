# Drive the ralph loop with Claude Code headless (`claude -p`)

`brady ralph <issue>` runs an autonomous loop over a parent issue's native GitHub sub-issues. Each iteration spawns a fresh `claude -p` process that picks one open sub-issue, implements it, commits, and closes it; the loop stops when the agent emits `<promise>COMPLETE</promise>` or a max-iterations cap is hit. We drive that loop with **Claude Code headless** (`claude -p --output-format stream-json --verbose --dangerously-skip-permissions`), reimplemented in TypeScript rather than shelling out to the reference `ralph.ps1`.

## Status

accepted

## Context

The reference implementation (`folio` repo, `ai/ralph.ps1`) drives **GitHub Copilot CLI** (`copilot -p`). The issue called for swapping the driver to Claude and porting the loop into this CLI so it is portable across repos. The driver choice is load-bearing: the prompt, the output parsing (completion signal + cost), the permission posture, and the per-role model selection are all coupled to whatever CLI is invoked, so it is expensive to change later.

## Decision

- **Driver:** `claude -p` in headless mode, `--output-format stream-json --verbose` (gives live progress, the completion signal, and `total_cost_usd` from one stream), spawned per iteration via Node `spawn` + `readline`.
- **Architecture:** dumb outer loop, smart agent. TypeScript only spawns, counts iterations, and watches output; the agent owns all GitHub state and work judgment (which sub-issue to pick, implement, test, commit, close).
- **Permissions:** `--dangerously-skip-permissions`. An incomplete `--allowedTools` allowlist fails silently mid-run in headless mode, which is worse to debug than the known blast radius of skip-permissions; the max-iterations cap is the blast-radius bound.
- **Models per role:** Haiku (low effort) for the one-shot branch-namer; Sonnet for the implementation slice loop. Opus is not the default — Sonnet is strong enough for vertical slices at a fraction of the cost across many unattended iterations.
- **Reimplemented in TypeScript**, not a shell-out to the project-local `ralph.ps1`, so the loop is portable across repos.

## Considered Options

- **Keep Copilot CLI** — rejected; the issue mandated Claude, and we want one toolchain.
- **Allowlist permissions (`--allowedTools`)** instead of skip-permissions — rejected for v1; silent mid-run stalls on a missing entry are harder to operate than the bounded skip-permissions risk.
- **Opus for the slice loop** — rejected as default on cost grounds; can be revisited if Sonnet underperforms on real slices.
- **Smart TS orchestrator** (TS resolves sub-issue order, calls the agent for one specific issue) — rejected; GitHub state is better read by the prompt-driven agent, and it keeps TS thin.

## Consequences

- **Billing depends on which credential Claude Code resolves, not on headless mode.** Under a Pro/Max subscription, runs draw down subscription rate limits (no per-token bill; worst case the loop stalls on a limit). If `ANTHROPIC_API_KEY` is set it **wins** and bills per-token — the loop can run up cost fast. This is documented for the user; the optional `--budget` guard (off by default) accumulates `total_cost_usd` for the API-key path.
- Cross-run prompt caching is unreliable (fresh process per iteration, 5-minute cache TTL usually exceeded by minute-long slices); cost is estimated as largely cold per run.
- The loop is non-deterministic and hands the agent broad authority under skip-permissions; this is mitigated by running on a dedicated `feat/<name>` branch off a clean tree, never `main`.

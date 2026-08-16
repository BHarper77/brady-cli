# Open one stacked PR per ralph iteration (`--stacked`)

`brady ralph <issue> --stacked` opens one PR per loop iteration, each layered on the one below, instead of a single PR containing every slice. The **ralph loop** owns all stack mechanics; the agent does code and commit only. Post-ralph becomes a **stack walk** — a bottom-up traversal running the full CI-then-review sequence against each layer's own PR.

## Status

accepted

## Context

The ralph loop already decomposes work the way stacked PRs want it decomposed: a parent issue → N thin vertical slices → one commit per iteration. But the end state is a single PR containing all N slices, which is the "unreviewable diff" problem stacked PRs exist to solve. GitHub put stacked PRs into public preview on 2026-07-31 with a `gh stack` extension, so the mapping is available rather than hypothetical.

The repos ralph runs against also post an **automated review** per PR (`claude-code-review.yml`). That workflow triggers on `pull_request` with no branch filter, and the review skill takes its fixed point from `gh pr view --json baseRefName` — so a layer PR is reviewed against its own layer's diff, correctly, with no change to the workflow. This makes per-layer review the natural shape, but it also means every push to the stack can trigger reviews on layers nobody is acting on yet.

## Decision

- **Opt-in, default off.** The feature is in public preview behind a separate extension install and merge queue support is still landing. Single-PR behaviour is the default.
- **The loop owns the stack; the agent never touches it.** Stack mechanics are deterministic bookkeeping with strict ordering — `add` must precede the commit, `submit` must follow it. That is control flow, which the loop already owns, not the "GitHub state is better read by the agent" case from ADR-0001.
- **Layer branches are positional** (`feat/foo-01`, `feat/foo-02`, …). `gh stack add` creates the branch *before* the agent runs, so a descriptive name is not knowable in time; PR titles carry the meaning.
- **Layers are submitted as drafts during the build**, and the **stack walk** marks each ready as it arrives. Combined with an `if: github.event.pull_request.draft == false` guard on the review job, each layer is reviewed exactly once instead of once per push of the layers beneath it — turning O(N²) review runs into N.
- **The walk runs bottom-up, after the whole stack is built**, never interleaved with the loop. Bottom-up so each layer is reviewed against a base already carrying the fixes below it.
- **CI is watched per layer**, not only on the top layer, plus one final top-layer settle as the whole-stack gate.
- **The layer → sub-issue mapping is derived in TypeScript**, by diffing open sub-issues before and after each iteration. Triage is then scoped to that layer's sub-issue, with the parent brief as context rather than scope.
- **A review comment whose defect originates in a lower layer is reported, not routed.** It is printed in the summary for a human.
- **No agent pushes, in either mode.** `ralph-ci-prompt.md` becomes commit-only, matching `ralph-review-fix-prompt.md`; the loop owns every push.
- **Completion is checked in TypeScript before creating a layer**, so a no-work iteration leaves no empty branch dangling. `<promise>COMPLETE</promise>` stays as a secondary stop.
- **A layer that receives no commit is a hard stop**, as is a layer that exhausts its CI budget — both abort the walk with a printed summary of layer state.
- **`--stacked` is a `ralph`-only flag.** `brady ralph-review` stays single-PR.

## Considered Options

- **Let the agent drive `gh stack`** — rejected; ordering is load-bearing control flow, and a non-deterministic agent getting it wrong corrupts the stack in ways that are expensive to unpick.
- **Agent names its own layer branch, loop adopts it** — rejected; `gh stack add` *creates* the branch, so an agent-created branch would need `gh stack link` or the interactive `modify` to join the stack.
- **Replace single-PR mode entirely** — rejected while the feature is in preview behind a separate install.
- **Submit layers with `--open` so human reviewers can start early** — rejected. The early-start property is real for humans but worthless for an automated reviewer, since nothing acts on its feedback until post-ralph anyway, and it costs O(N²) review runs.
- **Review each layer immediately after its iteration** — rejected; `gh stack submit` pushes every branch, so an in-flight round would be reading a head sha a later submit has moved, and review fixes would race the next iteration for the working tree.
- **Top-layer-only CI watching** — rejected. It was justified when review was not per-layer ("N watchers multiply run time"), but the walk already blocks per layer for the review, so per-layer CI costs no extra wall-clock. It also fixes a correctness problem, not just tidiness: a fault in layer 2 repaired on layer N leaves layer 2's own PR red and merged first.
- **Persist the layer → sub-issue mapping so the walk can be resumed** — rejected for v1; it drags persisted state into a design that has none.
- **Route a cross-layer fix down to the layer that owns it** — rejected for v1; it reopens a layer the walk has finished and turns the walk into a resumable state machine.

## Consequences

- **A fix on a layer rebases and force-pushes every layer above it.** This is inherent to stacked PRs. The blast radius is bounded by the loop already batching one push per review round rather than per comment, so an N-layer stack does at most N rebases.
- **N CI runs instead of one**, so N× the Actions minutes. Accepted: a red lower layer is a correctness problem where a wasted Actions minute is not.
- **`--stacked` depends on a convention in the repo under test** — the draft guard on the review job. Without it the feature still works, just expensively, so the preflight warns rather than fails.
- **An interrupted stacked run cannot be resumed.** Layers are pushed incrementally, so an aborted run leaves real PRs on GitHub, and there is no `ralph-review --stacked` to re-enter with. The printed layer summary is the entire recovery mechanism, which is why it must list the layer PR URLs.
- **Default-mode behaviour is no longer byte-for-byte unchanged**: CI fix commits are now pushed by TypeScript rather than by the agent. This is a deliberate, separate change, not a side effect of `--stacked`.
- **Uncommitted work an agent leaves behind is swept into the next layer**, since the next `gh stack add` carries the dirty tree forward. The prompt must instruct the agent to leave a clean tree.

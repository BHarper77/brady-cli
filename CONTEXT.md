# brady-cli

A personal CLI for scaffolding TypeScript projects and managing agent skills sourced from a personal dotfiles repository.

## Language

**Skill**:
A named, self-contained bundle of files (a directory) that teaches an agent a capability. Stored remotely in the dotfiles repo and downloaded into a project locally.

**Dotfiles repo**:
The remote source of truth (`bharper77/dotfiles`) where canonical skills live under `.agents/skills/`. This remote layout is fixed and does not change.
_Avoid_: "upstream" when ambiguous.

**Remote skills path**:
The path inside the dotfiles repo where skills are read from and pushed to. Always `.agents/skills/`.

**Local skills destination**:
The directory in the current project where a downloaded skill is written. Historically `.agents/skills/`; now chosen at download time from a fixed pick-list (`.claude/skills/` listed first, then `.agents/skills/`). The user is always prompted for this — in both the interactive picker and the direct `add <name>` path. The list is driven by a single shared constant so both `add` and `push` read the same options. No semantic default is set (no `initialValue`), consistent with the existing skills multiselect. The directory prompt always comes last — after the skill(s) are determined (multiselect → directory in `add`; the skill arg is already known in `push`).

### Ralph

**Ralph loop**:
An autonomous loop that re-spawns a fresh agent (`claude -p`) once per iteration to work a **parent issue**'s **sub-issues** to completion. The loop itself is "dumb" — it spawns, counts iterations, and watches for the **completion signal**; the agent does the work.

**Parent issue**:
A GitHub issue holding the shared brief (problem, solution, decisions, testing, out-of-scope) plus a set of **sub-issues**. The unit `brady ralph <issue>` is pointed at.

**Sub-issue**:
A thin, vertically-sliced **native GitHub sub-issue** under a **parent issue**. One sub-issue is the unit of work for a single **ralph loop** iteration. Open sub-issues are the queue; closed sub-issues are progress. The agent picks which open sub-issue to work next by its own judgment — there is no declared dependency ordering.

**Completion signal**:
The literal token `<promise>COMPLETE</promise>` the agent emits when no open **sub-issue** remains. Detecting it in a run's output is the **ralph loop**'s stop point.

**Post-ralph**:
The phase that runs after the **completion signal**: the CI watch/fix loop until the checks are green, then the **review round**. It takes one of two shapes — against a single PR, or, in stacked mode, as a **stack walk**. Every part of it spends against the same run-wide cost ledger, so `--budget` bounds the whole run. `brady ralph-review <parent-issue>` enters the same **review round** directly, against a PR that already exists — no **ralph loop** in front of it.

**Stack**:
An ordered chain of branches, each PR targeting the branch below it, so every PR's diff shows only its own **layer**. Owned entirely by the **ralph loop** — the agent never runs a stack command. Opt-in via `--stacked`.

**Layer**:
One branch and its PR within a **stack**: the output of a single **ralph loop** iteration, and therefore one **sub-issue**'s worth of work. Named positionally from the branch stem (`feat/foo-01`, `feat/foo-02`, …) because the branch is created before the agent picks its **sub-issue**; the PR title carries the meaning. Which **sub-issue** a **layer** implemented is recovered by the loop, not declared by the agent — the one that closed during that iteration.

**Stack walk**:
**Post-ralph** in stacked mode: a bottom-up traversal of the **layers**, running the full CI-then-review sequence against each **layer**'s own PR before moving up. Bottom-up so that each **layer** is reviewed against a base already carrying the fixes below it. Layers are submitted as drafts while the **ralph loop** builds the **stack**, and the walk marks each ready as it arrives — so each **layer** is reviewed exactly once, not once per push of the layers beneath it.
_Avoid_: calling the whole traversal a **review round** — the walk visits layers, a round is one pass over one layer's PR.

**Automated review**:
The native GitHub PR review — a body plus line-anchored comments — posted by a review workflow in the repo under test (by default `claude-code-review.yml`). It is always read scoped to a single head sha, so a review left on an earlier push is never mistaken for the review of the code just pushed.

**Review round**:
One pass of: wait for the **automated review** of the current head sha → **triage** its comments → run a fresh agent per **valid** comment → push once. One round is the default; the push at the end of a round retriggers the review, so more than one round only makes sense when you want the reviewer to see the fixes.
_Avoid_: treating a round as a per-comment unit — the round is the batch, the iteration is the comment.

**Dry run**:
A **review round** that stops after **triage** and prints its **verdicts** — no replies posted, no code changed, nothing pushed. The way to check whether triage can tell a real defect from something the brief already settled, before trusting it to spend an iteration per comment. Reports the dismissals as well as the fixes, since triage waving away a real defect is the failure mode worth catching.

**Triage**:
A single iteration that judges every comment in an **automated review** against the **parent issue**'s brief and its **sub-issues**, before any code is changed. It replies on the threads it dismisses and writes its **verdicts** to a temp file the loop reads back. Its purpose is that a reviewer who has seen only the diff does not get to overrule decisions the brief already settled. During a **stack walk** it judges against the **layer**'s own **sub-issue**, with the parent brief as context rather than scope — otherwise a genuine gap gets dismissed as "a later slice handles it" when in a **stack** that later slice is a different PR that also needs the fix.

**Verdict**:
Per-comment output of **triage**: `valid` (worth an iteration) or invalid (explained away in a reply), plus a one-sentence reason handed on to the fix agent. A comment with no verdict is treated as valid — an unreadable triage must not silently drop a finding.

## Relationships

- A **Skill** is read from the **Remote skills path** and written to the **Local skills destination**
- The **Remote skills path** and **Local skills destination** are independent — changing one does not change the other
- `push` resolves the **Local skills destination** by auto-detection: it checks both known destinations, uses the one present, and only prompts when the skill exists in both
- A **Ralph loop** reads a **parent issue** and its **sub-issues**; each iteration closes at most one **sub-issue**
- The **completion signal** terminates the **ralph loop**; the max-iterations cap bounds it
- **Post-ralph** begins where the **ralph loop** ends: CI green first, then the **review round**
- A **review round** reads one **automated review**; **triage** turns its comments into **verdicts**; each valid **verdict** gets its own fresh agent, exactly as each **sub-issue** does
- A **review round** pushes once, not once per comment — one push means one CI run and one new review, not one per fix
- A **stack** is built by the **ralph loop** one **layer** per iteration; a **stack walk** then visits those **layers** bottom-up, and each visit is an ordinary **post-ralph** against that **layer**'s PR
- A **layer** maps to exactly one **sub-issue**, and that mapping is what scopes its **triage**
- A **verdict** whose defect originates in a **layer** below the one being walked is reported, not fixed — routing a fix downward would reopen a **layer** the walk has already finished

## Flagged ambiguities

- `SKILLS_PATH` originally meant both the remote source and the local destination. Resolved: these are distinct concepts — **Remote skills path** (fixed, `.agents/skills`) vs **Local skills destination** (selectable).

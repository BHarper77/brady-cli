---
name: review
description: Review the changes since a fixed point along three axes — Standards, Spec, and Best Practices — in parallel sub-agents, reported side by side or posted as PR line comments.
disable-model-invocation: true
---

# Review

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?
- **Best Practices** — does the code follow best practices for any libraries/frameworks used?

All axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

## Where the review goes

Two output modes, decided before anything else runs:

- **PR mode** — the user named a PR, or the current branch has an open PR and they asked for that to be reviewed, or `$GITHUB_ACTIONS` is set. The output is a single **native PR review** whose findings are line comments — not a file, not one monolithic comment. This is the first step of the review flow: `review` posts the comments, `review-triage` judges them, `review-fix` fixes the survivors.
- **File mode** — everything else. The report goes to a markdown file.

In CI, never ask a question — derive everything and proceed:

- **Fixed point** — the PR base: `gh pr view --json baseRefName -q .baseRefName`, then **prefix it with `origin/`**. The runner checks out a detached `pull/<n>/merge` ref, so there is no local `main` branch and a bare `main...HEAD` dies with `fatal: ambiguous argument 'main'`. Use `origin/main...HEAD`.
- **Spec** — issue refs in the PR body and commit messages, fetched with `gh`. None found → skip the Spec sub-agent, don't ask.

Locally in PR mode, derive the same two the same way, and ask only for what you genuinely cannot.

Everything else runs unchanged.

### Posting the review

Every finding is **anchored**: a file path plus a line on the **right side** of the diff. Post one review carrying all of them, so the PR gets a single notification and the comments thread against the code:

```
gh api repos/{owner}/{repo}/pulls/{n}/reviews --input review.json
```

(`{n}` is `gh pr view --json number -q .number`.)

with `review.json`:

```json
{
  "event": "COMMENT",
  "body": "<short preamble: axes run, axes skipped and why, unanchorable findings>",
  "comments": [
    {
      "path": "apps/backend/src/foo.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**Standards** — <finding, with the cited rule>"
    }
  ]
}
```

Rules that keep the call from being rejected or misleading:

- **A line outside the diff kills the whole request.** GitHub 422s the entire review if any comment names a line it can't anchor. Verify each `line` appears in `git diff <fixed-point>...HEAD` for that path before including it; move any that don't into the body.
- **Findings that have no line** — a spec requirement never implemented, a missing file — belong in the body under a `### Unanchored` heading. Don't invent a plausible line for them.
- **Prefix each comment with its axis** in bold (`**Standards**`, `**Spec**`, `**Best Practices**`) — the axes stay legible once the findings are scattered across the diff.
- **Multi-line findings** use `start_line` plus `line` (both `side: "RIGHT"`).
- Findings on the same line from different axes stay **separate comments**. Don't merge them.
- **Only findings, one per comment.** Each becomes a thread that triage must judge and fix must close, so don't pad the review with praise or observations.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. Don't be opinionated; pass it through. If they didn't specify one, ask: "Review against what — a branch, a commit, or `main`?" Don't proceed until you have it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A PRD/spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written. Common locations:

- `CLAUDE.md`, `AGENTS.md`
- `CONTRIBUTING.md`
- `CONTEXT.md`, `CONTEXT-MAP.md`, per-context `CONTEXT.md` files
- `docs/adr/` (architectural decisions are standards)
- `.editorconfig`, `eslint.config.*`, `biome.json`, `prettier.config.*`, `tsconfig.json` (machine-enforced standards — note them but don't re-check what tooling already checks)
- Any `STYLE.md`, `STANDARDS.md`, `STYLEGUIDE.md`, or similar at the repo root or under `docs/`

Collect the list of files. The **Standards** sub-agent will read them.

### 4. Identify any external libraries or frameworks used

Use the diff and commits to identify any external libraries or frameworks used during implementation. For each of these:

1. Find the best source of documentation (either via an MCP, llms.txt or a web search for the docs site)
2. Note this for the **Best Practices** sub-agent, which will use the docs to ensure best practices were followed during implementation

### 5. Spawn all sub-agents in parallel, then block on them

Send a single message with three `Agent` tool calls. Use the `general-purpose` subagent for all.

Every `Agent` call is **asynchronous**. It returns an agentId immediately and the findings arrive as a notification on a _later turn_ — `run_in_background: false` does not change this; the parameter is ignored and the agent still runs in the background. A headless CI run has no later turn, so the moment you end your turn to wait, the SDK sees a finished turn and the job exits **green with no review posted**. "I'll wait for the sub-agents to report back" _is_ ending your turn, and it is the one failure this step exists to prevent.

**So don't wait — block.** In the very next assistant message after the spawns, call `TaskOutput` once per agentId:

```
TaskOutput(task_id: "<agentId>", block: true, timeout: 600000)
```

Three calls, one per agent; issue all three in a single message. If one returns before its agent is done, call it again on that same id. Only once all three have returned actual findings do you go to step 6.

Never emit a text-only turn between the spawns and the `TaskOutput` calls. If `TaskOutput` is unavailable, fall back to `SendMessage` to each agentId — a reply is a blocking read; `ListAgents` recovers an id you have lost.

Add this to every brief, so the findings arrive **anchored** and ready to post as line comments: "Head each finding with `<path>:<line>` — the line as it appears on the right side of the diff. If a finding has no such line (something missing entirely), head it `UNANCHORED` instead. Never guess a line."

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3.
- The brief: "Read the standards docs. Then read the diff. Report every place the diff violates a documented standard. Cite the standard (file + the rule). Distinguish hard violations from judgement calls. Skip anything tooling enforces. Around 500 words. Only report violations."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Read the spec. Then read the diff. Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Around 500 words. Only report violations"

If the spec is missing, skip the Spec sub-agent and note this in the final report.

**Best Practices sub-agent prompt** — include:

- The diff command and commit list.
- The list of external libraries/frameworks and their docs you found in step 4.
- The brief: "For each relevant library/framework, read the relevant sections of the docs on best practices. Then read the diff. Report any places where the diff violates best practices for that library/framework. Always cite the source for each finding. Around 500 words. Only report violations."

If there are no major libraries used or you can't find docs, skip the Best Practices sub-agent and note this in the final report.

### 6. Aggregate

Present the three reports under `## Standards`, `## Spec`, and `## Best Practices` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the three axes are deliberately separate so the user can see them independently.

In file mode, write the review to a markdown file named `<spec>-<branch>-review.md` in the repo root. In PR mode there's no file — post the findings as the anchored PR review described above.

---
name: review-triage
description: "Judge each open review comment on a PR against the originating issue and the repo's standards, then reply to every one and resolve the ones not worth acting on."
disable-model-invocation: true
---

# Review triage

Second step of the review flow: `review` posts the comments, **this skill decides which are worth acting on**, `review-fix` fixes the survivors.

Triage only. Do not edit code, do not commit, do not push.

The handoff to `review-fix` is the PR itself, not a file: a comment left **open** is one to fix, a comment **resolved** is settled. So every judgement ends in a reply, and the invalid ones also end resolved.

## 1. Pin the PR

Whatever the user named — a PR number, a branch, or nothing (the current branch):

```bash
gh pr view [<pr>] --json number,url,headRefName,baseRefName,body
```

## 2. Gather context first

A comment can only be judged against what the work was supposed to do. Read, in this order:

1. **The originating issue** — from the PR body (`Closes #N`) or the commit messages. Its brief: the problem, the chosen solution, decisions already made, anything declared out of scope.
2. **Its sub-issues**, including closed ones and the comments left when they were closed — `gh api repos/{owner}/{repo}/issues/<n>/sub_issues`. These record what each slice deliberately did and did not do.
3. **The PR and its diff** — `gh pr view <n>` and `gh pr diff <n>`.
4. **The repo's documented standards** — CLAUDE.md, AGENTS.md, CONTEXT.md, `docs/adr/` — wherever a comment appeals to them.

If there is no originating issue, say so and judge against the diff and the standards alone.

## 3. Collect the open comments

Unresolved top-level threads only. Replies are previous answers, not findings; resolved threads are finished business:

```bash
gh api graphql -f query='
query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100){ nodes{
        id isResolved
        comments(first:100){ nodes{ databaseId path line body url author{login} } }
      } }
    }
  }
}' -F owner=<owner> -F name=<repo> -F pr=<n>
```

Keep the threads where `isResolved` is false, and take the **first** comment of each — that is the finding. Hold on to each thread's `id` (a `PRRT_…` node id) and that comment's `databaseId`; you need both below.

## 4. Judge each comment

A comment is **valid** when acting on it is the right call:

- it identifies a real defect — a bug, a crash, a security or data-integrity problem, a case the code gets wrong;
- or the code genuinely violates a standard documented in this repo;
- or it is a real mismatch between the code and what the issue asked for.

A comment is **invalid** when it should be explained away rather than acted on:

- the behaviour it objects to is a deliberate decision recorded in the issue, a sub-issue, or an ADR;
- it asks for work the issue explicitly put out of scope, or for a later slice that is already tracked;
- it is a matter of taste with no documented standard behind it, and the code is consistent with its surroundings;
- it is factually wrong about what the code does.

Be a sceptical reader, not a compliant one. When genuinely unsure, mark it valid: a needless fix is cheaper than a shipped defect.

## 5. Reply to every comment, resolve the invalid ones

Reply on the thread of each comment, using its `databaseId`:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/comments/<databaseId>/replies -f body='<verdict>'
```

- **Invalid** — say why it is not being actioned, citing the issue, sub-issue, or ADR that settles it. Then resolve the thread:

  ```bash
  gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=<threadId>
  ```

- **Valid** — say in one sentence what actually needs to change. **Leave the thread open**: `review-fix` picks it up from there, and resolves it once the fix is committed. When several comments need the same change (the same pattern, fixed the same way), say in each reply that they are one fix, so they get worked together rather than once per thread.

A thread that cannot be resolved (the API refuses, no thread id) is a tidiness problem — log it and carry on.

Done when **every** comment collected in step 3 carries exactly one reply from you, and every invalid one is resolved. Account for them by id; a comment you silently skipped is one `review-fix` will try to fix.

## 6. Report

A short table: path:line, verdict, one-line reason, and the comment URL. End with the count left open for `review-fix`, and tell the user to run `review-fix` next.

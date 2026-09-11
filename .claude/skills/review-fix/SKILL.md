---
name: review-fix
description: "Fix the review comments left open by triage, one commit each, replying and resolving as they land."
disable-model-invocation: true
---

# Review fix

Third step of the review flow: `review` posts the comments, `review-triage` resolves the ones not worth acting on, **this skill fixes the rest**.

The open threads _are_ the work list. Anything still unresolved after triage was judged worth acting on; triage's reply on the thread says what needs to change.

## 1. Pin the PR and its work list

```bash
gh pr view [<pr>] --json number,url,headRefName,baseRefName,body
```

Stay on the PR's head branch — check it out if you are not on it, and never touch the base branch.

Collect the unresolved threads exactly as `review-triage` does:

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

For each unresolved thread keep: the thread `id`, the first comment (the finding) with its `databaseId`, `path`, `line`, `body`, and any later reply from triage — that reply is the brief for the fix.

If a thread has no triage reply, triage has not run. Say so and stop; the user should run `review-triage` first.

## 2. Fix them one at a time

Work each thread on its own — a fresh read, a change scoped to that comment and nothing else, its own commit. Never batch several findings into one commit, and never refactor opportunistically along the way.

For each:

1. **Read enough context to fix it properly** — the file and its surroundings, and the originating issue where the comment touches on intent.
2. **Make the change.** Fix the underlying problem the comment points at, not just the exact line it was left on: if the same mistake appears elsewhere in this PR's diff, fix it there too.
3. **Verify.** Run the project's tests, typecheck, and build for what you touched, and get them green before committing. Never delete, skip, or weaken a test to make things pass.
4. **Commit** using the `commit` skill. One commit per comment, so the fix and the finding stay traceable to each other.
5. **Reply and resolve**, in that order — and only once the fix is committed:

   ```bash
   gh api repos/{owner}/{repo}/pulls/<n>/comments/<databaseId>/replies -f body='<what changed, and the commit sha>'
   gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' -F id=<threadId>
   ```

   A commit is the evidence the comment was acted on. **No commit, no resolve.**

If, having read the code, you conclude the comment is wrong after all, do not force a change. Reply on the thread explaining why and resolve the thread. Then move to the next one.

Done when every thread from step 1 has ended one of those two ways — committed, replied and resolved, or replied and deliberately left open. No thread is left untouched.

## 3. Push once

Push the branch once every comment has been handled, not once per fix — each push retriggers CI and the review workflow, and a round's fixes only make sense reviewed together.

```bash
git push origin <branch>
```

## 4. Report

Per comment: path:line, what changed (or why nothing did), and the commit sha. End with the count fixed, the count left open, and whether the push happened.

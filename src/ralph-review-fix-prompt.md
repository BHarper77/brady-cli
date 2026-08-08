Address one review comment on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`). This is comment {{INDEX}} of {{TOTAL}}; the others are handled by their own iterations, so work only on this one.

## The comment

- **id**: {{COMMENT_ID}}
- **location**: `{{COMMENT_PATH}}`{{COMMENT_LOCATION_SUFFIX}}
- **link**: {{COMMENT_URL}}

```
{{COMMENT_BODY}}
```

A triage pass already judged this comment worth acting on:

> {{TRIAGE_REASON}}

## What to do

1. Read enough context to fix it properly — the file and its surroundings, and the parent issue #{{PARENT_ISSUE}} or its sub-issues where the comment touches on intent.
2. Make the change. Fix the underlying problem the comment points at, not just the exact line it was left on — if the same mistake appears elsewhere in this PR's diff, fix it there too.
3. Verify: run the project's tests / typecheck / build as appropriate for what you touched.
4. Commit using the `/commit` skill.
5. Reply on the comment's thread saying what you changed:

   ```
   gh api repos/{owner}/{repo}/pulls/{{PR_NUMBER}}/comments/{{COMMENT_ID}}/replies -f body='<what changed>'
   ```

If, having read the code, you conclude the comment is wrong after all, do not force a change: reply on the thread explaining why, and stop without committing.

## Constraints

- **Do not push.** The loop pushes once every comment has been handled, so the CI and review workflows fire once rather than per comment.
- Stay on branch `{{BRANCH}}`; do not open a new PR and do not touch `main`.
- Keep the change minimal and scoped to this comment. Do not opportunistically refactor, and do not act on the other review comments.
- Never delete, skip, or weaken a test to make things pass — fix the actual problem.

Address one review comment on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`), in the context of parent issue #{{PARENT_ISSUE}}.

Invoke the **`review-fix`** skill to do it — call the `Skill` tool with `skill: "review-fix"` and `args: "PR #{{PR_NUMBER}}, comment {{COMMENT_ID}} only"`. The skill sets `disable-model-invocation`, so an explicit `Skill` call is the only way in. Follow it as written, with the two scope changes below.

## Scope change 1: one comment, not the whole list

This is comment {{INDEX}} of {{TOTAL}}. The others are handled by their own iterations, so skip the skill's own thread-collecting step and work only this one:

- **id**: {{COMMENT_ID}}
- **location**: `{{COMMENT_PATH}}`{{COMMENT_LOCATION_SUFFIX}}
- **link**: {{COMMENT_URL}}

```
{{COMMENT_BODY}}
```

Triage already judged this comment worth acting on, and this is its brief — the reply on the thread says the same thing:

> {{TRIAGE_REASON}}

## Scope change 2: do not push

**Do not push.** Skip the skill's push step entirely: the loop pushes once every comment has been handled, so CI and the review workflow fire once rather than per comment.

Stay on branch `{{BRANCH}}`; do not open a new PR and do not touch `main`.

Address one fix group of review comments on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`), in the context of parent issue #{{PARENT_ISSUE}}.

Invoke the **`review-fix`** skill to do it — call the `Skill` tool with `skill: "review-fix"` and `args: "PR #{{PR_NUMBER}}, comment(s) {{COMMENT_IDS}} only"`. The skill sets `disable-model-invocation`, so an explicit `Skill` call is the only way in. Follow it as written, with the three scope changes below.

## Scope change 1: one fix group, not the whole list

This is fix group {{INDEX}} of {{TOTAL}}. The other groups are handled by their own iterations, so skip the skill's own thread-collecting step and work only the {{COUNT}} comment(s) below.

Triage judged each worth acting on, and put them in one group because they need the same change. Each comment's brief is triage's reason; the reply on its thread says the same thing.

{{COMMENTS}}

## Scope change 2: one change, one commit, every thread answered

A group is one finding seen in one or more places. Make the change once, covering every location, and commit it once. For a group of several comments this overrides the skill's one-commit-per-comment rule.

Then reply on **every** comment in the group, citing the commit sha, and resolve **every** thread, using the commands given with each comment. If, having read the code, one of them turns out not to need the change after all, reply on that one explaining why and resolve it. The rest still get the fix.

## Scope change 3: do not push

**Do not push.** Skip the skill's push step entirely: the loop pushes once every group has been handled, so CI and the review workflow fire once rather than per group.

Stay on branch `{{BRANCH}}`; do not open a new PR and do not touch `main`.

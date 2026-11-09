Address one fix group of review comments on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`), in the context of parent issue #{{PARENT_ISSUE}}.

Follow the **`review-fix` instructions** at the end of this prompt, as written, with the four scope changes below. They are that skill's SKILL.md, embedded here by the loop on the user's behalf. Do **not** call the `Skill` tool for `review-fix`: the skill is user-invocation-only and the call will be refused. You already have its instructions; following them directly is what the user wants. Files the instructions link to live in `{{SKILL_DIR}}`.

No one is watching this session. Never stop to ask the user to run something; if you cannot act on a comment, reply on its thread saying why.

## Scope change 1: one fix group, not the whole list

This is fix group {{INDEX}} of {{TOTAL}}. The other groups are handled by their own iterations, so skip the instructions' own thread-collecting step and work only the {{COUNT}} comment(s) below (ids: {{COMMENT_IDS}}).

Triage judged each worth acting on, and put them in one group because they need the same change. Each comment's brief is triage's reason; the reply on its thread says the same thing.

{{COMMENTS}}

## Scope change 2: one change, one commit, every thread answered

A group is one finding seen in one or more places. Make the change once, covering every location, and commit it once. For a group of several comments this overrides the instructions' one-commit-per-comment rule.

Then reply on **every** comment in the group, citing the commit sha, and resolve **every** thread, using the commands given with each comment. If, having read the code, one of them turns out not to need the change after all, reply on that one explaining why and resolve it. The rest still get the fix.

The loop checks your work: it resolves a thread only if a commit landed or you replied on that thread. A thread with neither is left open and flagged to the user as unaddressed.

## Scope change 3: commit directly

Where the instructions say to commit using the `commit` skill, commit directly with git instead: stage only the files you changed for this fix and make one conventional commit (`fix(<scope>): <summary>`). Do not use the `commit` skill here; it splits work into several commits and a fix group is exactly one.

## Scope change 4: do not push

**Do not push.** Skip the push step entirely: the loop pushes once every group has been handled, so CI and the review workflow fire once rather than per group.

Stay on branch `{{BRANCH}}`; do not open a new PR and do not touch `main`.

---

## The `review-fix` instructions

{{SKILL_BODY}}

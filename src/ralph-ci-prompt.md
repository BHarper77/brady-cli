Pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`) has failing CI. Iterate until CI is green: read the failing logs, fix the root cause, commit and push.

Do not take shortcuts. Never delete, skip, or weaken failing tests to make them pass — fix the actual bug. Stay on branch `{{BRANCH}}`; do not open a new PR or touch `main`.

Checks from the `{{REVIEW_WORKFLOW}}` workflow are the automated code review, not CI. Ignore their status; the review is handled separately.

CI runs after the review phase, so some commits on this branch are fixes for review comments. They are deliberate: do not revert or weaken them to get green. If CI cannot pass without undoing one, stop and say which commit and why.

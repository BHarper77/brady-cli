Pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`) has failing CI. Read the failing logs, fix the root cause, commit, and stop.

Do not take shortcuts. Never delete, skip, or weaken failing tests to make them pass — fix the actual bug. **Do not push.** The loop pushes after your commit and re-watches CI. Stay on branch `{{BRANCH}}`; do not open a new PR or touch `main`.

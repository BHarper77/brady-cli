1. Read the parent issue and its native sub-issues:
   - Find the highest priority issue to work on and work only on that issue. This should be the one YOU decide has the highest priority, not necessarily the first in the list.
2. If there are **no open sub-issues**, you are done — emit the completion signal (see below) and stop. Do not invent work.
3. Implement that one sub-issue end to end:
   - Make the code changes for a thin vertical slice.
   - Test your change (run the project's tests / typecheck / build as appropriate).
   - Commit using the `/commit` skill.
   - Close the sub-issue (`gh issue close <n>` with a short comment summarising what you did).
4. Do **not** work more than one sub-issue. Do not open a pull request. Do not touch `main` — you are already on the correct feature branch.

## Completion signal

If, while implementing the feature, you notice all issues are closed: push the commits to remote, create the PR and <promise>COMPLETE</promise>.

## Constraints

- You are running with permissions skipped; be careful and stay within the scope of the chosen sub-issue.
- Keep changes minimal and focused on the one slice.
- If you cannot make progress on any open sub-issue, explain why and stop without emitting the completion signal.

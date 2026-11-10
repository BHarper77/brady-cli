Write the title and description for a pull request. Do not create the PR, push, commit, or change any files: you only write text.

The PR merges branch `{{BRANCH}}` into `{{BASE}}`. It implements parent issue #{{PARENT_ISSUE}}, one commit per sub-issue.

Read what you need:

- `gh issue view {{PARENT_ISSUE}}`: the brief.
- `git log --reverse --format='%h %s%n%b' origin/{{BASE}}..HEAD`: the commits.
- `git diff --stat origin/{{BASE}}...HEAD`: what changed. Open individual diffs only where a commit message leaves you unsure.

Title: a conventional-commit subject (`feat: …`, `fix: …`) under 72 characters, summarising the whole change.

Body, in markdown:

- One short paragraph: what the PR does and why.
- A bullet per sub-issue: what changed, with its `#number`.
- Anything a reviewer should look at closely, or that was left out on purpose. Skip this section when there is nothing.
- `Closes #{{PARENT_ISSUE}}` on its own last line.

Keep it short and concrete, and describe only what the commits show.

End your reply with exactly this, and nothing after it:

<title>the title</title>
<body>
the body
</body>

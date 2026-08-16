An automated reviewer has left comments on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`). Your job is **triage only**: decide which comments are worth acting on.
{{MODE_BANNER}}
{{LAYER_SCOPE_BLOCK}}

## Context to gather first

Read these before judging anything — a comment can only be judged against what the work was actually supposed to do:

1. The parent issue #{{PARENT_ISSUE}} — the brief: problem, chosen solution, decisions already made, and anything declared out of scope.
2. Its sub-issues (`gh api repos/{owner}/{repo}/issues/{{PARENT_ISSUE}}/sub_issues`), including the closed ones and the comments left when they were closed. These record what each slice deliberately did and did not do.
3. The PR itself — `gh pr view {{PR_NUMBER}}` and its diff.
4. The repo's own documented standards (CLAUDE.md, CONTEXT.md, docs/adr/) where a comment appeals to them.

## The review

Review body:

```
{{REVIEW_BODY}}
```

Comments to triage (JSON):

```json
{{COMMENTS_JSON}}
```

## Judging a comment

A comment is **valid** when acting on it is the right call:

- it identifies a real defect — a bug, a crash, a security or data-integrity problem, a case the code gets wrong;
- or the code genuinely violates a standard documented in this repo;
- or it is a real mismatch between the code and what the parent issue asked for.

A comment is **invalid** when it should be explained away rather than acted on:

- the behaviour it objects to is a deliberate decision recorded in the parent issue, a sub-issue, or an ADR;
- it asks for work the parent issue explicitly put out of scope, or for a future slice that is already tracked;
- it is a matter of taste with no documented standard behind it, and the existing code is consistent with the surrounding code;
- it is factually wrong about what the code does.

Be a sceptical reader, not a compliant one.

When genuinely unsure, mark it valid: a needless fix is cheaper than shipping a real defect.

## Output

For each comment you judge **invalid**, post a reply on its thread explaining why, citing the issue, sub-issue, or ADR that settles it:

```
gh api repos/{owner}/{repo}/pulls/{{PR_NUMBER}}/comments/<comment-id>/replies -f body='<why this is not being actioned>'
```

Reply only to the invalid ones — the valid ones get answered later by the agent that fixes them. Do not resolve any thread; the loop resolves them for you once the reply is in.

Then write your verdicts to `{{VERDICTS_PATH}}` as JSON, and nothing else in the file:

```json
{
  "verdicts": [
    {
      "commentId": 123456,
      "valid": true,
      "reason": "Off-by-one is real: the loop drops the final contributor."
    },
    {
      "commentId": 123457,
      "valid": false,
      "reason": "Deliberate — issue #42 decided projections stay unrounded."
    },
    {
      "commentId": 123458,
      "valid": true,
      "crossLayer": true,
      "reason": "Real defect, but it originates in the lower layer's parsing code, not this one."
    }
  ]
}
```

`reason` is one sentence, and is handed to the agent that does the fix — for a valid comment, say what actually needs to change. Only set `crossLayer` when the scope block above tells you this is a stack walk and the defect belongs to a lower layer.

## Constraints

- Triage only. Do not edit code, do not commit, do not push.
- Every comment id above must appear exactly once in the verdicts file.

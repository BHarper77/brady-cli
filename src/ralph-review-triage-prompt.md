Triage the automated review on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`), judging its comments against parent issue #{{PARENT_ISSUE}}.

Invoke the **`review-triage`** skill to do it — call the `Skill` tool with `skill: "review-triage"` and `args: "PR #{{PR_NUMBER}}, judged against issue #{{PARENT_ISSUE}}"`. The skill sets `disable-model-invocation`, so an explicit `Skill` call is the only way in. Follow it as written; everything below is the loop's additions to it, not a replacement for it.
{{MODE_BANNER}}

## The comments to triage

The loop has already collected the open threads, so triage exactly these and no others:

```json
{{COMMENTS_JSON}}
```

For reference, the review body that carried them:

```
{{REVIEW_BODY}}
```

## Also write the verdicts to a file

The loop decides what to fix from a file, not from your prose. So in addition to the skill's own output, write your verdicts to `{{VERDICTS_PATH}}` as JSON, with nothing else in the file:

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
    }
  ]
}
```

`reason` is one sentence, and is handed to the agent that does the fix — for a valid comment, say what actually needs to change.

Every comment id above must appear exactly once in the verdicts file.

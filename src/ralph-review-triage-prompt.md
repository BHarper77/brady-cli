Triage the automated review on pull request #{{PR_NUMBER}} (branch `{{BRANCH}}`), judging its comments against parent issue #{{PARENT_ISSUE}}.

Follow the **`review-triage` instructions** at the end of this prompt, as written. They are that skill's SKILL.md, embedded here by the loop on the user's behalf. Do **not** call the `Skill` tool for `review-triage`: the skill is user-invocation-only and the call will be refused. You already have its instructions; following them directly is what the user wants. Files the instructions link to live in `{{SKILL_DIR}}`.

The sections below are the loop's additions to those instructions, not a replacement for them. Where they conflict, the loop's additions win.
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
      "valid": true,
      "reason": "Query is unscoped: filter by owner with `ownedBy(userId)`.",
      "group": "owned-by"
    },
    {
      "commentId": 123458,
      "valid": true,
      "reason": "Same unscoped query: filter by owner with `ownedBy(userId)`.",
      "group": "owned-by"
    },
    {
      "commentId": 123459,
      "valid": false,
      "reason": "Deliberate — issue #42 decided projections stay unrounded."
    }
  ]
}
```

`reason` is one sentence, and is handed to the agent that does the fix — for a valid comment, say what actually needs to change.

`group` is optional, and only means anything on a valid comment. Give comments that need the same change (the same pattern, fixed the same way) the same `group` label, any short string. The loop runs one fix agent per group rather than one per comment, so the change is made, built and tested once. Leave `group` off a comment that stands alone. Do not group comments that merely sit in the same file: a group is one fix.

Every comment id above must appear exactly once in the verdicts file.

If you cannot write the verdicts file for any reason, say so plainly and stop. Never fall back to asking the user to run something: no one is watching this session.

---

## The `review-triage` instructions

{{SKILL_BODY}}

# Attribution-record correction — #2189 (trusted-read provider-scale smoke)

Forward correction (the Truthful Attribution protocol) for the verification
record of squash commit `281f005922afb6f3cc8eac3a4f4da3a3a9965bf2`
("test(mcp): provider-scale smoke for trusted-read native injection + the
pinned-stack empty-emission proof (#2019) (#2189)").

## What landed

PR #2189 adds a provider-scale proof harness for the native read-tool
injection pipeline: a 64-tool fixture, serialization-boundary checks for both
supported model providers, and a scheduled live proof that a pristine setup
still emits nothing. It is a docs/tests/CI-fixture change with no production
behavior change. The merge and the maintainer approval backing it are valid —
this correction only concerns the attribution record's formatting.

## What was wrong

The squash landed with a complete, correctly-shaped record — a machine arm
(`Gate-suite` + `Accountable`) and a real, non-self maintainer approval
(`Reviewed-by`) — but one `Assisted-by` line carried the model's
human-readable display name instead of its model id:

    Assisted-by: Claude Code (Claude Sonnet 5)

The attribution gate's model-id grammar expects the lowercase slug form; the
capitalized display name with a space does not match it, so the record reads
as malformed even though the underlying claim (Claude Code, running on the
Claude Sonnet 5 model, materially produced the diff) is true. Only the model
field's format is wrong.

## The corrected truthful record for 281f0059

The record that landed, unchanged except for the one line normalized to the
gate's accepted model-id form:

```
Gate-suite: cinatra-core@2026.07.7
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
Assisted-by: Codex (gpt-5.5)
```

Nothing about the change's content, its risk classification, the machine
arm, or the human approval changes — only the malformed `Assisted-by`
model-id token is corrected.

## The correction

This docs-only governance note carries the `Correction-for:` trailer that
the post-merge gate consumes to clear the blocked line, plus its own valid
`Assisted-by` record. It changes no runtime code and is non-high-risk.

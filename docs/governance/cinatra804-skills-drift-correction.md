# Skills-drift correction — cinatra#804 (`consumes` field + closure validator)

## What

The post-merge `skills-drift-gate` reported a watch finding on the squash of **cinatra#804** (commit `340174bd3`):

> `chat-create-artifact/SKILL.md` depends on changed surface `artifact_authoring_emit` (primitives).

The squash message did not carry the acknowledging marker (the well-known squash-marker trap: a marker on the PR head is discarded by the squash, and the post-merge gate reads the squash message). This docs-only commit records the acknowledgment and greens the `main` tip.

## Why the skill is unaffected

cinatra#804 adds the structured `consumes` manifest field (`packages/sdk-extensions/src/consumes.ts`) and a declared-vs-used closure validator (`packages/extensions/src/dependency-declaration-validator.ts`). It **enumerates** `artifact_authoring_emit` as a known consumable primitive in the new consumes registry (plus a test fixture that declares consuming it) — it does **not** change the `artifact_authoring_emit` primitive's contract/behavior, nor the `chat-create-artifact` skill's authoring surface. The skill continues to emit artifacts through the same primitive with the same contract.

Therefore the correct resolution is `Skills-unaffected` — carried in this correction's squash message.

## Reference

- Red commit: `340174bd3` (cinatra#804), skills-drift-gate only (the truthful-attribution-gate on that commit concluded success — a real @groganz Reviewed-by).
- Recovery pattern: docs-only correction whose squash body carries the `Skills-unaffected:` marker (mirrors the prior skills-drift recovery).

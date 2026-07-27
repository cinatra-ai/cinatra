# cinatra#2047 D-4 / D-5 / D-7 — live proof

Live evidence for the observability correction lane: the three lifecycle states
the S8 acceptance report found to be **real in the store and invisible in the
product**.

**Environment.** The repo's own verify stack (Postgres + Redis on the shared dev
ports, a database dedicated to this lane), a real first-admin signup, the app on
a lane-scoped port. **Both lifecycle activation fences were flipped ON**
(`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=on`,
`CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW=on`) — on `origin/main` both default
OFF (`src/lib/lifecycle/lifecycle-activation.ts`), so the S1 slice is inert until
an operator flips it. Everything below therefore shows the epic's intended end
state under an operator flip, exactly as the acceptance run did. The
setup-wizard bypass the repo's own e2e suites use (`CINATRA_E2E_SETUP_BYPASS`)
was set so the walk could reach app surfaces; it changes no authorization on the
review path.

## What was driven

`walk.test.ts` drives the SHIPPED entry points against the live database —
`createSemanticArtifact` → `sweepReviewOrchestration` → the gate / park / policy
stores. No stub anywhere in the chain. Output: `logs/W-lane-2047-walk.log`
(one `LANE2047` JSON line per step).

| Step | What it produces |
|---|---|
| `D5_*` | ONE run carrying BOTH a review that FIRED (core default) and a review the org `forbidden` bound SKIPPED — the exact `Z5_ORG_FORBIDDEN` case the acceptance report found invisible |
| `D4_*` | a resume intent driven to attempt exhaustion and dead-lettered |
| `D7_*` | a checkpointed external-effect production whose park TTL-fail-closed into `policy_unresolved` |

## D-5 — the run timeline renders the skipped decision

`screenshots/D5-run-timeline-skipped-decision.png` — the run surface under
`/agents/cinatra-ai/blog-draft-writer-agent/<runId>`.

The rail shows two entries:

- **Review** — the FIRED decision, rendering as its gate (deep-linked into the
  run-embedded review surface), exactly as before this lane.
- **Review skipped · ORG-BOUND · "org policy forbids review for this class"** —
  the SKIPPED decision. Before this lane the same production left
  `status='processed'`, `continuation_address = NULL` and **nothing rendered
  anywhere**, so a deliberately-skipped review was indistinguishable from no
  lifecycle machinery running.

Store side (`LANE2047 D5_DECISIONS`): the fired row carries
`outcome:"fired", decidedBy:"core-default", reasonStale:false`; the skipped row
carries `outcome:"skipped", gateId:null, latticeOutcome:"forbidden",
decidedBy:"org-bound", reasonStale:false`. `LANE2047 D5_OUTBOX` shows the two
underlying rows the projection reads (one with a continuation address, one
without).

## D-4 + D-7 — the ops surface

`screenshots/D4-D7-lifecycle-operations-ops-surface.png` —
`/configuration/lifecycle-operations` (admin-gated, org-scoped).

- **Stuck review releases** lists the dead-lettered resume intents with run,
  review task, decision kind, attempts (`3/3`), dead-letter time and last error.
  `readDeadLetteredResumeIntents` had **zero production callers** before this.
- **Blocked effects (policy unresolved)** lists the TTL-fail-closed continuation
  parks with run, artifact, checkpoint, blocked effect class
  (`external_publish`) and the deadline that passed. `readPolicyUnresolvedParks`
  likewise had **zero production callers**.

The effect layer agrees with the surface (`LANE2047 D7_EFFECT_DISPOSITION` /
`D7_EFFECT_HELD`): `disposition:"policy_unresolved"`, `held:true`,
`policyUnresolved:true` — where before this lane the same artifact reported
`approved` (appliable) because `resolveArtifactEffectDisposition` never joined
the park.

## Reproducing

With the verify stack up and a `.env.local` pointing at it (both fences ON):

```
WALK_ORG_ID=<org> WALK_USER_ID=<user> WALK_TEMPLATE_ID=<template> \
WALK_OBJECT_TYPE='@cinatra-ai/text-artifact:artifact' \
pnpm exec vitest run --config evidence/2047-observability/walk.config.ts \
  --disable-console-intercept --reporter=verbose
```

Then sign in as the admin and open the run URL printed as `LANE2047 D5_RUN`
plus `/configuration/lifecycle-operations`.

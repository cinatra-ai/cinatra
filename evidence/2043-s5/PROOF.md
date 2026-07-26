# S5 (cinatra#2043) core-side live proof — evidence

Captured against the LIVE dev stack: Postgres `127.0.0.1:5634/s5core`, Redis
`6579`, app on port `3073`, the lifecycle fence ON
(`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=on`), a REAL first-admin signup
(`s5admin@example.com`, org `Default`). A test harness stands in for the
connector staged-write adapter (the follow-up lane) and drives the core capture
entry point with real WordPress-shaped content.

## L1 — capture writes the one-tx substrate atomically
`captureCmsContentSnapshot` (fence ON) persisted, in ONE transaction: the
snapshot `objects` row + `resource` + `artifact_blobs` + append-only
`representation`, the transactional `ArtifactProduced` event (emitter
`object_cms_snapshot_capture`, `external_publish`), and the
`cms_snapshot_targets` apply-binding row. Proven by the real-pg integration
suite (atomic-rollback case included) and the live walk below.

## L2 — produced event → S1 orchestration → review gate opens, snapshot pinned
`sweepReviewOrchestration` consumed the produced event and opened a review gate
PINNED to the snapshot. The run-embedded review surface renders it — see
`L2-review-surface-snapshot-pinned.png`: Artifact
`17562070-d04f-4c09-9b07-11aa19e10352`, revision `c32675d0…` · **pinned**, with
the Approve/Reject/Comment decision bar and the S2 "Ask Cinatra to suggest
edits" prompt window.

Live walk output (real app schema `cinatra`):
```
S5_WALK_JSON  gateId=955be04a-…  snapshotArtifactId=17562070-…  snapshotRevisionId=c32675d0-…
              producedEventId=0099eb87…  (gate.pinned_targets[0] == snapshotRevisionId)
S5_L3_VERIFIED {"ok":true,"outcome":"verified"}
S5_L4_DRIFTED  {"ok":true,"outcome":"drifted","outOfScope":["author"]}
```

## L3 — faithful apply → verified
The read-back binding fed `recordVerificationForExternalChange` the STORED scope
manifest + the stored snapshot as the reviewed base; a faithful projected apply
recorded `verified` (store proof above; real-pg read-back suite).

## L4 — out-of-scope rewrite → drifted
A rewrite touching a field (`author`) outside the stored scope manifest recorded
`drifted` with `outOfScopePaths=["author"]` (store proof above; real-pg suite).

## OPEN (not this lane) — the CMS visual review surface
The review target's CONTENT preview shows "review target unavailable
(unknown-or-tombstoned)" and the gate is not yet decidable through the UI:
rendering + deciding a CMS snapshot on the review surface requires registering
the snapshot as a renderable artifact type (before/after visual). That is the
explicit OPEN "CMS visual before/after" item owned by S6 / the connector lane /
#2013 — not the core capture writer. The core outcome proven here is that the
capture makes the snapshot a real, gate-able review target pinned on the run.

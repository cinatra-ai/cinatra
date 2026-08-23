# TIMELINE — `evidence/2791-s9g-conformance`, the #2945 re-shoot

Every timestamp below was read out of the lane's own store beside the pictures,
or off the record the shipped recorder wrote. Nothing here is a wall clock
somebody typed. All times UTC.

## What the store says happened, before any picture was taken

| Store row | Timestamp |
|---|---|
| the run the reviewed artifact was produced under (`agent_runs`) | `2026-08-23 16:58:13.429688+00` |
| the review gate the shipped sweep minted (`artifact_review_gates`) | `2026-08-23 16:58:39.328792+00` |
| the successor gate `submitRepairResponse` pinned (`artifact_review_gates`) | `2026-08-23 16:58:53.740876+00` |
| **the advisory the AUDIT lane attached** (`gate_advisory_comments`, `author_id: core-analysis-lane`, `author_kind: service`) | `2026-08-23 16:58:54.015619+00` |
| the verification record the repair's own trigger wrote (`artifact_verification_records`, `outcome: "drifted"`) | `2026-08-23 16:58:54.018413+00` |

The advisory lands **three milliseconds before** the verification record, which
is the order the code has: the verification write runs the audit lane first and
then inserts its row. Both are written by the pipeline; this round wrote neither.

## When each picture was taken

| Cell | `capturedAt` (the recorder's own) | sha256 |
|---|---|---|
| `G5__audit-card__run_card__advisory` | `2026-08-23T17:10:30.913Z` | `1345f9a79f0020df04c0c49fdbd867a019f30af3376aff53f9c7c462a853228b` |
| `G6__audit-card__page_gate_region__advisory` | `2026-08-23T17:10:50.805Z` | `d600c90b9692179cd4669211936fa12f5d464fbd83184dd58216ea6da719e1c7` |

Twenty seconds apart, on the same advisory and the same verification record, from
two different hosts — which is what "one core renderer, the page composes around
it" is supposed to look like from outside.

## What produced them

`evidence/2945-audit-label/` — the walk, the recorder and the grading table.

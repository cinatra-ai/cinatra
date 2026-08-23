# TIMELINE — `evidence/2852-before-after`, the #2945 re-shoot

Every timestamp below was read out of the lane's own store beside the pictures,
or off the record the shipped recorder wrote. Nothing here is a wall clock
somebody typed. All times UTC.

## What the store says happened, before any picture was taken

| Store row | Timestamp |
|---|---|
| the run the artifact was produced under (`agent_runs`) | `2026-08-23 16:57:22.927998+00` |
| the review gate the app's own orchestration drain minted (`artifact_review_gates`) | `2026-08-23 16:57:45.960652+00` |
| the frozen suggestion snapshot the shipped producer wrote (`gate_suggestion_snapshots`, 3 suggestions) | `2026-08-23 16:58:07.323659+00` |

That gate is `pending` and undecided in every one of the four pictures below —
read back at the end of the walk as `status: "pending"`, `disposition: null`.

## When each picture was taken

| Cell | `capturedAt` (the recorder's own) | sha256 |
|---|---|---|
| `B3__review-card__chat_thread__pending` | `2026-08-23T17:22:32.431Z` | `591a968bfbb9f14edd031721fc964cee3ebb7cfdd6e696c9fc1480e9e4ef3ce0` |
| `B4__review-card__chat_thread__pending` | `2026-08-23T17:15:53.180Z` | `c51311adb1965caa09c41216afb1db32354836e7a2d256942f1b6549802e0e21` |
| `B1__review-card__page_gate_region__pending` | `2026-08-23T17:25:37.396Z` | `907d297eeda19ba0e9698da5b0a53be254aa5f17e7a112de5ebd307765eefd46` |
| `B2__review-card__page_gate_region__pending` | `2026-08-23T17:26:10.882Z` | `43c7d686735dfba5eb8657c2cd1eed025a4c9d3a09d2f40abe4156a7f01724e5` |

**The order is not the cell order, and that is worth saying rather than hiding.**
B4 was shot first of the pair on the transcript host: the round's first attempt
at B3 sent no turn at all, because the browser typed into the chat composer
before the client had attached to it, and the driver now waits for that
(`hydrateMs`) instead of assuming it. B1 and B2 were then re-taken last so the
card would be photographed with its target island resolved rather than with the
island's placeholder. Every one of the four is a single uninterrupted
open→settle→measure→shoot→measure, and none of them was assembled from another.

The gate, the suggestions and the run are the SAME ones in all four pictures —
the two hosts are two views of one gate, which is the thing this directory
exists to show.

## What produced them

`evidence/2945-audit-label/` — the walk, the recorder and the grading table.

# The records the shipped recorder wrote, and the counts it observed

Every row below was produced by `observeWalkCell` (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`)
AT THE SHUTTER, against the live page, and validated by `validateCaptureRecord` before it was
kept. The full records — final URL, `capturedAt`, the pinned card instance and its attributes —
are in `capture-records.json`.

**The recorder refused nothing.** Eight records were driven and eight were admitted; that is the
count that was got, not the count that was wanted.

They were merged into the canonical index through the shipped `mergeWalkRecords`:
**105 → 113 records, the shipped validator accepts all 113** (`drivers/05-register-records.mjs`).

The anchor digest was printed before the merge and after it and is the same value both times —
`fa31fa2f1e73b545ba42e923636af4e4ac6025d623b6c5fdcc68d32342994d46`, recorded == recomputed. A
record is not one of the digest's three inputs, and this round changed none of them.

| cell | state | sha256 (of the picture) | the anchors the recorder counted, `count/visible` |
| --- | --- | --- | --- |
| `P1__recommendation-card__run_card__held__rail-step__light` | `pending` | `d907c815ee62d417…` | `[data-lifecycle-card-host="run_card"]` frame present 1/1; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-skill-action="confirm"]` root present 4/4; `[data-skill-action="adjust"]` root present 4/4; `[data-skill-action="skip"]` root present 4/4; `[data-lifecycle-card-host="run_card"]` root present 1/1 |
| `P1__recommendation-card__run_card__held__rail-step__dark` | `pending` | `b27fa1d1f6ac89bc…` | `[data-lifecycle-card-host="run_card"]` frame present 1/1; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-skill-action="confirm"]` root present 4/4; `[data-skill-action="adjust"]` root present 4/4; `[data-skill-action="skip"]` root present 4/4; `[data-lifecycle-card-host="run_card"]` root present 1/1 |
| `P2__recommendation-card__run_card__decided__setup-gate__light` | `decided` | `dec1d55de490eb81…` | `[data-lifecycle-card-host="run_card"]` frame present 2/2; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-lifecycle-card-state]` root present 1/1; `[data-lifecycle-card-host="run_card"]` root present 1/1; `[data-skill-action="confirm"]` root absent 0/0; `[data-skill-action="adjust"]` root absent 0/0; `[data-skill-action="skip"]` root absent 0/0 |
| `P2__recommendation-card__run_card__decided__setup-gate__dark` | `decided` | `4899c130ec151887…` | `[data-lifecycle-card-host="run_card"]` frame present 2/2; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-lifecycle-card-state]` root present 1/1; `[data-lifecycle-card-host="run_card"]` root present 1/1; `[data-skill-action="confirm"]` root absent 0/0; `[data-skill-action="adjust"]` root absent 0/0; `[data-skill-action="skip"]` root absent 0/0 |
| `P4__recommendation-card__run_card__decided__scheduling__light` | `decided` | `20a89188f54e6e14…` | `[data-lifecycle-card-host="run_card"]` frame present 1/1; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-lifecycle-card-state]` root present 1/1; `[data-lifecycle-card-host="run_card"]` root present 1/1; `[data-skill-action="confirm"]` root absent 0/0; `[data-skill-action="adjust"]` root absent 0/0; `[data-skill-action="skip"]` root absent 0/0 |
| `P4__recommendation-card__run_card__decided__scheduling__dark` | `decided` | `16613933155fcbf8…` | `[data-lifecycle-card-host="run_card"]` frame present 1/1; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-lifecycle-card-state]` root present 1/1; `[data-lifecycle-card-host="run_card"]` root present 1/1; `[data-skill-action="confirm"]` root absent 0/0; `[data-skill-action="adjust"]` root absent 0/0; `[data-skill-action="skip"]` root absent 0/0 |
| `P3__recommendation-card__run_card__decided__awaiting-decision__light` | `decided` | `c1dcc289b8de9345…` | `[data-lifecycle-card-host="run_card"]` frame present 2/2; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-lifecycle-card-state]` root present 1/1; `[data-lifecycle-card-host="run_card"]` root present 1/1; `[data-skill-action="confirm"]` root absent 0/0; `[data-skill-action="adjust"]` root absent 0/0; `[data-skill-action="skip"]` root absent 0/0 |
| `P3__recommendation-card__run_card__decided__awaiting-decision__dark` | `decided` | `f5f76a746f5f1817…` | `[data-lifecycle-card-host="run_card"]` frame present 2/2; `[data-lifecycle-card="recommendation_hold"]` frame present 1/1; `[data-lifecycle-card-state]` root present 1/1; `[data-lifecycle-card-host="run_card"]` root present 1/1; `[data-skill-action="confirm"]` root absent 0/0; `[data-skill-action="adjust"]` root absent 0/0; `[data-skill-action="skip"]` root absent 0/0 |

## What the two required sets mean here

A `pending` record of `recommendation_hold` owes the card's host declaration and its root in the
frame, and at least one of the three per-chip affordances counted INSIDE that root. Both P1
frames carry all three, four of each — one per chip — which is §V's *"each carrying its own
Confirm, Adjust and Skip"* counted rather than asserted.

A `decided` record owes the host declaration, the root, the card's own
`[data-lifecycle-card-state]` inside the root, and the ABSENCE of all three affordances inside
it. All six settled frames carry `0/0` on each of the three, which is §V's *"there is nothing
left to press"* counted rather than asserted.

`[data-lifecycle-card-host="run_card"]` reads **2** in the frame at the setup-gate and review
moments and **1** at the schedule moment. The second one is the OTHER card on the page — the
agent's HITL screen at the setup moment, the review gate at the review moment — each declaring
the same host it is drawn on. It is not a second recommendation row: the recommendation root
itself is counted separately and is **1** on every frame, at the frame scope and inside its own
root.

## The reading the contract does not ask for, and this round made anyway

The contract's required set says nothing about `[data-run-progress-panel]` or
`[data-run-detail-column]` — those are #3047's own ancestor assertions, and they were read off
the same live DOM immediately before each shutter and are recorded in `run-walk.json` per frame
(`observed.roots[].insideRunDetailColumn`, `.insideRunReviewSlot`, `.insideRunProgressPanel`,
and the frame-wide `rootsInsideProgressPanel` / `rootsInsideReviewSlot`). The table in
`README.md` is those readings.

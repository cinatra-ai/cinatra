# S9d rework — evidence (cinatra#2788, PR #2939 round 2)

The maintainer rejected round 1 on four readings. What each one became:

1. **"close ups of the card, but I cannot tell the surrounding"** — every capture
   here is the FULL BROWSER WINDOW at 1440x900, device scale 2 (2880x1800 px),
   taken with no clip, no element handle and no `fullPage`. The left navigation,
   the breadcrumb, both conversation turns and the composer are visible in every
   chat cell; the run page's tab bar and run-progress panel are visible in C3.
2. **"must be a fake and can't be from a real run"** — there is no seeded
   transcript and no hand-minted token in this round. See `TIMELINE.md`.
3. **the summary box, the held-steps block and the "Armed ·" line** — removed
   from the card on every host, so no host can draw them.
4. **the two control labels** — `Cancel trigger` -> `Cancel schedule`,
   `Release now` -> `Run now`, with `data-action` ids unchanged, and the confirm
   dialogs reworded to say "schedule".

## Cells

| cell | what | themes |
|---|---|---|
| C1 | the chat conversation, card before Confirm | light, dark |
| C2 | the chat conversation, same card after Confirm | light, dark |
| C3 | the run page, schedule step open | light, dark |
| C4 | the review page with this run's real output | **DROPPED — see TIMELINE.md** |
| C5 | the expired reading, after a real 30 minutes | light, dark |

## What is still owed on this round

- **The capture index is NOT updated.** `scripts/ci/chat-hitl-capture-index.json`
  still carries the ten round-1 records, including the two named `standin`. The
  new captures are NOT indexed, because an index record carries recorder-produced
  assertions and a sha256 that the capture-record contract checks, and writing
  those by hand would be inventing evidence rather than recording it. The walk
  that produced these captures has to be wired into
  `scripts/audit/lib/chat-hitl-capture-recorder.mjs` first.
- C4 needs a lane that may hold a model-provider credential.

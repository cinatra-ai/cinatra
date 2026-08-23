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

- **These eight pictures are still UNRECORDED, and the index no longer pretends
  otherwise.** `scripts/ci/chat-hitl-capture-index.json` used to carry the ten
  round-1 records — including the two named `standin` — describing a card the
  rework has since redrawn. All ten are retired from the index in this commit.
  The eight round-2 captures are NOT registered in their place, and they cannot
  be: an index record's assertions are counts the recorder took on the screen the
  picture shows, and this round drove its own Playwright file, so it never
  counted `[data-conversation-list]`, never counted anything inside the card
  root, and never measured a painted count. Writing those numbers by hand would
  be inventing observations. So the S9d cells are honestly UNBOUND until the walk
  is driven again through the recorder.
- **The walk is now executable.** `capture-walk.json` in this directory is the
  same path — state the schedule in `/chat`, follow it into dark, press Confirm,
  open the run page's schedule step with a real press, let the shipped
  30-minute window run out, reopen the expired thread — written as a plan the
  capture driver runs, with the eight cells it produces and the ten it retires
  named in it. Drive it with
  `node scripts/audit/lib/chat-hitl-capture-driver.mjs --walk evidence/2788-s9d-rework/capture-walk.json --steps <ids>`
  on a lane with the app up; every record is validated at the audit tier before
  anything is written, and the run merges into the index instead of replacing it.
- C4 needs a lane that may hold a model-provider credential.

## Owed elsewhere: six cells the Audit relabel left with old pixels

The **do not shoot here — a UI lane owns these** list. cinatra#2945 (merged)
relabelled the audit lane **Core analysis → Audit** everywhere a person can see
it, and six committed captures still show the retired word, so six index records
now describe text the product does not draw. **B1–B4** in
`evidence/2852-before-after/captures` photograph the review card's chip row and
its decision floor, whose heading `review-gate-card.tsx` changed from
`Core analysis · Suggestions` to `Audit · Suggestions`; **G5** and **G6** in
`evidence/2791-s9g-conformance/captures` photograph the audit card itself on the
run page and on the review page, whose heading `verification-summary-card.tsx`
changed from `Core analysis` to `Audit` and whose rail entry in
`run-step-rail.ts` changed with it. The re-shoot is a pixels-only round on a lane
with a browser: reach the same four surfaces the two rounds already reached
(B1 / B2 the page gate region and B3 / B4 a real transcript, on one run with
every suggestion accepted and then one chip dismissed; G5 the run page and G6 the
review page's verification view on an advisory audit), take each capture the way
its round took it, and re-record all six through
`scripts/audit/lib/chat-hitl-capture-driver.mjs` so the six index records are
replaced by measurements of the new pixels rather than edited in place — the
anchors these cells are graded on did not move, only the word on them did, so a
record whose hash still matches the old image is the only thing standing between
the index and the truth. Nothing about these six is fixed by this commit, and
nothing here should be re-shot from this lane: it has no browser.

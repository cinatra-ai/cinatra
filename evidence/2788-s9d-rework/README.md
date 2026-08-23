# S9d rework — evidence (cinatra#2788, PR #2939)

## Round 3 — what the maintainer rejected, and what the proof set is now

Round 2's run-page cell (C3) showed a composition the plan does not contain: the
schedule's configuration opened **inside the rail column, under its own row**,
with the **agentic run progress** card drawn beside it on a run that had never
executed. Two rulings followed, and both are now in plan (A):

1. §7.2 step 5 / §7.4 step 7 — "open that step to see the configuration or change
   it — **it opens to the right of the steps, never directly under a step, and no
   agentic run progress card is shown with it**."
2. "It makes absolutely no sense to show the agentic run progress card here" —
   the agent has not run; there is no progress to show.

The ratified drawing says the same thing about the surface these cells
photograph (`images/lifecycle-screens/design-run-surface-rail-and-gate.png`):
"a **step rail** down the left names the run's ordered steps, and the **run
detail** on the right shows the selected step … Selecting a step opens it on the
right … right here in the run detail, under the same rail, never as a standalone
document."

So the code changed (the schedule row is a rail ENTRY; its surface opens in the
run-detail column; a run with no execution record draws no progress section and
opens on the schedule step) and the proof set changed with it: the schedule is
now walked through its **three stages on both page hosts**, which is what a
reader has to be able to see.

## Cells

`capture-walk.json` is the executable plan. Every cell is **light + dark**, the
**full browser window**, one real run, and — where the cell is a record — counted
off the live page by the recorder.

| cell | stage | host | what the picture must show | record |
|---|---|---|---|---|
| C1 | first shown | chat | the stated one-off, rows editable, **Confirm** | owed (capture pending) |
| C2 | configured, not run | chat | the SAME card after Confirm: same rows, **Save changes** | owed (capture pending) |
| C6 | ran | chat | the same card after the one-off fired; Save changes no longer offered | owed (capture pending) |
| C7 | first shown | run page | the run's own scheduling step — "When should this run?", the three rows, **Continue** (§7.4 today, step 4) | **owed, and not a record — see below** |
| C3 | configured, not run | run page | the rail on the LEFT with **Schedule** selected, the form in the run detail on the RIGHT, **no agentic run progress card anywhere in the window** | owed (capture pending) |
| C8 | ran | run page | the run's steps in the run detail, the schedule step still listed in the rail | **owed, and not a record — see below** |
| C5 | expired (extra) | chat | still visible, still editable, **Confirm** alone on the floor | registered (round 2) |
| C4 | — | review page | this run's real artifact review | DROPPED — see `TIMELINE.md` |

The two round 2's **C3** records were deleted from
`scripts/ci/chat-hitl-capture-index.json` (56 records → 54) together with their
two images: they photograph the rejected composition, and a record that
describes pixels the product no longer draws is worse than no record. Nothing
was edited in place and no record was hand-written — the index is
recorder-measured only, and the next walk writes the new ones.

C1/C2 keep their round 2 records for now. The next walk **re-shoots** them,
because the stated schedule is now a ONE-OFF (the "ran" stage is the card after a
one-off has fired), so their pictures will change even though their cell names do
not.

## The two cells this index cannot hold, stated rather than fudged

C7 and C8 are real screens and are owed as pictures, but neither can be an honest
**record** here. Every record in `scripts/ci/chat-hitl-capture-index.json`
asserts `[data-lifecycle-card-host="<host>"]` on the screen it photographs —
`requiredAssertionsFor` in `scripts/ci/lib/capture-record-contract.mjs` requires
it with or without a card kind — and:

- **C7** is the run's SETUP scheduling step, the shipped trigger screen
  (`packages/agents/src/trigger-screen-client.tsx`). It draws no lifecycle card.
- **C8** is the run detail after the fire, where the schedule is a rail **row**
  and its surface is not drawn. No card on the screen either.

The walk still drives to both — that is how the run is armed and how it is fired
— and declares no cell on them (`setup-scheduling-step`, `fire-the-schedule`), so
`--walk` produces four of the six stage cells (plus C5) and not six. Both C7 and
C8 are owed in light AND dark, taken outside the recorder.
Giving either screen an anchor for the recorder to count would mean drawing
something the plan and the drawing do not define, and making the index accept a
card-less record would change the anti-fraud contract S9h owns. **Open question
for the maintainer: how the two run-page stage pictures should be filed.**

## Red first

`RED-FIRST.md` carries round 3's table: the four DOM facts of the reworked
composition, and the run-detail predicates, were written before the component was
touched and failed against `2ba505904` for the stated reasons.

## What is still owed on this round

- Every cell above marked *owed*: a lane with a browser drives
  `scripts/audit/lib/chat-hitl-capture-driver.mjs --walk` over
  `capture-walk.json` in its three passes (see the plan's note) and merges the
  records.
- C7 / C8: the two pictures, and the maintainer's answer on how they are filed.
- C4 needs a lane that may hold a model-provider credential. See `TIMELINE.md`.

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
the index and the truth. Nothing about these six is fixed by this commit.

## Round 2, kept for the record

Round 2 walked the same path through the recorder and merged eight records
(48 → 56). Its four answers to round 1 still stand and are not re-litigated here:
full-window framing declared per cell and written into every record; no seeded
transcript and no hand-minted token; the summary box, the held-steps block and
the "Armed ·" line removed from the card on every host; and the two control
labels — `Cancel trigger` → **Cancel schedule**, `Release now` → **Run now**,
`data-action` ids unchanged. Plan (A) §7.2 now names those two controls itself,
so the open deviation round 2 recorded against that sentence is closed.

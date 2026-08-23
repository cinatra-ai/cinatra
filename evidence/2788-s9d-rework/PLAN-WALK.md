# PLAN-WALK — the current page, quoted verbatim

Every `PLAN>` line below is a verbatim sentence of
`PLAN:-Agents-Lifecycle-(A).md` **as the page stands today** — wiki head
`4ef0a4f`, whose own last change to this page is `87a287c` — and each was
grep-verified against that file rather than retyped from memory.

Every `DRAWING>` line names the ratified drawing the cell is graded against, and
the `DRAWING-CHECK>` line under it states what that drawing requires, what the
picture shows, and the verdict. **Round 3 has taken no captures**: the
composition changed after the maintainer's two rulings, so every `shows` and
every `verdict` below is `owed (capture pending)` until a lane with a browser
walks `capture-walk.json`. A verdict is written when the pixels have been looked
at, never before.

The cell readings, once written, are the RECORDER's and not a reader's summary:
every count comes from the record the picture is filed with in
`scripts/ci/chat-hitl-capture-index.json`, written by
`scripts/audit/lib/chat-hitl-capture-driver.mjs --walk`.

## The cells

CELL: C1 — first shown, in the conversation
  (light `S9d-C1__schedule-card__chat_thread__pending`, dark `…__dark`)
  requires: the stated one-off, the three option rows editable, and Confirm alone on the floor
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the assistant's turn carrying the stated schedule over the option
    rows, the chosen row owning its fields, the estimated duration, and the floor
    · shows: owed (capture pending) · verdict: owed (capture pending)

CELL: C2 — configured, not run, in the conversation
  (light `S9d-C2__schedule-card__chat_thread__decided`, dark `…__dark`)
  requires: the SAME card in the SAME place after Confirm: the same rows, Save changes, no status label, no summary box
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: one card, not two — the same rows in the same place, with the
    settled floor · shows: owed (capture pending) · verdict: owed (capture pending)

CELL: C6 — ran, in the conversation
  (light `S9d-C6__schedule-card__chat_thread__decided__after-fire`, dark `…__dark`)
  requires: the same card in the same conversation after the one-off fired, with Save changes no longer offered
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the same card, still in its place in the thread, reading the
    schedule it armed · shows: owed (capture pending) · verdict: owed (capture pending)

CELL: C7 — first shown, on the run page
  (NO CELL IN THE WALK, and no record: this screen draws no lifecycle card, so the
  recorder cannot measure it — the light and dark pictures are owed outside this
  index, and how they are filed is the open question in README.md)
  requires: the run's own scheduling step — "When should this run?", the three option rows, Estimated run duration, Continue
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: the run surface's two-column frame around it · shows: owed
    (capture pending) · verdict: owed (capture pending)

CELL: C3 — configured, not run, on the run page
  (light `S9d-C3__schedule-card__run_card__decided`, dark `…__dark`)
  requires: the step rail on the LEFT with Schedule selected, the form in the run detail on the RIGHT with Save changes / Cancel schedule / Run now, nothing under the rail row, and NO agentic run progress card anywhere in the window
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: "a step rail down the left names the run's ordered steps, and the
    run detail on the right shows the selected step … Selecting a step opens it on the
    right … right here in the run detail, under the same rail, never as a standalone
    document" · shows: owed (capture pending) · verdict: owed (capture pending)

CELL: C8 — ran, on the run page
  (NO CELL IN THE WALK, and no record: the schedule is a rail ROW on this screen and
  its surface is not drawn, so there is no card for the recorder to measure — the
  light and dark pictures are owed outside this index, and how they are filed is the
  open question in README.md)
  requires: the run's steps in the run detail, the schedule step still listed in the rail
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: the same two-column frame, the rail carrying the run's whole
    lifecycle "at a glance, not just its live tip" · shows: owed (capture pending)
    · verdict: owed (capture pending)

CELL: C5 — expired (extra cell)
  (light `S9d-C5__schedule-card__chat_thread__pending__expired`, dark `…__dark`)
  requires: the expired reading, reached by letting the shipped 30-minute window actually run out: still visible, still editable, Confirm offered and nothing else on the floor
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the same card and the same floor the live proposal has · shows:
    host=chat_thread on the chat URL class, one card instance, state=pending;
    [data-conversation-list]=1 visible, card root=1 visible,
    [data-action="confirm-schedule-proposal"]=1 visible inside the card root (round 2's
    record, re-shot by the next walk) · verdict: owed (capture pending)

CELL: C4 — DROPPED and stated. See TIMELINE.md: a schedule decides WHEN the agent
  runs, and a review card exists only after it has run and produced something.
  Nothing was staged in its place and the walk plan carries no C4 step.

## The plan, sentence by sentence

PLAN> On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it — it opens to the right of the steps, never directly under a step, and no agentic run progress card is shown with it. The schedule is never drawn as a card among the review cards — a trigger decides *when* the agent runs, and a review card exists only after the agent has run and produced something — so the two can never appear together.
    THE SENTENCE THIS ROUND WAS REJECTED ON, and the one it is built to. The rail
    row is a row: the circle, the title, and the rail's own selected state, and
    nothing opens under it. The step's surface opens in the run-detail column
    beside the rail, on both pages — pinned as DOM in
    `packages/agents/src/__tests__/schedule-rail-step.test.tsx` (the form is a
    descendant of the run-detail column and NOT of the rail column) and, for the
    review page, in
    `src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/__tests__/review-schedule-step.test.tsx`
    (the schedule entry shows the form and not the review card, and the review
    entry shows the card and not the form — one region, never both). C3 is the
    picture. VERDICT: owed (capture pending).

PLAN> The schedule step on the run page and the review page shows the same form and nothing else — no summary box, no status label; its two controls are **Cancel schedule** and **Run now**.
    The sentence as the page now stands — it names the two controls itself, so
    round 2's open deviation against the old "…stay where they are today, on the
    run page's Trigger tab" wording is closed rather than carried. The step draws
    the form and its floor and nothing else; the two absences are pinned in
    `packages/agents/src/__tests__/schedule-proposal-card.test.tsx` ("NO status
    label — the word Armed is drawn on no host" and its siblings). C3 is the
    picture. VERDICT: owed (capture pending).

PLAN> No second card is drawn for the confirmed state: the same card, with the same option rows, shows the schedule as it stands — no label, no summary box; to change it you return to the card, change the rows and press **Save changes**, which re-arms the trigger.
    C2 is the same card in the same thread as C1 — same URL, one instance, the
    same option rows — with Save changes where Confirm stood and no second card
    beside it. VERDICT: owed (capture pending).

PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step. The floor is **Confirm**
    C1 draws the three rows with the chosen one owning its fields, and the floor
    is Confirm alone. No Adjust control exists to be drawn:
    `data-action="adjust-schedule-proposal"` is absent from the owner module.
    VERDICT: owed (capture pending).

PLAN> once a one-off has fired it cannot be changed; a change to a recurring schedule applies to its future runs.
    C6 is the conversation's card after the walk fired the one-off from the run
    page's schedule step: the same card, and Save changes no longer offered.
    VERDICT: owed (capture pending).

PLAN> **To actually set a schedule you use the run's scheduling step on the run page:** the question **"When should this run?"** over three option rows — **Run right after setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N week(s); On Sun–Sat; At HH:MM; Timezone) — then **Estimated run duration**, then **Continue**.
    §7.4 "Today", step 4 — the run page's FIRST-SHOWN stage, which this slice does
    not change. C7 is owed for it, so the three stages can be read side by side;
    the walk drives to the screen (`setup-scheduling-step`) and declares no cell,
    because the recorder cannot measure a screen that draws no card.
    VERDICT: owed (capture pending, outside this index).

PLAN> Nothing exists yet — the card expires on its own after 30 minutes if you do nothing, and an expired card **stays visible**, still editable, with **Confirm** to set the schedule again.
    C5, after a real 30 minutes on the shipped clock. Round 2's record measured
    Confirm visible inside the card root on that screen; the next walk re-shoots
    it on this round's run. VERDICT: owed (capture pending).

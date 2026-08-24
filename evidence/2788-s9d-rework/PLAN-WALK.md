# PLAN-WALK — the current page, quoted verbatim

Every `PLAN>` line below is a verbatim sentence of
`PLAN:-Agents-Lifecycle-(A).md` **as the page stands today** — wiki head
`4ef0a4f`, whose own last change to this page is `87a287c` — and each was
grep-verified against that file rather than retyped from memory.

Every `DRAWING>` line names the ratified drawing the cell is graded against, and
the `DRAWING-CHECK>` line under it states what that drawing requires, what the
picture shows, and the verdict. **The captures are taken**, and every `shows` and
every `verdict` below was written after looking at the pixels of the named file,
never before and never from a selector count.

**ROUND 4 RE-SHOT C2 AND C6, and nothing else.** Round 3 recorded a FAIL on each
of them — C2 drew a supersede line over its rows, C6 drew a disabled **Save
changes** — and both are conformance failures the settled branch of the renderer
has since been fixed for. So the two cells were walked again, on their own new
run through the same recipe: the schedule stated in the chat, the rows ADJUSTED
on the card (the producer proposes a daily recurrence; the person chose *Schedule
for later* and put the instant in), Confirm, then the one-off left to come due on
its own tick. C1, C3, C5, C7 and C8 keep round 3's pixels: the fix touches only
the settled branch, so the pending card, the run page's step and the two page
controls did not move. C1 and C2 are therefore no longer two pictures of one
conversation — C1 is round 3's thread, C2 and C6 are round 4's — and the
"one card, in one place, before and after one press" reading is carried by C2's
own record (one card instance, one thread URL, Confirm gone) rather than by a
picture pair, and by the walk's own actions (one context, one page, one press
between the two steps). What the committed pixels alone show is narrower, and is
written that way in the cell below: ONE settled card in that conversation, Confirm
gone, Save changes in its place. `RUN-READBACK.md` and `TIMELINE.md` carry every
run.

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
    · shows: `C1__chat-first-shown__light.png` / `…__dark.png` — the navigation, the
    person's turn, the assistant's turn, then ONE card: "When should this run?" over
    three rows; **Schedule for later** is the chosen row and it alone owns Run at
    (`23.08.2026, 21:22`) and Timezone (`UTC`); the other two rows draw no fields;
    "Estimated run duration / Unavailable." under them; the floor carries **Confirm**
    and nothing else; the composer is in the window. Dark is the same reading on the
    dark ground, every label and both field values legible · verdict: **PASS**

CELL: C2 — configured, not run, in the conversation
  (light `S9d-C2__schedule-card__chat_thread__decided`, dark `…__dark`)
  requires: the SAME card in the SAME place after Confirm: the same rows, Save changes, no status label, no summary box
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: one card, not two — the same rows in the same place, with the
    settled floor · shows: `C2__chat-configured__light.png` / `…__dark.png` — the
    navigation, the person's turn, the assistant's turn, then ONE card: "When should
    this run?" over the three rows, **Schedule for later** chosen and alone owning
    Run at (`24.08.2026, 09:34`) and Timezone (`UTC`), both fields in the ENABLED
    style; "Estimated run duration / Unavailable."; and the floor carrying **Save
    changes** where Confirm stood, drawn dimmed because nothing has been edited yet —
    which is the changeable state's own reading, not a withdrawal. **NOTHING is drawn
    above the rows**: no supersede line, no status label, no summary box, no second
    card. Dark is the same reading on the dark ground, every label and both field
    values legible · verdict: **PASS**, including on the clause round 3 recorded a
    FAIL against. §7.2 asks the confirmed card to show "the schedule as it stands",
    and it does: the rows read back the schedule that was armed — `agent_run_triggers`
    `scheduled_at 2026-08-24 09:34:00+00`, `timezone UTC`, `cron_expression` NULL. The
    one-off in this picture was ADJUSTED on the card before Confirm (the producer
    proposes a daily recurrence; the person chose Schedule for later and stated the
    instant), so this is exactly the adjusted-then-confirmed reading the sentence
    governs, and the card no longer sends the reader to the run to find out what was
    set.

CELL: C6 — ran, in the conversation
  (light `S9d-C6__schedule-card__chat_thread__decided__after-fire`, dark `…__dark`)
  requires: the same card in the same conversation after the one-off fired — the rows read-only, showing what ran, and Save changes no longer offered
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the same card, still in its place in the thread, reading the
    schedule it armed · shows: `C6__chat-ran__light.png` / `…__dark.png` — the SAME card
    in the SAME conversation (same thread URL as C2, one card instance) after the
    one-off was released at `2026-08-24 09:34:00.088+00` on its own tick — by the
    release job, which the runtime named in its own log; see `RUN-READBACK.md` for why
    the stamp alone does not say who released. The same three rows
    in the same place as C2 photographed them, Schedule for later still chosen, and Run at `24.08.2026, 09:34`
    / Timezone `UTC` now drawn in the READ-ONLY style — greyed, no caret, the schedule
    the server holds rather than any local draft. "Estimated run duration /
    Unavailable." is the LAST thing in the card: there is **no floor at all** — no Save
    changes, no Cancel schedule, no Run now, not even the rule that used to divide
    them off — and no status line standing in for them; round 3's "Released — every
    held step is eligible now…" is gone with the controls it explained. Dark reads the
    same · verdict: **PASS** on both readings, where round 3 recorded a FAIL. The plan
    sentence ("once a one-off has fired it cannot be changed") holds, and this cell's
    own words ("Save changes no longer offered") now hold too: the pixels show the
    control ABSENT, not drawn-and-disabled. Nothing here measures whether a click would
    be refused, and no such claim is made — there is no control left to click.

CELL: C7 — first shown, on the run page
  (NO CELL IN THE WALK, and no record: this screen draws no lifecycle card, so the
  recorder cannot measure it — the light and dark pictures are owed outside this
  index, and how they are filed is the open question in README.md)
  requires: the run's own scheduling step — "When should this run?", the three option rows, Estimated run duration, Continue
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: the run surface's two-column frame around it · shows:
    `C7__run-setup-scheduling-step__light.png` / `…__dark.png` — the run's own Trigger
    step on a fresh, never-armed run: "When should this run?" over **Run right after
    setup** (chosen), **Schedule for later** (Run at, Timezone) and **Recurring**
    (Repeat every 1 week(s); On Sun–Sat; At 09:00; Timezone), then "Estimated run
    duration / Unavailable.", then **Continue**. The recorder counted
    `[data-lifecycle-card-host]` = 0 on this screen, which is why it holds no record ·
    verdict: **FAIL against the named drawing `design-run-surface-rail-and-gate.png`:
    this screen draws NO step rail and NO run-detail column
    (`run-step-rail-column` = 0, `data-run-detail-column` = 0, counted off the live
    page) — it is the setup wizard's own single-column page, so the drawing's
    two-column frame is simply not there. PASS against §7.4 step 4, the plan sentence
    this cell is owed for, which it matches field for field.** The slice does not touch
    this screen, so the failure is a standing gap between the drawing and the shipped
    setup wizard, not a regression this PR introduces — and it is reported as a FAIL
    rather than softened.

CELL: C3 — configured, not run, on the run page
  (light `S9d-C3__schedule-card__run_card__decided`, dark `…__dark`)
  requires: the step rail on the LEFT with Schedule selected, the form in the run detail on the RIGHT with Save changes / Cancel schedule / Run now, nothing under the rail row, and NO agentic run progress card anywhere in the window
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: "a step rail down the left names the run's ordered steps, and the
    run detail on the right shows the selected step … Selecting a step opens it on the
    right … right here in the run detail, under the same rail, never as a standalone
    document" · shows: `C3__run-page-configured__light.png` / `…__dark.png` — the step
    rail down the LEFT carrying one entry, "1 Schedule", selected; the schedule's form
    in the run detail on the RIGHT: "When should this run?", the three rows with
    Schedule for later chosen and owning `23.08.2026, 21:22` / `UTC`, "Estimated run
    duration / Unavailable.", and the floor **Save changes · Cancel schedule · Run
    now**. NOTHING is drawn under the rail row, and there is NO "Agentic Run Progress"
    section anywhere in the window — this run had not executed. Dark is the same
    composition on the dark ground. The contrast is the proof: the SAME run's detail
    after it executed (C8) DOES draw the progress card · verdict: **PASS**

CELL: C8 — ran, on the run page
  (NO CELL IN THE WALK, and no record: the schedule is a rail ROW on this screen and
  its surface is not drawn, so there is no card for the recorder to measure — the
  light and dark pictures are owed outside this index, and how they are filed is the
  open question in README.md)
  requires: the run's steps in the run detail, the schedule step still listed in the rail
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: the same two-column frame, the rail carrying the run's whole
    lifecycle "at a glance, not just its live tip" · shows:
    `C8__run-detail-after-fire__light.png` / `…__dark.png` — the same two-column frame:
    the rail on the LEFT now carries BOTH "1 Schedule" and the run's own "Step 1" with
    a completed check; the run detail on the RIGHT draws "Agentic Run Progress ·
    completed" with "Run complete — This run finished. Its output is in the run
    transcript below." and **Start new run**. The recorder counted
    `schedule-rail-step` = 1, `run-step-rail-column` = 1, `data-run-detail-column` = 1,
    `schedule-step-detail` = 0 (the schedule's surface is not drawn here) and
    `[data-lifecycle-card-host]` = 0, which is why it holds no record · verdict:
    **PASS**

CELL: C5 — expired (extra cell)
  (light `S9d-C5__schedule-card__chat_thread__pending__expired`, dark `…__dark`)
  requires: the expired reading, reached by letting the shipped 30-minute window actually run out: still visible, still editable, Confirm offered and nothing else on the floor
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the same card and the same floor the live proposal has · shows:
    host=chat_thread on the chat URL class, one card instance, state=pending;
    [data-conversation-list]=1 visible, card root=1 visible,
    [data-action="confirm-schedule-proposal"]=1 visible inside the card root; the
    pixels: `C5__chat-expired__light.png` / `…__dark.png`, taken 36 minutes after the proposal
    was minted, on a proposal nothing touched — "This schedule expired before it was
    confirmed. Nothing was scheduled — change it if you like, then confirm it again."
    over the three rows, all drawn in the ENABLED style with the chosen row owning its
    fields (Recurring, Repeat every 1 day(s), At 09:00, Timezone UTC — the assistant's
    own untouched proposal; nothing here measured whether a keystroke is accepted, and
    no such claim is made), and **Confirm**
    alone on the floor. The window is scrolled so the card's floor is centred, so the
    top of the person's turn is above the fold; the assistant's turn, the whole card
    and the composer are all in frame · verdict: **PASS**

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
    picture. VERDICT: **PASS** — C3 shows the rail entry on the left with nothing
    under it, the form in the run detail on the right, and no progress card in the
    window; C8 shows the same frame once the run HAS executed, with the progress
    card where the schedule's form was.

PLAN> The schedule step on the run page and the review page shows the same form and nothing else — no summary box, no status label; its two controls are **Cancel schedule** and **Run now**.
    The sentence as the page now stands — it names the two controls itself, so
    round 2's open deviation against the old "…stay where they are today, on the
    run page's Trigger tab" wording is closed rather than carried. The step draws
    the form and its floor and nothing else; the two absences are pinned in
    `packages/agents/src/__tests__/schedule-proposal-card.test.tsx` ("NO status
    label — the word Armed is drawn on no host" and its siblings). C3 is the
    picture. VERDICT: **PASS** — C3's step draws the form, "Estimated run duration"
    and the floor **Save changes · Cancel schedule · Run now**, and nothing else: no
    summary box, no status label, and the word "Armed" appears nowhere in the window.

PLAN> No second card is drawn for the confirmed state: the same card, with the same option rows, shows the schedule as it stands — no label, no summary box; to change it you return to the card, change the rows and press **Save changes**, which re-arms the trigger.
    C2 is the card in its thread after one press — one instance, the same option
    rows, Save changes where Confirm stood, and no second card beside it. The
    "after one press" half is the walk's (one context, one page, the click between
    two steps) and the record's (one card instance, one thread URL, Confirm absent
    from the card root); the picture itself shows the settled reading, not the
    transition.
    VERDICT: **PASS on every clause.** Round 3 recorded a FAIL here — an
    adjusted-then-confirmed card drew the shipped supersede line over its rows, so it
    declined to show the schedule as it stands and sent the reader to the run instead.
    The renderer's settled branch no longer draws it: `superseded` stays a resolver
    answer (Confirm still refuses on the same comparison) and stops being chrome, and
    the card re-opens on the settled rows with nothing over them. C2 is that picture,
    on an adjusted-then-confirmed one-off, in both themes.

PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step. The floor is **Confirm**
    C1 draws the three rows with the chosen one owning its fields, and the floor
    is Confirm alone. No Adjust control exists to be drawn:
    `data-action="adjust-schedule-proposal"` is absent from the owner module.
    VERDICT: **PASS** — C1 draws the three rows with only the chosen one owning its
    fields, the floor is Confirm alone, and no Adjust control is drawn. This round
    EXERCISED that sentence rather than only photographing it: the one-off in every
    picture is one the person put into the card's own Run at field before confirming.

PLAN> once a one-off has fired it cannot be changed; a change to a recurring schedule applies to its future runs.
    C6 is the conversation's card after the one-off fired on the
    schedule's own tick: the same card, and Save changes no longer offered.
    VERDICT: **PASS on the plan sentence and on this cell's own wording.** The one-off
    was released at `released_at 2026-08-24 09:34:00.088+00` — 88 ms after the second
    the person stated — by the release job, which the runtime named in its own log
    (`RUN-READBACK.md` sets out why the stamp alone does not say who released, since
    *Run now* writes the same one). C6 is the conversation's card
    afterwards: the rows read-only on the server's schedule, and NO floor at all. Round
    3 recorded a FAIL here, because the fired card still drew Save changes in the
    disabled style; **Save changes** is defined for the changeable state only, so a
    fired one-off now withdraws the whole floor rather than offering a control that
    exists to refuse. Firing is read from `released` — the stamp the release job
    writes — never from a clock, so a one-off whose moment has passed while its gate is
    still shut keeps the floor it always had.

PLAN> **To actually set a schedule you use the run's scheduling step on the run page:** the question **"When should this run?"** over three option rows — **Run right after setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N week(s); On Sun–Sat; At HH:MM; Timezone) — then **Estimated run duration**, then **Continue**.
    §7.4 "Today", step 4 — the run page's FIRST-SHOWN stage, which this slice does
    not change. C7 is owed for it, so the three stages can be read side by side;
    the walk drives to the screen (`setup-scheduling-step`) and declares no cell,
    because the recorder cannot measure a screen that draws no card.
    VERDICT: **PASS on this sentence, FAIL against the drawing.** C7 draws the
    question, the three option rows with exactly the fields the sentence lists,
    Estimated run duration and Continue — and no step rail and no run-detail column, so
    it does not match `design-run-surface-rail-and-gate.png`. It is filed as a PAGE
    CONTROL (photographed, counted, hashed, no index record).

PLAN> Nothing exists yet — the card expires on its own after 30 minutes if you do nothing, and an expired card **stays visible**, still editable, with **Confirm** to set the schedule again.
    C5, after a real 30 minutes on the shipped clock. Round 2's record measured
    Confirm visible inside the card root on that screen; this round re-shot it on a
    proposal of its own. VERDICT: **PASS** — 30 minutes of the shipped clock really
    elapsed (minted 20:46:47Z, shot 21:22:59Z), the card is still visible, its rows are
    still drawn in the enabled style and Confirm is still on the floor.

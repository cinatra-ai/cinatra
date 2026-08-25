# PLAN-WALK — the current page, quoted verbatim

Every `PLAN>` line below is a verbatim sentence of
`PLAN:-Agents-Lifecycle-(A).md` **as the page stands today** — wiki head
`ba8a97b`, whose own last change to this page is `87a287c` — and each was
grep-verified against that file rather than retyped from memory.

Every `DRAWING>` line names the ratified drawing the cell is graded against, and
the `DRAWING-CHECK>` line under it states what that drawing requires, what the
picture shows, and the verdict. **The captures are taken**, and every `shows` and
every `verdict` below was written after looking at the pixels of the named file,
never before and never from a selector count.

**ROUND 5 RE-SHOT ALL FOURTEEN PICTURES, ON A CHAIN WITH NOTHING STOOD IN.**
Rounds 3 and 4 had to report that the assistant's own turn came from the
deterministic model bridge, and the rejected pictures said so in the assistant's
own words ("CINATRA_UAT_OK: deterministic chat reply"). That is gone. The
instance's public base URL is stated through the product's own tunnel tab
(`publicBaseUrlSource: manual`), the public `/api/mcp` ingress answers, and every
chat turn in every pictured chain ran on the REAL provider: the model read the
platform's tool catalogue as ONE provider-hosted MCP reference and called the
shipped producer `schedule_proposal_render` itself. The thread's own dispatch
part carries the provider's hosted-MCP call id (`mcp_0e1afcff…`, `serverLabel:
"cinatra"`) and the product-minted proposal ref. `CINATRA_TEST_LLM_PROVIDER` was
UNSET for the whole round and the scripted runtime served nothing — the server
log carries zero scripted-runtime lines.

**ONE RUN NOW CARRIES C1, C2, C3, C6 AND C8**, so the "one card, in one place,
before and after one press" reading is back in the committed pixels rather than
carried by prose: C1 and C2 are the same card in the same conversation before and
after one Confirm, C3 is that run's schedule step, C6 is that same card after the
one-off came due on its own tick, and C8 is that same run's detail afterwards.
C7 is a second, never-armed run, and it has to be — an armed run's setup
scheduling step is behind it. C5 rides on its own untouched proposal, whose
shipped 30-minute window was allowed to actually run out.

**THE ONE-OFF WAS NEVER RELEASED BY HAND.** No step in this round pressed *Run
now*; the walk plan contains no such action. The schedule came due on its own
tick and the runtime named the actor itself.

The cell readings, once written, are the RECORDER's and not a reader's summary:
every count comes from the record the picture is filed with in
`scripts/ci/chat-hitl-capture-index.json`, written by
`scripts/audit/lib/chat-hitl-capture-driver.mjs --walk`. C7 and C8 carry no index
record and say so — see README.md.

## The cells

CELL: C1 — first shown, in the conversation
  (light `S9d-C1__schedule-card__chat_thread__pending`, dark `…__dark`)
  requires: the stated one-off, the three option rows editable, and Confirm alone on the floor
  PLAN> "The card appears in the reply with the schedule you stated, its option rows
    editable, and **Confirm**."
  PLAN> "The option rows are editable as they stand: until you confirm, you change the
    schedule directly on the card — the rows are never locked behind a separate step.
    The floor is **Confirm**."
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the assistant's turn carrying the stated schedule over the option
    rows, the chosen row owning its fields, the estimated duration, and the floor
    · shows: `C1__chat-first-shown__light.png` / `…__dark.png` — the navigation, the
    person's turn ("Please schedule 74aed283-… to run once at 2026-08-24 17:42 in the
    UTC timezone."), the assistant's own answer in its own words ("Schedule proposal is
    ready. Please confirm it on the scheduling card in this conversation to arm the
    one-time run."), then ONE card: "When should this run?" over three rows;
    **Schedule for later** is the chosen row and it alone owns Run at
    (`24.08.2026, 17:42`) and Timezone (`UTC`), both in the ENABLED style; the other
    two rows draw no fields; "Estimated run duration / Unavailable." under them; the
    floor carries **Confirm** and nothing else; the composer is in the window. Dark is
    the same reading on the dark ground, every label and both field values legible
    · verdict: **PASS**

CELL: C2 — configured, not run, in the conversation
  (light `S9d-C2__schedule-card__chat_thread__decided`, dark `…__dark`)
  requires: the SAME card in the SAME place after Confirm: the same rows, Save changes, no status label, no summary box
  PLAN> "No second card is drawn for the confirmed state: the same card, with the same
    option rows, shows the schedule as it stands — no label, no summary box; to change
    it you return to the card, change the rows and press **Save changes**, which
    re-arms the trigger."
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: one card, not two — the same rows in the same place, with the
    settled floor · shows: `C2__chat-configured__light.png` / `…__dark.png` — the same
    window as C1, the same two conversation turns, and the SAME card: "When should this
    run?" over the three rows, **Schedule for later** chosen and alone owning Run at
    (`24.08.2026, 17:42`) and Timezone (`UTC`) in the ENABLED style; "Estimated run
    duration / Unavailable."; and the floor carrying **Save changes** where Confirm
    stood, drawn dimmed because nothing has been edited yet — the changeable state's
    own reading, not a withdrawal. **NOTHING is drawn above the rows**: no supersede
    line, no status label, no summary box, no second card. The recorder counted one
    card instance on one thread URL with `confirm-schedule-proposal` ABSENT. Dark is
    the same reading on the dark ground · verdict: **PASS**. C1 and C2 are the same
    conversation photographed before and after one press, so the pair itself carries
    the "one card, in one place" reading this round.

CELL: C3 — configured, not run, on the run page
  (light `S9d-C3__schedule-card__run_card__decided`, dark `…__dark`)
  requires: the step rail on the LEFT with Schedule selected, the form in the run detail on the RIGHT, nothing under the rail row, and NO agentic run progress card anywhere in the window
  PLAN> "On the run page and the review page the schedule is a **dedicated step in the
    step rail on the left, above \"1 Review\"**: open that step to see the configuration
    or change it — it opens to the right of the steps, never directly under a step, and
    no agentic run progress card is shown with it." (§7.2 step 5)
  PLAN> "On the run page and the review page the schedule is a dedicated step in the step
    rail on the left, above **1 Review** — open it to see or change the configuration;
    it opens to the right of the steps, never directly under a step, and no agentic run
    progress card is shown with it." (§7.4 step 7, as designed)
  PLAN> "It makes absolutely no sense to show the agentic run progress card here" — the
    agent has not run; there is no progress to show. (the ruling round 3 was redrawn to)
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: "a **step rail** down the left names the run's ordered steps,
    and the **run detail** on the right shows the selected step … Selecting a step opens
    it on the right … right here in the run detail, under the same rail, never as a
    standalone document." · shows: `C3__run-page-configured__light.png` / `…__dark.png` —
    the navigation, the agent's name and its Setup / Trigger / Permissions tabs, then TWO
    COLUMNS: the rail down the LEFT carrying **1 Schedule** as its own numbered entry,
    and the run detail on the RIGHT holding the schedule's whole surface — "When should
    this run?", the three rows with **Schedule for later** chosen and owning Run at
    (`24.08.2026, 17:42`) / Timezone (`UTC`), "Estimated run duration / Unavailable.",
    and the floor **Save changes · Cancel schedule · Run now**. NOTHING is drawn under
    the rail row, and there is **no agentic run progress card anywhere in the window** —
    this run had not executed when the picture was taken. Dark is the same reading on the
    dark ground · verdict: **PASS** — this is the composition round 2 failed and §7.2/§7.4
    were amended to name.

CELL: C5 — expired, in the conversation (the extra cell)
  (light `S9d-C5__schedule-card__chat_thread__pending__expired`, dark `…__dark`)
  requires: the expired reading — still visible, still editable, Confirm offered and nothing else on the floor
  PLAN> "the card expires on its own after 30 minutes if you do nothing, and an expired
    card **stays visible**, still editable, with **Confirm** to set the schedule again."
  PLAN> "**Do nothing for 30 minutes** and the card expires — the expired card **stays
    visible** and editable, with **Confirm** to set the schedule again."
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the same card, not a tombstone — the rows still there and still
    the person's, with the floor that lets them set it again · shows:
    `C5__chat-expired__light.png` / `…__dark.png` — the same two conversation turns, then
    the card carrying one added sentence above the rows, "This schedule expired before it
    was confirmed. Nothing was scheduled — change it if you like, then confirm it again.";
    under it the unchanged "When should this run?" over the three rows, **Schedule for
    later** chosen and owning Run at (`25.08.2026, 14:31`) / Timezone (`UTC`) in the
    ENABLED style; "Estimated run duration / Unavailable."; and **Confirm** alone on the
    floor. The window was reached after the shipped 30 minutes had actually elapsed
    (`PROPOSAL_TTL_SECONDS = 1800`; minted `17:21:12Z`-equivalent on its own thread at
    `14:51:53Z`, photographed `15:23:49Z`) — no clock was moved. Dark is the same reading
    on the dark ground · verdict: **PASS**

CELL: C6 — ran, in the conversation
  (light `S9d-C6__schedule-card__chat_thread__decided__after-fire`, dark `…__dark`)
  requires: the same card in the same conversation after the one-off fired — the same rows, and Save changes no longer offered
  PLAN> "once a one-off has fired it cannot be changed"
  DRAWING> design-schedule-card.png
  DRAWING-CHECK> requires: the card still standing on the schedule that ran, with nothing
    left to press · shows: `C6__chat-ran__light.png` / `…__dark.png` — the SAME window and
    the SAME two turns as C1 and C2, and the SAME card: "When should this run?" over the
    three rows, **Schedule for later** still chosen and still showing Run at
    (`24.08.2026, 17:42`) / Timezone (`UTC`) — now in the READ-ONLY style, the values
    visibly muted — and "Estimated run duration / Unavailable." **The floor is gone
    entirely**: no Save changes, no Cancel schedule, no Run now, and no status line
    standing in for them. The one-off had come due on its own tick
    (`agent_run_triggers.released_at 2026-08-24 17:42:00.143+00`, 143 ms after the second
    the person stated) and nothing in this round pressed *Run now*. Dark is the same
    reading on the dark ground · verdict: **PASS**

CELL: C7 — first shown, on the run page (PAGE CONTROL — no index record)
  (light `C7__run-setup-scheduling-step__light.png`, dark `…__dark.png`)
  requires: the run's own scheduling step — "When should this run?", the three rows, Continue
  PLAN> "**To actually set a schedule you use the run's scheduling step on the run page:**
    the question **\"When should this run?\"** over three option rows — **Run right after
    setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N
    week(s); On Sun–Sat; At HH:MM; Timezone) — then **Estimated run duration**, then
    **Continue**." (§7.4 step 4, today)
  PLAN> "An agentic run progress card is not visible while the recommended skills can be
    selected, because they are being chosen before the agent actually runs." (§6.2 step 2)
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: the two-column frame — "a **step rail** down the left names the
    run's ordered steps, and the **run detail** on the right shows the selected step"
    · shows: `C7__run-setup-scheduling-step__light.png` / `…__dark.png` — the shipped
    trigger screen on a run that has never been armed: "When should this run?" over the
    three rows with **Run right after setup** chosen, **Schedule for later** offering an
    empty Run at (`dd.mm.yyyy, --:--`) and Timezone (`Europe/Berlin`), **Recurring**
    offering Repeat every 1 week(s) / On Sun–Sat / At 09:00 / Timezone, then "Estimated
    run duration / Unavailable.", then **Continue**, with the prompt window beneath.
    The §6.2 clause holds and is measured: `[data-conformance-id="agentic-run-progress"]`
    counts **0** on this screen (`page-controls.json`) — no run progress card is drawn
    while the run has not run. But the drawing's frame is **absent**: this page draws
    NEITHER column — `run-step-rail-column` **0**, `run-detail-column` **0** — it is one
    centred single-column form. Dark is the same reading on the dark ground
    · verdict: **FAIL** on the named drawing's two-column clause, and it is reported
    rather than softened. It is **not a regression this PR introduces**: it is a standing
    gap between the drawing and the shipped setup wizard, which this slice does not touch.
    PASS on the §7.4-step-4 sentence and on the §6.2 progress-card clause.

CELL: C8 — ran, on the run page (PAGE CONTROL — no index record)
  (light `C8__run-detail-after-fire__light.png`, dark `…__dark.png`)
  requires: the run's steps in the run detail, the schedule step still listed in the rail
  PLAN> "Once you have decided each one, the run starts with your selection, the card
    settles in place showing what you chose, and the agentic run progress card appears;
    no skill inside it can be selected." (§6.4, as designed)
  PLAN> "The agentic run progress card appears once the skills are decided; no skill inside
    it can be selected." (§6.2 step 3)
  DRAWING> design-run-surface-rail-and-gate.png
  DRAWING-CHECK> requires: the rail on the left naming the run's ordered steps, the run
    detail on the right showing the selected step · shows:
    `C8__run-detail-after-fire__light.png` / `…__dark.png` — TWO COLUMNS: the rail down the
    LEFT still listing **1 Schedule** and, under it, **Step 1** marked done; the run
    detail on the RIGHT carrying **Agentic Run Progress** with the status chip
    **completed** and the panel "Run complete / This run finished. Its output is in the
    run transcript below." with **Start new run**. The schedule's own surface is NOT drawn
    here — `schedule-step-detail` counts **0** — the schedule is a rail ROW at this stage,
    which is why this screen carries no lifecycle card and no index record. The §6.2/§6.4
    clause holds: the progress card is drawn only now that the run has run, and **no skill
    inside it is selectable** — there is no chip and nothing to press but *Start new run*.
    Dark is the same reading on the dark ground · verdict: **PASS**

## What this round could not put in a picture

- **C4 stays dropped.** It asked for the review page carrying THIS run's real
  artifact review, and this run has none: a schedule decides WHEN the agent runs,
  and a review card exists only after the agent has run and produced something to
  review. A stand-in is never acceptable, so there is no C4 step in the walk to
  answer with the wrong screen. See `TIMELINE.md`.
- **C7's two-column FAIL** above is the one clause still failing, and it is a
  standing gap rather than a regression this PR introduces.

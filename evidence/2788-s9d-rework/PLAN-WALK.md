# PLAN-WALK — the current page, quoted verbatim

## ROUND 7 (2026-08-26) — every round 6 cell re-graded on the fixed head, and the three readings the fix defines

Round 6's four cells were shot BEFORE the change under review, and two of them had
to be graded FAIL. All four are re-shot here and re-graded, and three cells are
added. Every `shows` and every `verdict` below was written after looking at the
pixels of the named file.

### C7 — `captures/C7__run-setup-scheduling-step__{light,dark}.png`

`REQUIRES>` cinatra#2970 acceptance 1, verbatim: *"The first-time run page (setup
flow) renders the two-column layout: the rail on the left with the setup steps, the
selected step's surface on the right — measured on the real surface (rail count 1,
detail column 1)."* And the run-surface drawing's own clause: *"a step rail down the
left **names** the run's ordered steps, and the run detail on the right shows the
selected step … Selecting a step opens it on the right … never as a standalone
document."* Plus plan (A) §7.2 step 5: *"no agentic run progress card is shown with
it."*

`SHOWS>` One rail column and one detail column (`run-step-rail-column` **1**,
`run-detail-column` **1**, counted off the live page). Three rows on the rail,
numbered 1-2-3 in order and **named** — **1 Schedule**, **2 Recommendation**,
**3 Review** — with the schedule row's numeral the filled chip and the other two
muted. The scheduling form — "When should this run?", *Run right after setup* /
*Schedule for later* / *Recurring*, "Estimated run duration", **Continue** — is
drawn in the **right** column, never under a row
(`data-run-surface-selected-step="schedule"`, `detailColumnTextLength` **13137**).
No agentic run progress panel anywhere in the window
(`agentic-run-progress` **0**) and no lifecycle card at all
(`lifecycle-card-host` **0**). The run reads `pending_approval` / `started_at` NULL
/ `review_gates` **0** in the record's own `dbAt` block.

`VERDICT>` **PASS**, in both themes. The open / muted distinction survives the
theme, which is the thing a dark cell is shot to check. One blemish is visible and
is pre-existing, not this issue's: "Estimated run duration — Unavailable."

### C9 — `captures/C9__run-setup-continue-armed__{light,dark}.png`

`REQUIRES>` cinatra#2970 acceptance 2, second half, verbatim: *"Continue arms it
exactly as today."*

`SHOWS>` The **same run** as C7, after **Continue** was pressed on the form in the
detail column with *Schedule for later* and `2026-08-26 21:30` typed into the step's
own field. The page draws **Trigger configuration** — Type `scheduled`, Schedule
`Aug 26, 2026, 9:30:00 PM`, Timezone `Europe/Berlin` — "Steps held until trigger
fires", and **Cancel trigger**. The database agrees independently: one
`agent_run_triggers` row, `scheduled`, `2026-08-26 19:30:00+00`, `Europe/Berlin`,
enabled, `released_at` NULL.

`VERDICT>` **PASS.** C7 and C9 are one run with one press between them, so this is a
before-and-after of the press itself rather than two pictures of two runs. Two
consequences are stated rather than smoothed over: `pending_approval → armed` is not
a legal transition, so the trigger row was created while the STATUS stayed
`pending_approval`; and once a one-off is armed the run's page draws the **Trigger**
tab instead of the setup rail (`run-step-rail-column` **0** / `run-detail-column`
**0**), so the setup surface this issue is about is the one a run is on *before* its
schedule is armed.

### C10 — `captures/C10__run-setup-recommendation-step-opened__{light,dark}.png`

`REQUIRES>` cinatra#2970 acceptance 3, first half, verbatim: *"The
skills-recommendation step … open[s] the same way, to the right of the steps, never
under a row."* And this head's fix: *"the recommendation row opens exactly when the
run has a live hold (the hold card) … and is closed+muted otherwise"*, with the
ruling's *"the right column never shows an empty step surface."*

`SHOWS>` The **2 Recommendation** row reads `data-run-surface-rail-reached="true"`
and `data-action="open-recommendation-step"`; pressed, it takes the selection
(`data-run-surface-selected-step` goes `schedule` → `recommendation`, the numeral 2
becomes the filled chip) and the **right-hand column draws the shipped hold card** —
`[data-lifecycle-card="recommendation_hold"]` **1**, `data-lifecycle-card-host`
`run_card` **1**, the chip **Blog Content Skill** with **Confirm**, **Adjust** and
**Skip** beside it. `detailColumnTextLength` **35**, counted off the live page —
**not zero**. No agentic run progress panel (`agentic-run-progress` **0**). The run
holds a live `recommendation` park (`parked`) in its own rows at the shutter.

`VERDICT>` **PASS — on the clause round 6 had to fail.** Round 6's C10 read
`detailColumnTextLength` **0** and showed an empty right half of the screen; the
same anchor reads **35** here with the card in it, on the same screen through the
same reader. Both themes.

### C10b — `captures/C10b__run-setup-recommendation-row-closed__{light,dark}.png`

`REQUIRES>` the fix's other half — *"closed+muted otherwise"* — and the ruling on
this issue: *"A step the run has not reached cannot be selected. Its row stays on the
rail, muted; clicking it does nothing; the scheduler stays open; the right column
never shows an empty step surface."*

`SHOWS>` On a run with **no recommendation park at all**, row 2 reads
`data-run-surface-rail-reached="false"`, `aria-disabled="true"` and
`data-action="recommendation-step-unavailable"`, keeps its place and its numeral,
and is drawn muted. The press was delivered as a real mouse click (forced, because
`aria-disabled` makes Playwright's own actionability treat the row as not-enabled —
a row that is never pressed proves nothing). After it the selected step is still
`schedule`, the scheduling form is still in the detail column, and **the detail
column's DOM is byte-identical before and after** the press (`a83b8cd1f79e…` light,
`5320894b1fee…` dark, on both sides).

`VERDICT>` **PASS.** The row is legible and inert, and the column never goes blank.

### C10c — `captures/C10c__run-setup-recommendation-step-settled__{light,dark}.png`

`REQUIRES>` the fix's middle clause: *"the recommendation row opens exactly when the
run has a live hold (the hold card) **or a decided one (the settled row)**."*

`SHOWS>` The same run as C10, after **Confirm** was pressed on the card and the app
released the park itself (`lifecycle_continuation_park` `recommendation` /
`released`). Row 2 still opens, and the right column draws the settled reading of
the **same one renderer** — `Blog Content Skill ✓ CONFIRMED`, read-only, no
Confirm / Adjust / Skip. `[data-lifecycle-card="recommendation_hold"]` **1**,
`detailColumnTextLength` **27**.

`VERDICT>` **PASS.** A decided hold keeps its place and records how it was settled,
which is what §6.4 asks of the row.

### C11 — `captures/C11__run-setup-review-step-opened__{light,dark}.png`

`REQUIRES>` cinatra#2970 acceptance 3, second half, verbatim: *"the review step
open[s] the same way, to the right of the steps, never under a row."* And this head's
fix: *"the review row draws the run's review slot — … the review card once a gate is
on file."* Plan (A) §4.2.

`SHOWS>` On a run that ran to completion and whose artifact opened a gate, row 3
reads `data-run-surface-rail-reached="true"` and `data-action="open-review-step"`.
Pressed, it takes the selection and the right column draws
`[data-run-review-slot="review"]` with `[data-conformance-id="review-gate-card"]`
**1** inside it: **Review requested**, *Awaiting your decision*, the artifact
**Connector Rollout Note: What Changed This Week** tagged **Blog Post Artifact**
(`@cinatra-ai/blog-post-artifact:post`, revision `19fed4ea-13b…`, `text/markdown`),
a **Decision rationale** field and **Comment / Reject / Approve**.
`detailColumnTextLength` **124**, `review-gate-placeholder` **0**.

`VERDICT>` **PASS — the FAIL round 6 reported is gone.** Round 6's C11 could not be
opened at all: the step was composed `surface: null` for every run. Here it opens,
to the right of the steps, never under a row. One reading INSIDE the card is a lane
observation and is named rather than hidden: the card's content rung says *"review
target unavailable — slot 'detail', reason 'no-semantic-renderer'"* and falls back
to the generic read-only view of the artifact. That is the artifact type's renderer,
not the review step, and nothing here changes it.

### C11b — `captures/C11b__run-setup-review-step-working__{light,dark}.png`

`REQUIRES>` this head's fix: *"the placeholder with the spinning icon while the run
works."* Plan (A) §4.2, the maintainer's own words: *"a card (maybe even an empty
review screen) with a spinning icon which is a temporary placeholder for the review
screen."*

`SHOWS>` Pressed while the run's artifact has a PENDING `artifact_produced_outbox`
row and no gate yet, row 3 opens `[data-run-review-slot="working"]` with
`[data-conformance-id="review-gate-placeholder"]` **1** inside it and
`review-gate-card` **0**: the review screen's own frame, empty, with the spinning
icon at its head and the skeleton rows beneath. **Wordless by design**
(`detailColumnTextLength` **0**), so it is graded on its anchor and its spinner,
never on a text length.

`VERDICT>` **PASS.** The two themes come from two runs, and the reason is measured
rather than assumed: the window between the outbox row and the gate ran **25 s** on
one run and about **5 s** on another, which is shorter than two shutters. Each record
carries its own run id and shutter time.


## ROUND 6 (2026-08-26) — C7 re-graded, and the three cells cinatra#2970 adds

Round 5 had to grade C7 a FAIL. cinatra#2970 (PR #2975) rebuilt the screen it
photographs, so C7 was re-shot on this head and re-graded, and three cells were
added for the acceptance items C7 alone cannot answer. Every `shows` and every
`verdict` below was written after looking at the pixels of the named file.

### C7 — `captures/C7__run-setup-scheduling-step__{light,dark}.png`

`DRAWING> images/lifecycle-screens/design-run-surface-rail-and-gate.png` —
*"The surface is a two-column frame: a step rail down the left **names** the run's
ordered steps, and the run detail on the right shows the selected step … Selecting
a step opens it on the right … right here in the run detail, under the same rail,
never as a standalone document."*

`PLAN> §7.2 step 5` — *"open that step to see the configuration or change it — it
opens to the right of the steps, never directly under a step, and no agentic run
progress card is shown with it."*

`DRAWING-CHECK> requires` — two columns; the rail on the LEFT naming the run's
ordered steps; the selected step's surface on the RIGHT; nothing drawn under a
row; no agentic run progress card.

`DRAWING-CHECK> shows` — one rail column and one detail column
(`run-step-rail-column` 1, `run-detail-column` 1, counted off the live page
through the recorder's own reader). The rail carries three rows, numbered 1-2-3 in
order and NAMED: **1 Schedule**, **2 Recommendation**, **3 Review**. The schedule
step is the open one (`data-run-surface-selected-step="schedule"`; its numeral is
the filled chip, the other two muted) and the unchanged scheduling form — "When
should this run?", *Run right after setup* / *Schedule for later* / *Recurring*,
"Estimated run duration", **Continue** — is drawn in the RIGHT column, never under
a row. No agentic run progress panel anywhere in the window
(`agentic-run-progress` 0) and no lifecycle card at all (`lifecycle-card-host` 0).
The run reads `pending_approval` / `started_at: null` in each record's own `dbAt`
block, read at the shutter.

`DRAWING-CHECK> verdict` — **PASS, and it is the clause round 5 had to fail.**
The same anchors read 0 / 0 in round 5's record of this cell and read 1 / 1 here.
The rail also NAMES its steps, which no earlier picture of this screen has shown.
Dark carries the same reading: the same frame, the same three named rows, the same
open schedule step, and the muted/open distinction survives the theme.

### C9 — `captures/C9__run-setup-continue-armed__{light,dark}.png`

`ISSUE> cinatra#2970 acceptance 2` — *"The scheduler step inside it is the
unchanged scheduler form in its first-shown state; **Continue arms it exactly as
today**."*

`CHECK> requires` — that pressing Continue on the scheduler step, where it now sits
inside the run detail column, arms the trigger the way it did before the screen
changed.

`CHECK> shows` — the SAME run as C7, after Continue was pressed on the form in the
detail column with *Schedule for later* and `2026-08-26 21:30` typed into the
step's own field. The page draws **Trigger configuration** — Type `scheduled`,
Schedule `Aug 26, 2026, 9:30:00 PM`, Timezone `Europe/Berlin` — "Steps held until
trigger fires", and **Cancel trigger**. The database agrees and was read
independently: one `agent_run_triggers` row, `scheduled`, `2026-08-26 19:30:00+00`,
`Europe/Berlin`, enabled, `released_at` NULL, delayed job
`trigger-release-2b9859f8-…`, created `05:49:58.710`.

`CHECK> verdict` — **PASS.** C7 and C9 are one run with one press between them, so
this is a before/after of the press itself rather than two pictures of two runs.
One consequence is recorded rather than smoothed over: the run was at
`pending_approval`, and `pending_approval -> armed` is not a legal transition, so
the trigger row was created while the STATUS stayed `pending_approval`. That is
the same on this head as before it and nothing in cinatra#2970 touches it.

### C10 — `captures/C10__run-setup-recommendation-step-opened__{light,dark}.png`

`ISSUE> cinatra#2970 acceptance 3` — *"The skills-recommendation step and the review
step open the same way, to the right of the steps, never under a row."*

`RULING>` — *"…the right column never shows an empty step surface."*

`CHECK> requires` — pressing the recommendation row opens the skills-recommendation
step's own surface in the run detail, to the right of the rail.

`CHECK> shows` — the row takes the selection
(`data-run-surface-selected-step="recommendation"`, the numeral 2 becomes the
filled chip) and the right-hand column is **BLANK**: no card, no heading, no
control. `detailColumnTextLength` reads **0** off the live page and the picture
shows an empty right half of the screen. The step's surface is the one shipped
`RecommendationHoldCard`; with no live hold on this run it resolves to nothing and
renders no DOM.

`CHECK> verdict` — **FAIL, reported rather than softened.** The step is selected to
the right of the steps and never under a row, so the LAYOUT clause holds — but
"opens" is not met: there is nothing in the column. It is also the ruling's last
clause broken in one press. PR #2975's own text pins this residual in words ("a
started run with no live hold can therefore still open a step whose card resolves
to nothing"); this is that residual photographed. Not a regression this round
introduces, and not fixed here.

### C11 — `captures/C11__run-setup-review-row-pressed__{light,dark}.png`

`ISSUE> cinatra#2970 acceptance 3` — the review step's half of the same sentence.

`CHECK> requires` — pressing the review row opens the review step to the right of
the steps.

`CHECK> shows` — nothing happens. The press was delivered as a real mouse click
(forced, because the row carries `aria-disabled="true"` and Playwright's own
actionability would otherwise never deliver it — a row that is never pressed
proves nothing). After the press the selected step is still `schedule`, the
scheduling form is still in the detail column, and the row still reads
`data-run-surface-rail-reached="false"`,
`data-action="review-step-unavailable"`, no native `disabled`.

`CHECK> verdict` — **the RULING passes and the ACCEPTANCE ITEM fails, at the same
time.** The rail closes the row for every run on this screen, because the setup
page composes the review step with `surface: null` unconditionally, so the step
can never be opened here whatever the run has reached. Which of the two sentences
the screen should obey is a maintainer's call, and it is put on the pull request
as one.


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

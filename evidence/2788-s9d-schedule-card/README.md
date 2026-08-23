# §VI's schedule card, photographed against §7 as it now reads — cinatra#2788 (S9d)

Ten cells, on the running application, on this lane's own disposable stack. The
text each one is graded against is in `PLAN-WALK.md`; this file is the grading —
**requires / shows / verdict**, written by looking at each picture.

**What is real.** The pages are the shipped `/chat` transcript, the shipped run
detail and the shipped review page. The card is the shipped
`ScheduleProposalCard`, reached through the shipped registry dispatch
(`chat_thread`) and the shipped `ScheduleRailStep` rail row (`run_card`,
`page_gate_region`) — no fixture route and no test harness renders it. Every
state change is a PRESS IN THE BROWSER on the card's own controls, posting to the
shipped `/api/lifecycle-views/decide`, and the route is RELOADED after each
decision so a settled reading is the server's answer to a fresh request. Every
number in every record is measured by the one shared recorder
(`scripts/audit/lib/chat-hitl-capture-recorder.mjs`).

**What is stood in, named.** The two `expired` cells, and only the resolve
RESPONSE inside them — see their rows below.

**The runtime.** Next.js dev server (Turbopack), `CINATRA_RUNTIME_MODE=development`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, `CINATRA_E2E_SETUP_BYPASS=true`, a dedicated
lane database and Redis on a loopback verify stack, placeholder-only environment
with no model-provider credential on the machine. Development-runtime captures,
labelled as such, per the epic's capture rule for dispatch-dependent cells.

**What was seeded, and by what.** The assistant turn carrying the card's
DATA_PART is written through the app's own thread-persistence route (the model
layer is the stand-in there, and only that); the proposal token is minted by the
shipped `proposeTriggerSchedule`; the review gate the review page is reached by
is written by the shipped writers through the development lifecycle-seed route
(plan §11.2). Nothing about a proposal is written before Confirm — the walk
proves it rather than asserting it, by counting the consume, outbox and run rows
before any press.

---

## A1__schedule-card__chat_thread__pending

*chat_thread · light · proposal*

`evidence/2788-s9d-schedule-card/captures/A1__schedule-card__chat_thread__pending.png` · sha256 `b01e25aebb51faba…` · URL `/chat/cinatra-ai/cinatra-assistant/schedule-proposal-light-1787455899`

**Requires.** The question over the three option rows with the chosen one taking the indigo edge and tint and owning its fields; **Estimated run duration**; a floor holding **Confirm** and nothing else; rows editable as they stand; no cron anywhere.

**Shows.** *When should this run?* over **Run right after setup**, **Schedule for later** and **Recurring**; Recurring chosen, drawing the indigo edge, the tinted ground and the ONLY field set on the card — Repeat every 1 week(s), On Mon–Fri, At 09 : 00, Timezone Europe/Berlin. Then **Estimated run duration**, then one control: **Confirm**. Every field is live on first paint (the record's `editableFields` shows all twelve undisabled). No **Adjust** control exists. The word "cron" is absent, measured rather than assumed.

**Verdict:** **PASS**, with one reservation: the duration line reads the app's own *Unavailable.* rather than a range, because the resolver sends `durationCopy: null` — a pre-existing gap of the resolver, not of the drawing, and unchanged by this rework.

---

## B1__schedule-card__chat_thread__pending__dark

*chat_thread · dark · proposal*

`evidence/2788-s9d-schedule-card/captures/B1__schedule-card__chat_thread__pending__dark.png` · sha256 `53183913a5b2e4e3…` · URL `/chat/cinatra-ai/cinatra-assistant/schedule-proposal-dark-1787455899`

**Requires.** The same reading on the dark ground, with the chosen weekdays still legible.

**Shows.** Identical structure; Mon–Fri render as filled light chips against the dark ground while Sun and Sat stay outline, so which days the card proposes is readable. One control on the floor: **Confirm**.

**Verdict:** **PASS**.

---

## A2__schedule-card__chat_thread__settled

*chat_thread · light · settled, after a real Confirm and a route reload*

`evidence/2788-s9d-schedule-card/captures/A2__schedule-card__chat_thread__settled.png` · sha256 `d9ee39a5770c1083…` · URL `/chat/cinatra-ai/cinatra-assistant/schedule-proposal-light-1787455899`

**Requires.** NO second card: the same card, in the same place, showing the armed schedule in the SAME option rows, with **Save changes** — and neither **Cancel trigger** nor **Release now**.

**Shows.** One card root, `data-lifecycle-card-phase="settled"`. A single line — **Armed · Every weekday at 09:00** — over the same three rows with Recurring chosen and its fields still live, then the floor: **Open the run** and **Save changes** (disabled until a row is edited, which is what it means for a save to have nothing to save). No trigger chrome, no Cancel, no Release; the record measures both absent.

**Verdict:** **PASS**.

---

## B2__schedule-card__chat_thread__settled__dark

*chat_thread · dark · settled*

`evidence/2788-s9d-schedule-card/captures/B2__schedule-card__chat_thread__settled__dark.png` · sha256 `5a8636f4d564cc24…` · URL `/chat/cinatra-ai/cinatra-assistant/schedule-proposal-dark-1787455899`

**Requires.** The same, on the dark ground.

**Shows.** Same single card, same **Armed · Every weekday at 09:00** line, same rows, **Save changes** alone beside **Open the run**. No chrome and no trigger controls.

**Verdict:** **PASS**.

---

## R1__schedule-card__run_card__settled

*run_card · light · the run page's schedule STEP*

`evidence/2788-s9d-schedule-card/captures/R1__schedule-card__run_card__settled.png` · sha256 `927e020ca789120e…` · URL `/agents/cinatra-ai/planner-agent/282fdd3a-c926-41dd-b2e7-f834f269a059`

**Requires.** The schedule as a dedicated step in the LEFT step rail, above the run's other steps; opening it shows the configuration; the trigger's own chrome lives there.

**Shows.** The rail's first row is **1 Schedule**, opened by a real press of its own control. Inside: **Armed · Every weekday at 09:00**, the read-only **Trigger configuration** (Type recurring / Schedule Every weekday at 09:00 / Timezone Europe/Berlin), **Steps held until trigger fires** with the shipped no-side-effect sentence, then the SAME option rows — editable — and the floor with **Save changes**, **Cancel trigger** and **Release now**. Beneath the step, the run's own rows: Review CHANGES_REQUESTED, Review, Core analysis DRIFTED, Review, and two Review-pending-policy rows. The right-hand pane draws no schedule card at all (`scheduleCardsInGateRegion: 0`).

**Verdict:** **PASS**.

---

## R2__schedule-card__run_card__settled__dark

*run_card · dark · the run page's schedule STEP*

`evidence/2788-s9d-schedule-card/captures/R2__schedule-card__run_card__settled__dark.png` · sha256 `b826ed9deaa37585…` · URL `/agents/cinatra-ai/planner-agent/282fdd3a-c926-41dd-b2e7-f834f269a059`

**Requires.** The same, on the dark ground.

**Shows.** Same rail order, same step content, same three controls; all seven weekday chips fit inside the step's panel.

**Verdict:** **PASS**.

---

## P1__schedule-card__page_gate_region__settled

*page_gate_region · light · the review page's schedule STEP*

`evidence/2788-s9d-schedule-card/captures/P1__schedule-card__page_gate_region__settled.png` · sha256 `81c391fad7d89d3d…` · URL `/agents/cinatra-ai/planner-agent/282fdd3a-c926-41dd-b2e7-f834f269a059/review/lifecycle-review:repair:deac3190-4977-4f9b-b99e-3168347e4101:1`

**Requires.** The schedule as a dedicated step ABOVE "1 Review", and the gate region beside it holding the review card ALONE.

**Shows.** The rail reads **1 Schedule** (opened) then **2 Review** — the renumbering that makes "above '1 Review'" literally true. The step holds the trigger chrome, the editable rows and **Save changes / Cancel trigger / Release now**. The gate region on the right holds exactly one card — **Review requested · Awaiting your decision**, its target panel, and the Comment / Reject / Approve floor — and zero schedule cards. Measured: `reviewCardsInGateRegion: 1`, `scheduleCardsInGateRegion: 0`.

**Verdict:** **PASS**, with one reservation: the review card's target panel was still drawing its loading skeleton at the moment of capture (P2 caught the same panel loaded). That is the review card's own load state, not a schedule reading.

---

## P2__schedule-card__page_gate_region__settled__dark

*page_gate_region · dark · the review page's schedule STEP*

`evidence/2788-s9d-schedule-card/captures/P2__schedule-card__page_gate_region__settled__dark.png` · sha256 `6f061abd6d1ed209…` · URL `/agents/cinatra-ai/planner-agent/282fdd3a-c926-41dd-b2e7-f834f269a059/review/lifecycle-review:repair:deac3190-4977-4f9b-b99e-3168347e4101:1`

**Requires.** The same, on the dark ground, with the review target actually drawn.

**Shows.** **1 Schedule** then **2 Review**; the step carries the chrome, the rows and the three controls; the gate region holds the review card alone, this time with its target panel loaded (the S8f text artifact and its revision pin).

**Verdict:** **PASS**.

---

## E1__schedule-card__chat_thread__pending__expired-face__standin

*chat_thread · light · expired (resolve stood in, named)*

`evidence/2788-s9d-schedule-card/captures/E1__schedule-card__chat_thread__pending__expired-face__standin.png` · sha256 `9b6bebdf5e97bcf9…` · URL `/chat/cinatra-ai/cinatra-assistant/schedule-card-2939-expired-r9`

**Requires.** An expired card stays VISIBLE, its rows still editable, on the SAME **Confirm** floor, and the sentence reads as the plan now words it — *"an expired card **stays visible**, still editable, with **Confirm** to set the schedule again"* — with no "proposal" left in the reader's copy.

**Shows.** The card is drawn, not dropped: *"This schedule expired before it was confirmed. Nothing was scheduled — change it if you like, then confirm it again."* — the reworded sentence, re-shot for it — then the same three rows with Recurring chosen and every field live (Repeat every 1 week(s), On Mon–Fri, At 09 : 00, Timezone Europe/Berlin), **Estimated run duration**, then **Confirm** — the same control the live card ends on. No **Adjust** anywhere, and the word "proposal" appears nowhere on the card.

**Verdict:** **PASS** on what it claims. The STAND-IN is the resolve RESPONSE and nothing else — this branch's resolver still answers an expired token `absent` (cinatra#2836's scope). The card, the transcript, the browser and every counted anchor are real.

---

## E2__schedule-card__chat_thread__pending__expired-face__standin__dark

*chat_thread · dark · expired (resolve stood in, named)*

`evidence/2788-s9d-schedule-card/captures/E2__schedule-card__chat_thread__pending__expired-face__standin__dark.png` · sha256 `171f79f59343ed92…` · URL `/chat/cinatra-ai/cinatra-assistant/schedule-card-2939-expired-r9`

**Requires.** The same, on the dark ground.

**Shows.** The same reworded expiry sentence, the same editable rows and the same **Confirm** on the dark ground; Mon–Fri render as filled light chips while Sun and Sat stay outline, so the chosen days stay legible.

**Verdict:** **PASS** on what it claims, with the same named stand-in.

---

## The two cells this branch does not have

- **A proposal on the run page or the review page.** Structurally unreachable at
  this commit and stated in `PLAN-WALK.md` rather than faked: nothing is written
  before Confirm, and Confirm creates the run — so a URL-reached surface can only
  ever address a settled schedule.
- **The site widget.** Same registry row, same card; photographing it needs the
  broker chain (registered surface, connect-site, the frame's own hosted PKCE
  sign-in) that this lane did not stand up. Owed, not claimed.

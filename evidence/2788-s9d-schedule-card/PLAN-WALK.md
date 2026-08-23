# PLAN WALK — cinatra#2788 (S9d), the schedule card as §7 now specifies it

Every capture on this branch against the text that governs it. ONE document
governs: the engineering wiki page **PLAN: Agents Lifecycle (A)**, section 7
("The schedule (trigger) card"). Every `PLAN>` line below is copied VERBATIM
from §7.2 or from §7.4's "As designed" sequence; none is paraphrased, none is
stitched together from two places, and each one is SATISFIED by what its cell's
picture shows.

The ratified §VI drawing is deliberately NOT quoted here. It still draws an
`Adjust · Confirm` floor and a settled card that is the trigger's chrome
wherever it appears; the plan supersedes both readings, and the design page
needs the amendment. Quoting the drawing beside the plan would present a
requirement this branch is ruled not to meet.

The pictures are graded in `README.md` — requires / shows / verdict, by looking
at each one. This file is the text they are graded against.

---

CELL: A1__schedule-card__chat_thread__pending

PLAN> **The schedule card.** The body is the app's standard scheduling step, unchanged: the question **"When should this run?"** over three option rows — **Run right after setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N week(s); On Sun–Sat; At HH:MM; Timezone).
PLAN> The chosen row takes the indigo edge and tint and owns its fields.
PLAN> Under them, **Estimated run duration** with a range.
PLAN> There is **no raw cron field**: the schedule you stated is what you see and confirm.
PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step.
PLAN> The floor is **Confirm**, and this floor is new *here and only here*: the same scheduling step everywhere else arms its trigger directly on **Continue**, because there the thing already exists.
PLAN> Nothing exists here until you confirm; **Confirm** arms the schedule you stated.
PLAN> The card appears in the reply with the schedule you stated, its option rows editable, and **Confirm**.
PLAN> You change the schedule directly on the card if it is not right; **Confirm** arms what you stated.

---

CELL: B1__schedule-card__chat_thread__pending__dark

PLAN> **The schedule card.** The body is the app's standard scheduling step, unchanged: the question **"When should this run?"** over three option rows — **Run right after setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N week(s); On Sun–Sat; At HH:MM; Timezone).
PLAN> The chosen row takes the indigo edge and tint and owns its fields.
PLAN> There is **no raw cron field**: the schedule you stated is what you see and confirm.
PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step.
PLAN> The floor is **Confirm**, and this floor is new *here and only here*: the same scheduling step everywhere else arms its trigger directly on **Continue**, because there the thing already exists.
PLAN> The card appears in the reply with the schedule you stated, its option rows editable, and **Confirm**.

The same reading on the dark ground. The chosen weekdays keep a filled chip
rather than washing into the row, which is what makes "the chosen row … owns
its fields" legible there at all.

---

CELL: A2__schedule-card__chat_thread__settled

PLAN> **After Confirm the card stays where it is and stays editable.** No second card is drawn for the confirmed state: the same card, with the same option rows, now shows the armed schedule; to change it you return to the card, change the rows and press **Save changes**, which re-arms the trigger.
PLAN> The card stays in the conversation, showing the armed schedule in the same rows; change them and press **Save changes** to re-arm.
PLAN> The card stays in the same place with the same rows, now showing the armed schedule; no second card is drawn.
PLAN> The trigger's own chrome — the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and the two quiet controls **Cancel trigger** and **Release now** for an administrator — lives on the run page's schedule step, not in the conversation.

Confirm was pressed in this transcript and the route was then reloaded, so
what the picture shows is the server's answer to a fresh request.

---

CELL: B2__schedule-card__chat_thread__settled__dark

PLAN> **After Confirm the card stays where it is and stays editable.** No second card is drawn for the confirmed state: the same card, with the same option rows, now shows the armed schedule; to change it you return to the card, change the rows and press **Save changes**, which re-arms the trigger.
PLAN> The card stays in the conversation, showing the armed schedule in the same rows; change them and press **Save changes** to re-arm.
PLAN> The card stays in the same place with the same rows, now showing the armed schedule; no second card is drawn.
PLAN> The trigger's own chrome — the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and the two quiet controls **Cancel trigger** and **Release now** for an administrator — lives on the run page's schedule step, not in the conversation.

---

CELL: R1__schedule-card__run_card__settled

PLAN> On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it.
PLAN> The schedule is never drawn as a card among the review cards — a trigger decides *when* the agent runs, and a review card exists only after the agent has run and produced something — so the two can never appear together.
PLAN> On the run page and the review page the schedule is a dedicated step in the step rail on the left, above **1 Review** — open it to see or change the configuration.
PLAN> The trigger's own chrome — the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and the two quiet controls **Cancel trigger** and **Release now** for an administrator — lives on the run page's schedule step, not in the conversation.
PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step.
PLAN> The card stays in the conversation, showing the armed schedule in the same rows; change them and press **Save changes** to re-arm.

The run page. The rail's first row is the schedule step, opened by a real
press; the run's own steps follow beneath it.

---

CELL: R2__schedule-card__run_card__settled__dark

PLAN> On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it.
PLAN> The schedule is never drawn as a card among the review cards — a trigger decides *when* the agent runs, and a review card exists only after the agent has run and produced something — so the two can never appear together.
PLAN> On the run page and the review page the schedule is a dedicated step in the step rail on the left, above **1 Review** — open it to see or change the configuration.
PLAN> The trigger's own chrome — the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and the two quiet controls **Cancel trigger** and **Release now** for an administrator — lives on the run page's schedule step, not in the conversation.

---

CELL: P1__schedule-card__page_gate_region__settled

PLAN> On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it.
PLAN> The schedule is never drawn as a card among the review cards — a trigger decides *when* the agent runs, and a review card exists only after the agent has run and produced something — so the two can never appear together.
PLAN> On the run page and the review page the schedule is a dedicated step in the step rail on the left, above **1 Review** — open it to see or change the configuration.
PLAN> The trigger's own chrome — the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and the two quiet controls **Cancel trigger** and **Release now** for an administrator — lives on the run page's schedule step, not in the conversation.
PLAN> The card stays in the conversation, showing the armed schedule in the same rows; change them and press **Save changes** to re-arm.

The review page, where the rail reads "1 Schedule" then "2 Review" — the
renumbering that makes "above '1 Review'" true — and the gate region beside it
holds the review card and nothing else.

---

CELL: P2__schedule-card__page_gate_region__settled__dark

PLAN> On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it.
PLAN> The schedule is never drawn as a card among the review cards — a trigger decides *when* the agent runs, and a review card exists only after the agent has run and produced something — so the two can never appear together.
PLAN> On the run page and the review page the schedule is a dedicated step in the step rail on the left, above **1 Review** — open it to see or change the configuration.
PLAN> The trigger's own chrome — the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and the two quiet controls **Cancel trigger** and **Release now** for an administrator — lives on the run page's schedule step, not in the conversation.

---

CELL: E1__schedule-card__chat_thread__pending__expired-face__standin

PLAN> Nothing exists yet — the card expires on its own after 30 minutes if you do nothing, and an expired card **stays visible**, still editable, with **Confirm** to set the schedule again.
PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step.
PLAN> The floor is **Confirm**, and this floor is new *here and only here*: the same scheduling step everywhere else arms its trigger directly on **Continue**, because there the thing already exists.

STAND-IN, NAMED: this branch's resolver still answers an expired proposal
`absent` (cinatra#2836 owns that fix), so the expired PHASE cannot be reached
through the server here. The card, the transcript, the browser and every
counted anchor are real; the resolve RESPONSE is the stand-in, and the cell
name says so.

---

CELL: E2__schedule-card__chat_thread__pending__expired-face__standin__dark

PLAN> Nothing exists yet — the card expires on its own after 30 minutes if you do nothing, and an expired card **stays visible**, still editable, with **Confirm** to set the schedule again.
PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step.
PLAN> The floor is **Confirm**, and this floor is new *here and only here*: the same scheduling step everywhere else arms its trigger directly on **Continue**, because there the thing already exists.

---

## What no cell on this branch shows, and why

**The proposal phase on the run page or the review page.** §10.5 proposes keying
the card there by (viewer, organization, template), and both pages know the
run's template — but a live proposal is a signed token riding a conversation
turn and NOTHING is written until Confirm (the propose-pure property §VI rests
on), so there is no row for a URL-reached surface to find. Confirm then CREATES
the run, so by the time either page can address it the phase is `settled` by
construction. Both page cells therefore photograph the armed reading. Making a
proposal addressable from a URL is a different feature — it would need Confirm
to arm an EXISTING run rather than create one — and it is raised rather than
invented.

**The site widget.** The widget host is served by the same registry row as the
chat thread and draws the same card, but photographing it needs the whole broker
chain — a registered surface, a connect-site, and the frame's own hosted PKCE
sign-in — which this lane did not stand up. The cell is owed, not claimed.

# PLAN WALK — cinatra#2788 (S9d), §VI's schedule-proposal card

Every capture on this branch against the text that governs it. Two documents
govern and they are quoted separately, because they answer different questions:

- **The plan** — the engineering wiki page `PLAN: Agents Lifecycle`, section 7
  ("The schedule (trigger) card"). It says what a reader is owed. Every `PLAN>`
  line below is copied VERBATIM from that page; none is paraphrased and none is
  stitched together from two places.
- **The drawing** — `specs/app-lifecycle-cards.html` §VI at
  `design@71398a49c1f8adfe6176ab0dda25486920fac958`, the commit this branch's
  acceptance manifest pins. `DESIGN>` lines are copied verbatim from it.

The pictures are graded in `README.md`; this file is the text they are graded
against.

---

## A1__schedule-card__chat_thread__pending

CELL: A1__schedule-card__chat_thread__pending

The proposal as it arrives in a real transcript — the state the retired
placeholder box stood in for.

PLAN> The body is the app's standard scheduling step, unchanged: the question **"When should this run?"** over three option rows — **Run right after setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N week(s); On Sun–Sat; At HH:MM; Timezone).
PLAN> The chosen row takes the indigo edge and tint and owns its fields.
PLAN> Under them, **Estimated run duration** with a range.
PLAN> There is **no raw cron field**: what the assistant selected is what you see and confirm.
PLAN> The floor is **Adjust · Confirm**, and the design says this floor is new *here and only here*: the same scheduling step everywhere else arms its trigger directly on **Continue**, because there the thing already exists.
PLAN> The card appears in the reply with the proposed schedule and **Adjust / Confirm**.
PLAN> Nothing is armed until you press Confirm — the assistant cannot schedule anything by itself.
DESIGN> The proposal is the scheduling step, in the turn.
DESIGN> There is no raw cron field: the builder's selections are what the reader sees and confirms.

Shows: *When should this run?* over the three rows; **Recurring** chosen, taking
the indigo edge and the tinted ground and drawing the only field set on the card
— Repeat every 1 week(s), On Mon–Fri, At 09 : 00, Timezone Europe/Berlin — then
**Estimated run duration**, then **Adjust · Confirm**. The word "cron" is absent
from the card, measured rather than assumed.

Verdict: **PASS**, with one reservation recorded in the README: the duration line
draws the app's own *Unavailable.* rather than a range, because the resolver
sends no estimate.

---

## A2__schedule-card__chat_thread__pending__adjust-open

CELL: A2__schedule-card__chat_thread__pending__adjust-open

What **Adjust** produces.

PLAN> **Adjust** opens the same option rows in place; **Confirm** settles them.
PLAN> **Adjust** lets you change the proposal on the card; **Confirm** arms the trigger.
DESIGN> Adjust opens the same option rows in place; Confirm settles them.

Shows: the same card, the same rows, now writable — the weekday buttons, both
selects, the hour and minute and the timezone field all live, and the Adjust
control reading pressed. No second form and no second card.

Verdict: **PASS**.

---

## A3__schedule-card__chat_thread__settled

CELL: A3__schedule-card__chat_thread__settled

Confirm pressed in the browser, in the transcript that held A1 and A2.

PLAN> **The settled card is the trigger's own chrome:** in place of the option rows, the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), then **Steps held until trigger fires**, then two quiet right-aligned controls — **Cancel trigger**, and **Release now** for an administrator.
PLAN> The card settles into the trigger's summary with **Cancel trigger**; an administrator also sees **Release now**.
PLAN> **Confirm** arms it, and the card settles in the same place into the schedule's own chrome: **Trigger configuration**, **Steps held until trigger fires**, and two quiet controls — **Cancel trigger**, plus **Release now** for an administrator.
DESIGN> The settled card is the trigger's chrome.

Shows: **Trigger configuration** — Type `recurring`, Schedule *Every weekday at
09:00*, Timezone `Europe/Berlin` — then **Steps held until trigger fires** with
the shipped no-side-effect sentence, then the two quiet right-aligned controls,
**Cancel trigger** and **Release now** (this reader is an administrator). The
option rows and the Confirm floor are gone.

Verdict: **PASS**. A1 → A2 → A3 is one card in one turn, not three screens.

---

## B1__schedule-card__chat_thread__pending__dark

CELL: B1__schedule-card__chat_thread__pending__dark

The same proposal on the dark ground, in a second transcript with its own
proposal (a proposal token is single-use, so the light walk's card could not be
re-photographed unspent).

PLAN> The chosen row takes the indigo edge and tint and owns its fields.
PLAN> The body is the app's standard scheduling step, unchanged: the question **"When should this run?"** over three option rows — **Run right after setup**, **Schedule for later** (Run at, Timezone) and **Recurring** (Repeat every N week(s); On Sun–Sat; At HH:MM; Timezone).

Shows: the same reading with the dark tokens resolved, and **Mon–Fri filled
against an unfilled Sun and Sat**.

Verdict: **PASS — after a fix this capture forced.** The first dark round drew
every weekday chip identically muted, so the days the card was proposing could
not be read at all: the `outline` variant carries its own `dark:bg-input/30`,
which survives beside an unprefixed `bg-primary` and painted over the selection.
A chosen day is now the `default` variant and keeps its fill while the rows are
read-only. Pinned by a test, not by this picture.

---

## B2__schedule-card__chat_thread__pending__adjust-open__dark

CELL: B2__schedule-card__chat_thread__pending__adjust-open__dark

PLAN> **Adjust** opens the same option rows in place; **Confirm** settles them.

Shows: the rows opened in place on the dark ground, the selection still legible.

Verdict: **PASS**.

---

## B3__schedule-card__chat_thread__settled__dark

CELL: B3__schedule-card__chat_thread__settled__dark

PLAN> **The settled card is the trigger's own chrome:** in place of the option rows, the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), then **Steps held until trigger fires**, then two quiet right-aligned controls — **Cancel trigger**, and **Release now** for an administrator.

Shows: the trigger chrome on the dark ground — configuration, held steps, Cancel
trigger and Release now.

Verdict: **PASS**.

---

## R1__schedule-card__run_card__settled

CELL: R1__schedule-card__run_card__settled

The same component on the run page, mounted by `TriggerScreen` under its own
host declaration, for the run the confirmed proposal created.

PLAN> On the run page and the review page the same card appears: in its proposal state you propose or adjust there — on the card or by typing in the prompt window under it — and once confirmed it shows the armed schedule.
PLAN> **The settled card is the trigger's own chrome:** in place of the option rows, the read-only **Trigger configuration** summary (type, the schedule in plain words, timezone), then **Steps held until trigger fires**, then two quiet right-aligned controls — **Cancel trigger**, and **Release now** for an administrator.

Shows: the settled chrome on `/agents/cinatra-ai/planner-agent/<runId>/trigger`
— Type `immediate`, Schedule *Runs right after setup*, Timezone `UTC`, the held
-steps sentence, the released reading, and **Cancel trigger** drawn and disabled
with no **Release now** beside it.

Verdict: **PASS**, with the state named rather than rounded up: an immediate
trigger releases as it arms, so this is the RELEASED face of the settled card.
The plan's proposal state is NOT reachable on this host and the README says why
— Confirm creates the run, so no run exists before a proposal is confirmed.

---

## R2__schedule-card__run_card__settled__dark

CELL: R2__schedule-card__run_card__settled__dark

PLAN> On the run page and the review page the same card appears: in its proposal state you propose or adjust there — on the card or by typing in the prompt window under it — and once confirmed it shows the armed schedule.

Shows: the same run-page reading on the dark ground.

Verdict: **PASS**.

---

## E1__schedule-card__chat_thread__pending__expired-face__standin

CELL: E1__schedule-card__chat_thread__pending__expired-face__standin

The expired reading — and the one stand-in in this set.

PLAN> **Do nothing for 30 minutes** and the proposal expires — the expired card **stays visible**, with **Adjust** to propose again.
PLAN> an expired proposal **stays visible** with Adjust to propose again.
PLAN> **An expired proposal vanishes instead of showing an expired reading** with Adjust to re-propose.

Shows: the expired sentence over the same rows, still carrying Mon–Fri at 09:00
Europe/Berlin, and a floor with **Adjust** alone — nothing to confirm.

Verdict: **PASS AS A STAND-IN, and only as one.** On `main` the resolver answers
an expired proposal `absent`, which is the vanish defect cinatra#2836 / PR #2837
fixes and which this slice deliberately does not duplicate. So the card, the
page, the browser and every counted anchor are real, and the RESOLVE RESPONSE is
substituted with the expired body this branch carries byte-identically from that
PR. The phase goes live on the real path the moment #2837 merges.

---

## E2__schedule-card__chat_thread__pending__expired-face__standin__dark

CELL: E2__schedule-card__chat_thread__pending__expired-face__standin__dark

PLAN> **Do nothing for 30 minutes** and the proposal expires — the expired card **stays visible**, with **Adjust** to propose again.

Shows: the same expired reading on the dark ground.

Verdict: **PASS AS A STAND-IN** — the same statement as E1.

---

## What is NOT walked here, and why

The plan's §7 also puts this card in the **widget** and in the **review page's
gate region**. Both mounts exist and are pinned by
`src/lib/lifecycle/__tests__/schedule-card-host-mounts.test.ts`, and neither is
claimed by a picture in this directory: a capture is evidence only of the host it
was taken on. The `run_card` proposal PHASE is not walked either, and that is
structural rather than an omission — Confirm creates the run, so a run-addressed
card is settled by definition.

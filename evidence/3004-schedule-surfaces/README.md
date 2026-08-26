# Real-run pictures — the schedule surfaces in their states (#3004)

Taken on a running stack built from `7f85012544114aac97de069b9eb9ca0bc2f80074`, the head of
`feat/3004-schedule-form-agent-page`. Four real runs of `@cinatra-ai/planner-agent`, every one
of them created, given its field, armed, cancelled and read **only through the browser**. The
work each run did was done by the real model — the usage ledger rows are below. No seeded rows,
no stubs, no scripted provider, and no direct database writes: the database was opened once, at
the end, to read the rows back.

Every picture is a full-window capture at 1440x900, device scale 2, taken in **both** themes
through the application's own theme control.

## The runs

| run | title | armed on | kind | trigger row, read back | run status |
|---|---|---|---|---|---|
| **X** `1fd2dc65-5ae1-44d7-a6d6-6846342209d7` | Agent Planner (5) | the **agent page's** schedule surface (`…/{run}/trigger`) | `recurring`, `25 14 * * *`, `Europe/Berlin` | `last_fired_at 2026-08-26 12:25:00.276Z`, `stopped_at 2026-08-26 12:34:28.138Z`, `enabled f`, `released_at` null — **the row is still there** | `armed` |
| **Y** `efcd07d3-5c2f-4db4-965e-4bd31d446040` | Agent Planner (6) | the agent page's schedule surface | `scheduled`, `scheduled_at 2026-08-26 12:30:00Z` | `released_at 2026-08-26 12:30:00.095Z` | `completed` |
| **Z** `5402c970-6548-411f-91f1-dbfd781434e2` | Agent Planner (7) | the **run page's** schedule step | `scheduled`, `scheduled_at 2026-08-26 13:10:00Z` | not yet fired | `armed` |
| **W** `0836760a-6ca6-4d39-a1b7-2bd3c5bdfbb0` | Agent Planner (8) | the **run page's** schedule step | `scheduled`, `scheduled_at 2026-08-26 15:40:00Z` | not yet fired | `armed` |
| — `d71075c3-930e-463d-aba4-61608d95ec6e` | (the run X's tick cloned) | — | `immediate`, `released_at 2026-08-26 12:25:00.187Z` | — | `completed` |

## The timeline

| time (UTC) | what happened |
|---|---|
| 12:10:20 | **X** created from the agent's page; its one visible field (`Oas JSON`) given |
| 12:15:35 | **X** armed **Recurring**, daily at 14:25 `Europe/Berlin`, **on the agent page's schedule surface**. The press left the form where it was pressed; the tab strip gained **Schedule** |
| 12:16:45 | **Y** created; field given |
| 12:17:04 | **Y** armed **Schedule for later** for 12:30:00Z on the agent page's schedule surface |
| 12:19:44 | **Z** created; field given |
| 12:20:07 | **Z** armed **Schedule for later** for 13:10:00Z **on the run page's schedule step** |
| **12:25:00.276** | **X's recurring tick fired** — `last_fired_at` stamped, a fresh run cloned and released (`12:25:00.187Z`), which ran on the real model (`12:25:46Z`) and completed |
| 12:25:51 / 12:26:17 | **A1** captured (light / dark) |
| 12:26:07 / 12:26:32 | **R2** captured (light / dark) |
| **12:30:00.095** | **Y's one-off released**; the run worked on the real model (`12:30:16Z`) and reached `completed` |
| 12:30:27 / 12:30:38 | **A2** captured (light / dark) |
| 12:34:09 | **Cancel schedule** pressed on **X**; the ask-first strip read *"Stop this recurring schedule?"* |
| 12:34:12 → 12:34:28.138 | confirmed; `stopped_at` stamped, `enabled` set false, **the row kept** |
| 12:34:39 / 12:34:54 | **A3** captured (light / dark) |
| 12:37:10 → 12:37:34 | **W** created and armed **Schedule for later** for 15:40:00Z **on the run page's schedule step** |
| 12:37:41 / 12:37:46 | **R1** captured (light / dark), where the **Continue** press left the reader |
| 12:38:50 | the A2 read-only guard |
| 12:40:52 / 12:41:07 | **T1** captured (light / dark) |

## The six cells

### A1 — the agent page's schedule surface, a live recurring schedule that has fired

`A1__agent-page-live-recurring__light.png` (+ `__dark`)

| | |
|---|---|
| **requires** | The plan: *"The schedule surface on the agent's page shows the schedule form itself in its respective state — never a 'Trigger configuration' card — the same form as in the chat and on the run page."* Issue acceptance 1: *"a recurring schedule that has fired at least once → editable rows, **Save changes**, **Cancel schedule**"*. Acceptance 2: *"no 'Trigger configuration' card, no 'Steps held until trigger fires', no 'Cancel trigger' and no 'Cancel scheduled trigger?' dialog; the wording is the schedule's — 'Cancel schedule'."* |
| **shows** | The breadcrumb reads **Agents › Agent Planner (5) › Schedule**; the tab strip reads **Setup · Schedule · Permissions** with **Schedule** selected. Under it is the schedule **form**: the three option rows — **Run right after setup**, **Schedule for later**, **Recurring** — with **Recurring** selected and open on **Repeat every 1 day(s)**, **At 14 : 25**, **Timezone Europe/Berlin**, every one of those controls live. Then **Estimated run duration / Unavailable.**, then the floor: **Save changes** (unlit until an edit is made) and **Cancel schedule**. The composer sits below the card. There is no summary card, no held-steps list, no **Cancel trigger**, and the word *trigger* appears **0** times in what a reader sees. |
| **verdict** | **PASS**. Taken **after** its first fire (`last_fired_at 12:25:00.276Z`) — which is what puts **Cancel schedule** on the floor at all. |

Measured on the surface at capture time, identical in both themes: enabled controls inside the
card **9 of 11** (the two that are not are **Save changes**, unlit with no edit pending, and the
disabled state of one row's inner control); `[data-conformance-id="schedule-proposal-floor"]`
**1**; **Save changes** present, **Cancel schedule** present and live; **Cancel trigger** 0;
"Trigger configuration" **false**; "Steps held until trigger fires" **false**; composer **1**.

### A2 — the same surface after a one-off fired

`A2__agent-page-fired-one-off__light.png` (+ `__dark`)

| | |
|---|---|
| **requires** | Issue acceptance 1: *"a one-off that has fired → read-only rows, no controls"*. The plan: *"the run is over and nothing in that run can be configured anymore."* The third reading folded into this issue: *"the composer follows the form's state (absent or read-only once the run is over)"*. |
| **shows** | The same three option rows, drawn as a **reading**: **Schedule for later** selected, its **Run at 08/26/2026, 02:30 PM** and **Timezone Europe/Berlin** in the platform's disabled styling. The card ends at **Estimated run duration / Unavailable.** and stops — **no floor at all**: not a disabled **Save changes**, not a disabled **Cancel schedule**, nothing. **No composer** below it. Breadcrumb and tab still read **Schedule**. |
| **verdict** | **PASS** |

Measured: enabled controls inside the card **0 of 5**; floor **0**; **Save changes** 0;
**Cancel schedule** 0; **Cancel trigger** 0; composer **0**; *trigger* **0**.

Guard, through the screen only: pressing **Run right after setup**, then **Schedule for later**,
then **Recurring**, and then trying to type a new instant into **Run at** — the three presses
landed on nothing and the field refused the value; enabled controls **0 → 0**, floor **0**, and
the rows read the same before and after.

### A3 — the same surface after a recurring schedule that had fired was cancelled

`A3__agent-page-recurring-cancelled-after-a-fire__light.png` (+ `__dark`)

| | |
|---|---|
| **requires** | The plan: *"A recurring schedule that ran at least once and was then cancelled is over, the same as a run set to run once that already ran: the run is over and nothing in that run can be configured anymore."* Issue acceptance 1: *"a recurring schedule cancelled after at least one fire → read-only rows, no controls, no re-arm: the standalone three-option form does not take the surface's place, and the surface offers no route to arm a schedule on that run."* |
| **shows** | The same surface as A1 after **Cancel schedule** was pressed and confirmed. The rows still say what the schedule was — **Recurring**, **1 day(s)**, **At 14 : 25**, **Europe/Berlin** — every one of them greyed. No floor: no **Save changes**, no **Cancel schedule**, no **Cancel trigger**. No composer. The standalone three-option first-step form has **not** taken the surface's place — this is still the same form, frozen. |
| **verdict** | **PASS** |

Measured: enabled controls **0 of 8**; floor **0**; composer **0**; *trigger* **0**.

Guard: pressing all three option rows in turn left enabled controls at **0 → 0** and produced no
**Continue** — the surface offers no route to arm this run again.

Read back afterwards: the trigger row is **still present** — `stopped_at 2026-08-26
12:34:28.138Z`, `enabled f`, `cron_expression 25 14 * * *`, `last_fired_at 12:25:00.276Z`. The
ending was **stopped**, not deleted, which is the half of this change that keeps a finished run
from being handed a fresh schedule.

`A3x__cancel-confirm-strip__light.png` is the ask-first strip that control raises, kept as
supporting evidence for acceptance 2: it reads **"Stop this recurring schedule?"** with
**Keep schedule** / **Cancel schedule** — there is no *"Cancel scheduled trigger?"* dialog.

### R1 — the run page, where **Continue** on its schedule step left the reader

`R1__run-page-after-continue__light.png` (+ `__dark`)

| | |
|---|---|
| **requires** | The plan: *"After Confirm the card stays where it is and stays editable … the same option rows show the schedule as it stands."* The first reading folded into this issue: *"the schedule step keeps the form in its armed state on the run page; no tab switch, no card."* |
| **shows** | The address is the same before and after the press — the run page `…/planner-agent/0836760a-6ca6-4d39-a1b7-2bd3c5bdfbb0`, with no `/trigger` — and the rail's **1 Schedule** step is open on the **armed** form: **Schedule for later**, **08/26/2026, 05:40 PM**, **Europe/Berlin**, with **Save changes** on the floor and the composer beneath. The tab strip still has **Setup** selected: nothing switched tabs, and there is no summary card anywhere. |
| **verdict** | **PASS** |

Guard: editing **Run at** on that surface flipped **Save changes** from unlit to live — the rows
are an editable form, not a reading. The edit was never saved; the row still reads
`scheduled_at 2026-08-26 15:40:00Z`.

### R2 — the run page's Schedule step for a run armed on the **agent** page

`R2__run-page-schedule-step-armed-on-agent-page__light.png` (+ `__dark`)

| | |
|---|---|
| **requires** | The second reading folded into this issue: the rail drew **1 Schedule** but selecting it left the detail column **empty**, because the step resolved the schedule through a conversation's proposal, which such a run never has. *"Acceptance: the step draws the form from the run's own schedule row in its state, whatever road created the schedule."* |
| **shows** | Run **X**'s run page. Its schedule was armed on the **agent page**, so it has no proposal ancestry at all. The rail's **1 Schedule** step opens onto the **same form in the same state** as A1 — **Recurring**, **1 day(s)**, **At 14 : 25**, **Europe/Berlin**, with **Save changes** and **Cancel schedule**, composer below. The detail column is not empty. |
| **verdict** | **PASS** |

Measured: enabled controls **18 of 20**; floor **1**; **Cancel schedule** live; composer **1**.

### T1 — the wording, and the composer following the form's state

`T1__agent-page-wording-and-composer__light.png` (+ `__dark`)

| | |
|---|---|
| **requires** | The third reading folded into this issue: *"schedule wording on the breadcrumb, the tab and the controls; the composer follows the form's state (absent or read-only once the run is over)."* Acceptance 2's four absences. And issue acceptance 1's remaining state: *"a one-off still ahead of its instant … → editable rows and **Save changes**, no **Cancel schedule** (the control belongs to a recurring schedule that has fired)"*. |
| **shows** | Run **Z**'s agent-page schedule surface, on a one-off that is still ahead of its instant — a schedule that can still be changed. The breadcrumb reads **Agents › Agent Planner (7) › Schedule** and the tab strip **Setup · Schedule · Permissions** with **Schedule** selected — the word *Trigger* is on neither. The rows are live, **Save changes** is on the floor and **Cancel schedule** is **absent** (this schedule has not fired), and the composer — *"Ask Cinatra to suggest edits to the fields above…"* — is present under the form. |
| **verdict** | **PASS** |

This cell is shot on a **fourth** state rather than re-framing A1: the whole surface fits inside
one 1440x900 window, so A1's own frame already carries the breadcrumb, the tab strip and the
composer, and a second frame of it would have added nothing. The per-surface counts below carry
the rest of this cell's evidence.

## The sidecar, across every surface pictured

Read off the live DOM at the moment each picture was taken; the light and dark readings are
identical on every row.

| surface | schedule form drawn | controls floor | enabled controls | Save changes | Cancel schedule | Cancel trigger | composer | "Trigger configuration" | "Steps held until trigger fires" | the word *trigger* |
|---|---|---|---|---|---|---|---|---|---|---|
| **A1** live recurring, fired | yes | 1 | 9 of 11 | present | present, live | 0 | 1 | no | no | 0 |
| **A2** one-off, fired | yes | **0** | **0 of 5** | 0 | 0 | 0 | **0** | no | no | 0 |
| **A3** recurring, cancelled after a fire | yes | **0** | **0 of 8** | 0 | 0 | 0 | **0** | no | no | 0 |
| **R1** run page after Continue | yes | 1 | 14 of 16 | present | 0 (a one-off) | 0 | 1 | no | no | 0 |
| **R2** run page step, armed on the agent page | yes | 1 | 18 of 20 | present | present, live | 0 | 1 | no | no | 0 |
| **T1** one-off still ahead | yes | 1 | 5 of 7 | present | 0 (not fired) | 0 | 1 | no | no | 0 |

The composer is present on exactly the four surfaces where the schedule can still be changed and
absent on the two where the run is over. The breadcrumb's last crumb reads **Schedule** on every
agent-page surface (A1, A2, A3, T1); the tab strip reads **Setup · Schedule · Permissions** on
all six.

## The readback (values only)

Trigger rows, `cinatra.agent_run_triggers`, this round:

| run | type | scheduled_at | cron | timezone | enabled | released_at | last_fired_at | stopped_at |
|---|---|---|---|---|---|---|---|---|
| `1fd2dc65…` X | recurring | — | `25 14 * * *` | Europe/Berlin | **f** | — | `12:25:00.276Z` | **`12:34:28.138Z`** |
| `efcd07d3…` Y | scheduled | `12:30:00Z` | — | Europe/Berlin | t | `12:30:00.095Z` | — | — |
| `5402c970…` Z | scheduled | `13:10:00Z` | — | Europe/Berlin | t | — | — | — |
| `d71075c3…` (X's clone) | immediate | — | — | Europe/Berlin | t | `12:25:00.187Z` | — | — |
| `0836760a…` W | scheduled | `15:40:00Z` | — | Europe/Berlin | t | — | — | — |

Run rows, `cinatra.agent_runs`: `1fd2dc65…` `armed`, `efcd07d3…` **`completed`**, `5402c970…`
`armed`, `d71075c3…` **`completed`**, `0836760a…` `armed`.

Usage ledger, `cinatra.usage_events`, this round — the proof that the work was done by the real
model and not by a stub:

| occurred_at | source | provider | model | operation | in | out | requested → effective |
|---|---|---|---|---|---|---|---|
| `2026-08-26 12:25:46.048Z` | llm | openai | `gpt-5.5-2026-04-23` | generate | 36414 | 589 | openai → openai |
| `2026-08-26 12:30:16.963Z` | llm | openai | `gpt-5.5-2026-04-23` | generate | 36414 | 461 | openai → openai |

The first is the run X's recurring tick cloned and released; the second is Y's own one-off run.

## Disclosures

- **The setup rail's schedule step is not on this branch** (it lands with 2975), so the rail
  variant of the Continue reading is not pictured. R1 is the run page's own scheduling step,
  which mounts the same component — the scope this pull request states.
- The **A1 editability guard** was not taken on the recurring rows themselves: the card renders
  its hour and minute as comboboxes rather than native selects, and the same run had to be
  cancelled next for A3. The editability guard was taken on **R1**'s live one-off form instead,
  where the instant is a native field — one live surface proving the form is editable, with the
  rest of "editable" carried by the enabled-control counts above.
- **Z** and **W** were still armed (13:10:00Z and 15:40:00Z) when the round finished and the
  stack was stopped; neither had fired, and neither is used for a fired-state cell.
- The chat card host is not re-pictured here. This issue's acceptance is about the agent page's
  surface, the run page's step and the wording; the chat card's absences are already pinned by
  the tests this pull request names.

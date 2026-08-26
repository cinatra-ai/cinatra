# Real-run pictures — the finished immediate run and the fired one-off (#2980)

Taken on a running stack built from `987669ae94bc93da06b7f56e91fe5a010a077b2b`, the head of
`fix/2980-trigger-tab-finished-immediate`. Two real runs of `@cinatra-ai/planner-agent`, both
started and driven only through the browser, both executed by the real model. No seeded rows,
no stubs, no direct writes.

Every picture is a full-window capture at 1440x900, device scale 2, in both themes.

## The two cells

| | run | kind | trigger row | created | completed | model call |
|---|---|---|---|---|---|---|
| A | `da9bb86d-2382-4ef8-b59f-d0be631b9994` | **Run right after setup** | `immediate`, `released_at 2026-08-26 05:11:08.987Z`, `scheduled_at` null, `cron_expression` null | `2026-08-26 05:03:58.024Z` | `2026-08-26 05:11:57.831Z` (`completed`) | `openai / gpt-5.5-2026-04-23 / generate`, 36248 in, 591 out, `05:11:56.448Z` |
| B | `925d9d5a-8a11-4714-8405-73284b8ddccf` | **Schedule for later** | `scheduled`, `scheduled_at 2026-08-26 05:35:00Z`, `released_at 2026-08-26 05:35:00.329Z` | `2026-08-26 05:29:42.745Z` | `2026-08-26 05:35:12.166Z` (`completed`) | `openai / gpt-5.5-2026-04-23 / generate`, 36130 in, 137 out, `05:35:11.572Z` |

Timeline: A was created from the agent's page at 05:03:58Z, given its one visible field
(`Oas JSON`), armed **Run right after setup** at 05:11:08.987Z, and finished at 05:11:57.831Z.
B was created at 05:29:42Z, given the same field, armed **Schedule for later** for 05:35:00Z at
05:30:03.431Z, fired at 05:35:00.329Z and finished at 05:35:12.166Z without asking again.

## The pictures

### A — the finished immediate run, on its own schedule surface (`…/{runId}/trigger`)

| picture | requires | shows | verdict |
|---|---|---|---|
| `N1__finished-immediate__notice-and-reading.png` (+ `__dark`) | #2980 acceptance 2: *"The notice text no longer says 'You can still give it a recurring schedule below' once that is no longer true"*. Plan (A) §7.2 item 4: *"once a one-off has fired it cannot be changed"*. `design@fe2182547d4a` `specs/app-components.html` § "Standard scheduling step", the "Configured schedule step" block: *"Once a Run right after setup or Schedule for later schedule has fired it cannot be changed any more: the form stays as a read-only reading with no controls at all."* And this PR's own claim that the persistent Trigger tab does not appear for an `immediate` row. | The notice reads **"This run has already finished"** / *"It can't be run again, and its schedule has already run — a schedule that has run can't be changed. Start a new run to schedule it again."* with the **View this run** link. The retired sentence is nowhere on the surface. Beneath it the same form is drawn as a reading: the three rows with **Run right after setup** selected, the date-time field, the recurrence builder and both timezone fields, all in the platform's disabled styling. The tab strip reads **Setup · Permissions** — no Trigger tab. | **PASS** |
| `N2__finished-immediate__foot-no-submit.png` (+ `__dark`) | The same "Configured schedule step" reading: *"with no controls at all"*, i.e. no submit and no assistant panel. | The card ends at **Estimated run duration / Unavailable.** and then stops — nothing follows it inside the card, and the foot of the window carries no assistant composer. There is no **Continue**. | **PASS** |

Measured on the surface at capture time, identical in both themes:

- notice still promising a recurring schedule below: **false**
- `fieldset[data-schedule-readonly]`: **1**, `disabled` = **true**
- submit controls inside the form: **0**; controls labelled *Continue*: **0**
- schedule-kind controls: `["Run right after setup [disabled]"]`
- **Save changes** 0, **Cancel schedule** 0, release-now 0
- enabled form controls inside the reading: **0 of 22**
- option rows carrying a pointer affordance: **0 of 4**
- assistant panel: **0**; persistent Trigger tab present: **false**

### B — the fired one-off (`Schedule for later`), on its schedule readings

| picture | requires | shows | verdict |
|---|---|---|---|
| `O1__fired-one-off__trigger-tab.png` (+ `__dark`) | Plan (A) §7.2 item 4, the other one-off kind: *"once a one-off has fired it cannot be changed"* — no control that re-arms or edits this run's schedule. | **Trigger configuration** — Type `scheduled`, Schedule `Aug 26, 2026, 7:35:00 AM`, Timezone `Europe/Berlin` — as a summary with no editable field. **Steps held until trigger fires**: *"No side-effect steps detected…"*. **Cancel trigger** is drawn and **disabled** (it is gated on the release stamp). No **Save changes**, no release-now, no **Continue**. | **PASS** on "cannot be changed" — with one thing named below |
| `O2__fired-one-off__run-page-schedule-step.png` (+ `__dark`) | Plan (A) §7.2 step 5: *"the schedule is a dedicated step in the step rail on the left … open that step to see the configuration"*. | The rail draws **1 Schedule** above **Step 1**. Selecting **1 Schedule** leaves the detail column **empty** — the step's own container is drawn and holds nothing. | **DEFECT — outside this change**, see below |

Measured: **Cancel trigger** = disabled; enabled form controls 0; *Continue* 0; **Save changes** 0;
release-now 0.

## The guard, through the screen only (#2980 acceptance 1)

Acceptance 1 asks that a submitted `recurring` (or `scheduled`) trigger against the fired run's
own row be refused. On the finished immediate run's surface **there is no longer anything to
submit**, which is the point of the change: 0 enabled controls of 22, and no submit control.
Pressing the **Schedule for later** row, then the **Recurring** row, then Enter inside the form
changed nothing:

| | selected row | enabled controls | *Continue* | submit | address |
|---|---|---|---|---|---|
| before | Run right after setup | 0 / 22 | 0 | 0 | `…/{runId}/trigger` |
| after | Run right after setup | 0 / 22 | 0 | 0 | `…/{runId}/trigger` (no navigation) |

And the run's trigger row was not written: `updated_at` is still `2026-08-26 05:11:08.990Z`,
the stamp from the arm, read back after the attempt. The server-side refusal itself is what the
red-first unit tests in this PR pin; from the screen there is no path left that reaches it.

## Two things these pictures show that this change does not own

1. **The fired one-off's persistent Trigger tab still invites edits in words.** At the foot of
   `O1` a composer reads *"Ask Cinatra to suggest edits to the fields above…"*, enabled, on a
   schedule that has already run. The fields above it are a read-only summary and **Cancel
   trigger** is disabled, and the server refuses a change to a fired `scheduled` row, so nothing
   can be armed from it — but the invitation is still drawn. That panel lives in
   `packages/agents/src/trigger-tab-client.tsx`, whose visibility rule reads no release stamp;
   this PR withholds the same panel on the surface it does own
   (`visible={!readOnly && …}` in `trigger-screen-client.tsx`). Named here, not fixed here.

2. **The run page's Schedule step opens empty for a run started from the agent's page.** In
   `O2` the rail row exists and selecting it renders nothing. The step's card is resolved by
   ref, and for this run `POST /api/lifecycle-views/resolve` answers
   `trigger_schedule_proposal` with `{"state":"absent"}` and a null body — an absent card draws
   no DOM at all. The run carries no schedule-proposal ancestry because it was started from the
   agent's own page rather than proposed in a conversation. The two files that decide this,
   `packages/agents/src/schedule-rail-step.tsx` and
   `src/lib/lifecycle/trigger-schedule-proposal-card.ts`, are not in this PR's diff.

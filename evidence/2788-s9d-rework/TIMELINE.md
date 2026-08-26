# TIMELINE — the real runs behind every capture

**Round 6 (2026-08-26) re-shot ONE picture — C7 — and added three cells (C9, C10,
C11).** Its rows are the first table below. Round 5's rows follow unchanged, and
the other twelve of its pictures are still the committed ones.

## Round 6 — the run behind C7, C9, C10 and C11

Every row is read out of the lane database or is the `capturedAt` of the record
the picture is filed with, so a reader can line every picture up against the row
it belongs to. ONE run carries all four cells: it was asked for in the app's own
chat with a real model provider and created by the app's own dispatch, and it has
never executed (`started_at` NULL at every shutter).

Run `2b9859f8-3efc-448e-8659-e8246713b5e2`, thread
`780b4eed-efed-4e00-b7a4-81c36c958e37`.

| UTC (2026-08-26) | what | where it is recorded |
|---|---|---|
| 05:41:17.251 | a warm-up turn sent in the app's own chat and answered (the ingress had to be warm before the runtime's 2.5 s public-MCP probe would pass — README.md, "the two limits this round hit") | `cinatra.assistant_turns` |
| 05:41:17.903 | the person asks, in their own words: *"Please run the Blog Draft Writer Agent for me now."* | `cinatra.assistant_turns` (user turn) |
| 05:41:13.727 / 05:41:39.279 | the two model calls of the session: `openai` / `gpt-5.5`, 43324 in / 303 out | `cinatra.usage_events` |
| 05:41:31.729 | **the app's own dispatch created the run**, `pending_input`, human-present, `source_type agent_builder` | `cinatra.agent_runs.created_at` |
| ~05:41:3x | the run parks at its setup interruption, `pending_approval`; no trigger row | `cinatra.agent_runs.status` |
| 05:48:01.493 / 05:48:09.229 | **C7** shot, light and dark: the two-column setup surface — rail 1 / detail 1, the three steps NAMED, `1 Schedule` open with the scheduling form on the right, no run progress | the two C7 records |
| 05:48:25.110 / 05:48:41.140 | **C10** shot, light and dark, after the **2 Recommendation** row was pressed: the step takes the selection and the run detail draws NOTHING (`detailColumnTextLength` 0) | the two C10 records |
| 05:48:55.337 / 05:49:09.838 | **C11** shot, light and dark, after the **3 Review** row was pressed (forced — the row carries `aria-disabled`): nothing happened, the scheduler is still open | the two C11 records |
| 05:49:57.946 | **Continue pressed** on the scheduler step, inside the run detail column, with *Schedule for later* and `2026-08-26 21:30` typed into the step's own field | `readback/2975-chain.json` |
| 05:49:58.710 | **the trigger armed by the app itself**: `scheduled`, `2026-08-26 19:30:00+00`, `Europe/Berlin`, enabled, delayed job `trigger-release-2b9859f8-…`, `released_at` NULL | `cinatra.agent_run_triggers` |
| 05:52:39.654 / 05:52:48.549 | **C9** shot, light and dark: the same run's page now drawing `Trigger configuration` — type `scheduled`, `Aug 26, 2026, 9:30:00 PM`, `Europe/Berlin` — with `Cancel trigger` | the two C9 records |

**The run never ran.** `started_at` is NULL in every record's own `dbAt` block, no
`artifact_review_gates` row exists for it (0 on the whole lane), and the server log
carries zero `[llm-bridge-run-select]` lines — which is what a round of
pre-execution screens should read.

**A consequence worth recording rather than smoothing over:** the run was at
`pending_approval` when Continue was pressed, and `pending_approval -> armed` is not
a legal transition, so the trigger row was created while the run's STATUS stayed
`pending_approval`. The arming is the trigger row and the scheduled job, and both
are there; the status flip belongs to the `pending_input` path. Nothing in
cinatra#2970 touches that, and it is the same on this head as before it.


**Round 5 re-shot all fourteen pictures**, and its rows are the second table
below. Rounds 4 and 3 follow unchanged, as the record of what they walked; no
committed picture stands on them any more.

## Round 5 — the runs behind all fourteen pictures

Every row is read out of the lane database, not out of a driver's log. The run
is `9384a346-d9a6-4403-9beb-51ef347618f3`; the two conversations are real
assistant threads written by the shipped chat route —
`1bfacdfc-871f-4ecc-a9c2-de49fff427f1` for the proposal nobody touched and
`efba5760-304d-4b6a-9ca7-80b7b9af9262` for the run. `RUN-READBACK.md` carries
the full rows and the proposal-ref→consume-key join that binds the conversation to
the run; `readback/db-readback.json` carries those rows as the reader printed them,
and `readback/runtime-evidence.txt` the server log lines quoted below.

**NOTHING IN ANY PICTURED CHAIN IS STOOD IN.** A sentence was typed into the
shipped composer; the REAL model answered it, reading the platform's tool
catalogue as one provider-hosted MCP reference and calling the SHIPPED producer
`schedule_proposal_render` itself over the public ingress; the proposal ref in
the dispatch part is the product's own. The person then confirmed on the card.
`CINATRA_TEST_LLM_PROVIDER` was UNSET throughout and the server log carries zero
scripted-runtime lines.

Capture times are the `capturedAt` of the record each picture is filed with (and,
for the two page controls, of `page-controls.json`), so a reader can line every
picture up against the row it belongs to.

| UTC (2026-08-24) | what | where it is recorded |
|---|---|---|
| 14:51:53.227 | the expired cell's schedule stated in a conversation | `cinatra.assistant_turns` (user turn, thread `1bfacdfc-…`) |
| ~14:51:5x | the assistant answers with the card — **the shipped 30-minute window starts here** | `cinatra.assistant_turns` (assistant turn, same thread) |
| 15:23:49.729 / 15:23:52.428 | **C5** shot, light and dark, after the window had ACTUALLY run out (`PROPOSAL_TTL_SECONDS = 1800`) — no clock was moved | the two C5 records |
| 16:43:33.532 | a FRESH run started from the product's own **Run** control, never armed | `cinatra.agent_runs` (no `agent_run_triggers` row) |
| 17:21:03.867 | the run's schedule stated in a second conversation | `cinatra.assistant_turns` (user turn, thread `efba5760-…`) |
| 17:21:12 | the proposal minted — `iat` inside the ref itself, `exp` 1800 s later | the ref in the thread's dispatch part |
| 17:21:13.852 | the model call that produced it: `openai` / `gpt-5.5`, 21231 in / 118 out | `cinatra.usage_events` |
| 17:21:14.338 / 17:21:18.067 | **C1** shot, light and dark: the card `pending`, rows editable, Confirm on the floor | the two C1 records |
| 17:21:18.164 | **Confirm pressed:** the proposal CONSUMED — single-use, bound to this reader, org and template — and the run created | `cinatra.trigger_schedule_proposal_consumes`, `cinatra.agent_runs` |
| 17:21:18.181 | the trigger written: `scheduled`, a ONE-OFF at `2026-08-24 17:42:00+00` UTC, no cron, enabled, delayed job `trigger-release-9384a346-…` | `cinatra.agent_run_triggers` |
| 17:21:18.434 / 17:21:22.510 | **C2** shot, light and dark: the SAME card, Save changes where Confirm stood, nothing above the rows | the two C2 records |
| 17:22:04.370 / 17:22:05.349 | **C3** shot, light and dark: the rail on the left with Schedule selected, the form in the run detail on the right, no run progress card | the two C3 records |
| 17:42:00.143 | **the one-off FIRED on its own tick** — 143 ms after the second the person stated, nobody on the run page; the runtime logged `[trigger-release] released gate for run 9384a346-…` then `[trigger-release] enqueued execution for run 9384a346-…` | `cinatra.agent_run_triggers.released_at` |
| 17:42:11.792 | the agent's own model call: `openai` / `gpt-5.5-2026-04-23`, 37093 in / 37 out, resolved by this run's own run token through the shipped `/api/llm-bridge` | `cinatra.usage_events` |
| 17:42:12.471 | the run reached `completed`, no error | `cinatra.agent_runs` |
| 17:43:31.059 / 17:43:36.383 | **C6** shot, light and dark: the same card in the same conversation, rows read-only, no floor at all | the two C6 records |
| 17:43:40.901 / 17:43:44.494 | **C7** (page control) shot, light and dark, on the never-armed run above | `page-controls.json` |
| 17:43:48.199 / 17:43:51.633 | **C8** (page control) shot, light and dark: the rail still listing Schedule, the run detail carrying the completed progress card | `page-controls.json` |

**C4 IS ABSENT AND STAYS ABSENT.** It asked for the review page carrying THIS
run's real artifact review, and this run has none: a schedule decides WHEN the
agent runs, and a review card exists only after the agent has run and produced
something to review. The walk contains no C4 step, so there is nothing to answer
with the wrong screen, and no stand-in was used.

**FIVE ARMED RUNS WERE DISCARDED** before this one, each for a stated reason;
`RUN-READBACK.md` lists them with their release stamps. All five released within
143 ms of the second they were armed for, with nobody on the run page.

---

# Earlier rounds, kept for the record

**Everything below is HISTORY.** It is reproduced as rounds 3 and 4 wrote it, and
no committed picture stands on any run named below — round 5 re-shot all fourteen.
Sentences below that read in the present tense about which cell a run carries were
true when written and are not true now.

Round 4 re-shot C2 and C6 on a run of its own; its rows are the second table
below. Round 3's two runs are unchanged: the armed run it walked carries C1, C3,
C5 and C8, and the fresh never-armed run beside it carries C7.

## Round 3 — the two runs that WERE behind C1, C3, C5, C7 and C8 (superseded by round 5)

Every row is read out of the lane database, not out of a driver's log. The run
is `972d5781-c540-45b0-adfd-d3c31dba6277`; the two conversations are real
assistant threads written by the shipped chat route —
`36dd7069-b611-4249-8b36-7cb41c2dd238` for the proposal nobody touched, and
`6b4165d5-b8fa-4c34-862c-cda396070163` for the run. `RUN-READBACK.md` carries
the full rows.

There is no seeded transcript and no hand-minted token anywhere in this walk. A
sentence was typed into the shipped composer; the model layer answered it by
calling the SHIPPED producer `schedule_proposal_render` over self-MCP; the
proposal ref in the DATA_PART is the product's own. The person then stated the
ONE-OFF on the card itself — the option rows are editable until Confirm, which
is the plan's own sentence — and pressed Confirm.

Capture times are the `capturedAt` of the record each picture is filed with (and,
for the two page controls, of `page-controls.json`), so a reader can line every
picture up against the row it belongs to.

| UTC (2026-08-23) | what | where it is recorded |
|---|---|---|
| 20:46:46.895970 | the expired cell's schedule stated in a conversation | `cinatra.assistant_turns` (user turn, thread `36dd7069-…`) |
| 20:46:47.256721 | the assistant answers with the card — **the shipped 30-minute window starts here** | `cinatra.assistant_turns` (assistant turn, same thread) |
| 21:04:37.906315 | the run's schedule stated in a second conversation | `cinatra.assistant_turns` (user turn, thread `6b4165d5-…`) |
| 21:04:38.243667 | the assistant answers with the card, `pending`; the person then chooses **Schedule for later** on the card and states `2026-08-23 21:22` UTC — **C1** shot at 21:04:39.310 (light) and 21:04:44.455 (dark) | `cinatra.assistant_turns` (assistant turn, same thread) |
| 21:04:44.786750 | **Confirm pressed:** the proposal CONSUMED — single-use, bound to this reader, org and template — and the run created | `cinatra.trigger_schedule_proposal_consumes`, `cinatra.agent_runs` |
| 21:04:44.796 | the trigger written: `scheduled`, a ONE-OFF at `2026-08-23 21:22:00+00` UTC, no cron, enabled, delayed job `trigger-release-972d5781-…` — **C2** shot at 21:04:45.400 and 21:04:47.234 | `cinatra.agent_run_triggers` |
| 21:08:10.765053 | a FRESH run started from the product's own **Run** control, never armed — **C7** (page control) shot at 21:12:17.628 and 21:12:21.657 | `cinatra.agent_runs` (no `agent_run_triggers` row) |
| 21:09:52.609 | the run page's schedule step opened by a real press of the rail row — **C3** (dark at 21:09:53.755) | the walk's own press, on the run above |
| **21:22:00.163** | **the one-off FIRES ON ITS OWN.** `released_at` lands 163 ms after the second the person stated, seventeen minutes after the row was written, with no interaction in between. Nothing pressed *Run now*. | `cinatra.agent_run_triggers.released_at` |
| 21:22:05.409 | the agent has executed and the run is `completed` — its model call went out over the shipped `/api/llm-bridge` against the instance's own sealed provider row | `cinatra.agent_runs.completed_at` |
| ~21:16:47 | the untouched proposal's 30-minute window elapsed | `PROPOSAL_TTL_SECONDS = 1800`, mint at 20:46:47 |
| 21:22:55.440 | the conversation's card after the fire — **C6** (dark at 21:22:57.229) | the walk reopened the run's conversation |
| 21:22:59.070 | the expired reading captured — **C5** (dark at 21:23:01.070) | the walk reopened the untouched conversation |
| 21:23:27.221 | the run detail after the fire — **C8** (page control; dark at 21:23:30.759) | `evidence/2788-s9d-rework/page-controls.json` |

The end state of the run, read back after the last capture:
`agent_runs.status = completed`, `completed_at 21:22:05.409`, no error;
`agent_run_triggers.released_at 21:22:00.163`, `enabled = t`.

THIS TABLE IS ROUND 3'S OWN READING, reproduced unchanged, and two things about it
are worth saying rather than leaving for a reader to reconcile. First, its **C2**
row (21:04:45.400 / 21:04:47.234) and its **C6** row (21:22:55.440 / 21:22:57.229)
no longer point at a committed picture: round 4 replaced those four images and
their four records, for the reason README.md gives at the top. They are kept
because they are what round 3 recorded, and because the two FAILs round 4 closes
were read off exactly those pixels. Second, round 4's stricter statement about
`released_at` — that it proves RELEASE and not WHO released, because an
administrator's *Run now* writes the same stamp — applies to the 21:22:00.163 row
as well; what round 3 established for it is that its own walk pressed nothing and
that the stamp landed 163 ms after the second the person stated.

## Round 4 — the run that WAS behind C2 and C6 (superseded by round 5)

Same recipe, same file, a run of its own. The run is
`98f50b86-8619-48bf-adf1-3278684daa02`; the conversation is
`7d5c87b2-84e4-487a-a9f8-103df32f78d1`, a real assistant thread written by the
shipped chat route. Every row is read out of the lane database.
`RUN-READBACK.md` carries the full rows.

| UTC (2026-08-24) | what | where it is recorded |
|---|---|---|
| 09:26:29.507327 | the schedule stated in the chat composer | `cinatra.assistant_turns` (user turn, thread `7d5c87b2-…`) |
| 09:26:29.962855 | the assistant answers with the card, `pending` — a DAILY RECURRENCE, which is the only schedule the deterministic producer proposes | `cinatra.assistant_turns` (assistant turn, same thread) |
| ~09:26:31 | the person ADJUSTS the card: *Schedule for later* chosen, `2026-08-24 09:34` and `UTC` typed into its own fields — the rows are editable until Confirm, which is the plan's own sentence | the walk's own actions (`state-the-schedule`, `follow-dark`) |
| 09:26:33.009191 | **Confirm pressed:** the proposal CONSUMED — single-use, bound to this reader, org and template — and the run created | `cinatra.trigger_schedule_proposal_consumes`, `cinatra.agent_runs` |
| 09:26:33.033 | the trigger written: `scheduled`, a ONE-OFF at `2026-08-24 09:34:00+00` UTC, no cron, enabled, delayed job `trigger-release-98f50b86-…` — **C2** shot at 09:26:33.542 (light) and 09:26:35.217 (dark) | `cinatra.agent_run_triggers`; the two C2 records |
| **09:34:00.088** | **the one-off is RELEASED, 88 ms after the second the person stated** and seven minutes after the row was written | `cinatra.agent_run_triggers.released_at` |
| 09:34:00 (same second) | the RELEASE JOB is what opened the gate — the runtime says so in its own words, `[trigger-release] released gate for run 98f50b86-…` followed by `[trigger-release] enqueued execution for run 98f50b86-…` | the app's server log for this lane |
| 09:34:04.876 | the agent's model call — the REAL model, over the shipped `/api/llm-bridge` against the instance's own sealed provider row | `cinatra.usage_events` (`openai` / `gpt-5.5-2026-04-23`, `requested=effective=openai`) |
| 09:34:05.347 | the agent has executed and the run is `completed`, no error | `cinatra.agent_runs.completed_at` |
| 09:34:54.120 | the conversation's card after the fire — **C6** (dark at 09:34:55.953) | the walk reopened the run's conversation; the two C6 records |

The end state, read back after the last capture: `agent_runs.status = completed`,
`completed_at 09:34:05.347`, no error; `agent_run_triggers.released_at
09:34:00.088`, `enabled = t`.

THREE EARLIER RUNS IN THIS ROUND ARE NOT BEHIND ANY PICTURE, and are named here
rather than left out. The first armed one-off of the day was released on its own
tick, but its agent could not execute — the lane's runtime container was not up
yet — so it was discarded and the walk re-run from the sentence. Two further runs
were then started from the product's own **Run** control, to prove the runtime,
the sealed provider row and the model call end to end BEFORE the capture run was
armed; both failed on lane provisioning the lane then fixed (a missing registry
identity, then an unreachable package for the artifact bindings), and the last of
them completed. No picture in this evidence set is taken on any of the three.

## Why C4 is not here

C4 asked for the review page carrying **this run's real artifact review**. The
schedule slice does not produce one: a schedule decides WHEN the agent runs, and
a review card exists only after a run has produced something a reviewer is asked
about. This run produced its own output and completed without raising a review
gate, so there is nothing to photograph. Per the standing rule that a stand-in is
never acceptable, **C4 stays DROPPED** rather than staged — there is no C4 step in
`capture-walk.json` to accidentally answer with the wrong screen.

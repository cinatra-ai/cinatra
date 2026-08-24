# TIMELINE — the real runs behind every capture

Round 4 re-shot C2 and C6 on a run of its own; its rows are the second table
below. Round 3's two runs are unchanged: the armed run it walked carries C1, C3,
C5 and C8, and the fresh never-armed run beside it carries C7.

## Round 3 — the two runs behind C1, C3, C5, C7 and C8

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

## Round 4 — the run behind C2 and C6

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

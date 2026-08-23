# TIMELINE — the one real run behind every capture

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

| UTC | what | where it is recorded |
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

## Why C4 is not here

C4 asked for the review page carrying **this run's real artifact review**. The
schedule slice does not produce one: a schedule decides WHEN the agent runs, and
a review card exists only after a run has produced something a reviewer is asked
about. This run produced its own output and completed without raising a review
gate, so there is nothing to photograph. Per the standing rule that a stand-in is
never acceptable, **C4 stays DROPPED** rather than staged — there is no C4 step in
`capture-walk.json` to accidentally answer with the wrong screen.

# TIMELINE — the one real run behind every capture

Every row is read out of the lane database, not out of a driver's log. The run
is `7bfbfa9d-41fa-4125-a73f-f0da9f62e970`; the two conversations are real
assistant threads written by the shipped chat route —
`c40d9526-4f74-4deb-b4d9-e90064bd84fe` for the proposal nobody touched, and
`ebac4b7c-743c-4827-8a0a-1eaca28fb762` for the run.

There is no seeded transcript and no hand-minted token anywhere in this walk. A
sentence was typed into the shipped composer; the scripted model bridge
(`CINATRA_TEST_LLM_PROVIDER=scripted`) answered it by calling the SHIPPED
producer `schedule_proposal_render` over self-MCP; the proposal ref in the
DATA_PART is the product's own.

Capture times are the `capturedAt` of the record each picture is filed with, so
a reader can line every picture up against the row it belongs to.

| UTC | what | where it is recorded |
|---|---|---|
| 15:32:11.787986 | the expired cell's schedule stated in a conversation | `cinatra.assistant_turns` (user turn, thread `c40d9526-…`) |
| 15:32:12.580552 | the assistant answers with the card — **the shipped 30-minute window starts here** | `cinatra.assistant_turns` (assistant turn, same thread) |
| 15:32:17.094047 | the run's schedule stated in a second conversation | `cinatra.assistant_turns` (user turn, thread `ebac4b7c-…`) |
| 15:32:17.853087 | the assistant answers with the card, `pending` — **C1** shot at 15:32:20.111 (light) and 15:32:26.794 (dark) | `cinatra.assistant_turns` (assistant turn, same thread) |
| 15:32:26.949 | **Confirm pressed:** the trigger is armed FIRST — `recurring`, cron `0 9 * * *`, timezone `UTC`, enabled | `cinatra.agent_run_triggers.created_at` |
| 15:32:27.009638 | and only then is the run exposed: the proposal CONSUMED — single-use, bound to this reader, org and template — and the run created, status `armed` — **C2** shot at 15:32:28.714 and 15:32:33.634 | `cinatra.trigger_schedule_proposal_consumes`, `cinatra.agent_runs` |
| 15:32:27 | the trigger's scheduler id written (install drained) | `cinatra.agent_run_triggers.updated_at` |
| 15:34:42.024 | the run page's schedule step opened by a real press of the rail row — **C3** (dark at 15:34:44.277) | the walk's own press, on the run above |
| ~16:02:12 | the untouched proposal's 30-minute window elapsed | `PROPOSAL_TTL_SECONDS = 1800`, mint at 15:32:12 |
| 16:04:46.870 | the expired reading captured — **C5** (dark at 16:04:51.358) | the walk reopened the same conversation |

The end state of the run, read back after the last capture:
`agent_runs.status = armed`, `started_at` and `completed_at` NULL;
`agent_run_triggers.released_at` NULL, `enabled = t`. Nothing in this round
released the schedule or started the agent.

## Why C4 is not here

C4 asked for the review page carrying **this run's real artifact review**. This
run has none, and the reason is on the rows above: the schedule is armed and has
not fired, so the agent has not run, so it has produced nothing for anybody to
review. A review card exists only after a run produced something.

The obstacle is not the walk's. Reaching an artifact review means letting the
agent actually execute, and the planner agent needs a real model provider. This
lane has none and must never have one. Per the standing rule that a stand-in is
never acceptable, **C4 is DROPPED from this round** rather than staged — there is
no C4 step in `capture-walk.json` to accidentally answer with the wrong screen.
It needs a lane that may hold a provider credential.

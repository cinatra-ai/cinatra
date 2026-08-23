# TIMELINE — the one real run behind every capture

Every row is read out of the lane database, not out of a driver's log. The run
is `5def4d62-70a6-497f-baf9-838b6185cfc0`; the two conversations are real
assistant threads written by the shipped chat route.

There is no seeded transcript and no minted token anywhere in this walk. A
sentence was typed into the shipped composer; the scripted model bridge
(`CINATRA_TEST_LLM_PROVIDER=scripted`) answered it by calling the SHIPPED
producer `schedule_proposal_render` over self-MCP; the proposal ref in the
DATA_PART is the product's own.

| UTC | what | where it is recorded |
|---|---|---|
| 13:04:36.275 | the expired-cell schedule stated in a conversation; card drawn `pending` | `cinatra.assistant_threads` 6ea7458e-1f30-433e-8e36-8b9bbfefa5b6 |
| 13:05:0x | the run's schedule stated in a second conversation; card drawn `pending` — **C1** | `cinatra.assistant_threads` 70d59fdc-d51c-45e0-a4ab-1436800e8a5a |
| 13:05:12.263 | **Confirm pressed** on the card in the conversation | the walk's own press, answered by the shipped decide endpoint |
| 13:05:27.793515 | the proposal CONSUMED — single-use, bound to this reader, org and template | `cinatra.trigger_schedule_proposal_consumes` |
| 13:05:27.793515 | the run created, status `armed` — **C2** shows the card after this | `cinatra.agent_runs` |
| 13:05:27.812 | the trigger armed: `recurring`, cron `0 9 * * *`, timezone `UTC`, enabled | `cinatra.agent_run_triggers` |
| 13:05:27.911 | the trigger's scheduler id written (install drained) | `cinatra.agent_run_triggers.updated_at` |
| ~13:2x | the run page's schedule step opened by a real press — **C3** | the walk's own press |
| 13:26:05.428 | **Run now pressed** — its dialog reads "Run this schedule now?" | the walk's own press |
| 13:26:05.551 | the trigger RELEASED | `cinatra.agent_run_triggers.released_at` |
| 13:26:07.165 | the run moved to `pending_approval` and materialized its setup gate | `cinatra.agent_run_hitl_gates` |
| 13:34:36 | the untouched proposal's 30-minute window elapsed | `PROPOSAL_TTL_SECONDS = 1800`, mint at 13:04:36 |
| 13:35:10+ | the expired reading captured — **C5** | the walk reopened the same conversation |

## Why C4 is not here

C4 asked for the review page with the review card carrying **this run's real
output**. This run has no such card, and could not have one on this lane.

Pressing **Run now** released the schedule and the run moved to
`pending_approval` — but the gate it materialized is a SETUP-INPUT gate
(`setup-5def4d62-…`, asking for the field `oasJson`), not an artifact review of
something the agent produced. The agent would have to run past that input gate
and generate an artifact before any artifact review exists, and running the
planner agent needs a real model provider. This lane has none and must never
have one.

So the review page answers, truthfully, **"This review is no longer open — the
gate was already decided or the run moved on."** That is the real state of the
real run, and it is not the cell that was asked for. Per the standing rule that
a stand-in is never acceptable, **C4 is DROPPED from this round** rather than
staged. It needs a lane that may hold a provider credential.

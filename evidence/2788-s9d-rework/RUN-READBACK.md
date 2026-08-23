# RUN-READBACK — the rows behind round 3's pictures

Every value below was READ BACK out of the lane database after the last capture
was taken. Nothing here is a driver's log line and nothing was written by hand:
`agent_runs`, `agent_run_triggers`, `trigger_schedule_proposal_consumes` and
`assistant_turns` are the four tables quoted, in that order.

## The run the walk armed and the scheduler fired

| field | value |
|---|---|
| `agent_runs.id` | `972d5781-c540-45b0-adfd-d3c31dba6277` |
| `agent_runs.status` | `completed` |
| `agent_runs.template_id` | `28cec3ba-b3ee-417b-9234-a35463aca887` (`@cinatra-ai/company-discovery-agent`) |
| `agent_runs.run_by` | `a2d8dd00-6bb5-4c0b-b703-67fbebba4dbe` |
| `agent_runs.created_at` | `2026-08-23 21:04:44.786750+00` |
| `agent_runs.started_at` | NULL |
| `agent_runs.completed_at` | `2026-08-23 21:22:05.409+00` |
| `agent_runs.error` | none |
| `agent_runs.step_results` | 1 entry |

CREATED-BY PATH: the run does not exist until the person presses **Confirm** on
the schedule card. The proposal was minted by the shipped producer
`schedule_proposal_render` over self-MCP; the press consumed it through the
shipped consume path, which is why there is a consume row bound to this run:

| field | value |
|---|---|
| `trigger_schedule_proposal_consumes.run_id` | `972d5781-c540-45b0-adfd-d3c31dba6277` |
| `…consumed_by` | `a2d8dd00-6bb5-4c0b-b703-67fbebba4dbe` |
| `…consumed_at` | `2026-08-23 21:04:44.786750+00` |
| `…org_id` / `…template_id` | the lane's org / the template above |

FIRED-BY: **the schedule's own tick.** Nothing in this round pressed *Run now*.

| field | value |
|---|---|
| `agent_run_triggers.trigger_type` | `scheduled` (a ONE-OFF, not a recurrence — `cron_expression` is NULL) |
| `agent_run_triggers.scheduled_at` | `2026-08-23 21:22:00+00` |
| `agent_run_triggers.timezone` | `UTC` |
| `agent_run_triggers.enabled` | `t` |
| `agent_run_triggers.job_scheduler_id` | `trigger-release-972d5781-…` (the shipped delayed job) |
| `agent_run_triggers.created_at` | `2026-08-23 21:04:44.796+00` |
| `agent_run_triggers.released_at` | **`2026-08-23 21:22:00.163+00`** |

`released_at` lands 163 ms after the second the person asked for, seventeen
minutes after the row was written, with no interaction in between. That is the
scheduler releasing its own one-off.

MODEL: **real.** The agent's model call goes out over the shipped
`/api/llm-bridge`, which resolves the instance's own sealed `openai_connection`
row through `resolveConfiguredLlmRuntime`; the row was written before the walk
through the shipped writer the setup wizard uses, from a credential held only in
the process environment. The bridge answered `200`, the runtime reported the
task `completed`, and the run reached `completed` five seconds after the fire.
No provider key was written to any file produced here.

## The fresh run C7 was photographed on

| field | value |
|---|---|
| `agent_runs.id` | `86b4a279-99a9-41a2-bba1-6f248d081820` |
| `agent_runs.status` | `completed` |
| `agent_runs.created_at` | `2026-08-23 21:08:10.765053+00` |
| `agent_run_triggers` | NO ROW — this run was never armed, which is what makes its scheduling step the FIRST-SHOWN stage |

It was created by the product's own **Run** control on `/agents`
(`/agents/<agent>/new`), which is the shipped path a person takes to start a run.

TWO RUNS, DELIBERATELY. Twelve of the fourteen pictures are the run above; C7's
two are this one, and they have to be — the setup scheduling step is the
FIRST-SHOWN stage, and an armed run has already passed it. Every other stage,
on both hosts, is the same single run.

## The two conversations

| thread | turns | first turn |
|---|---|---|
| `6b4165d5-b8fa-4c34-862c-cda396070163` (the run's) | 1 user + 2 assistant | `2026-08-23 21:04:37.906315+00` |
| `36dd7069-b611-4249-8b36-7cb41c2dd238` (the untouched proposal) | 1 user + 2 assistant | `2026-08-23 20:46:46.895970+00` |

Both are real assistant threads written by the shipped chat route. No transcript
was seeded, no turn was written by a driver and no proposal token was minted by
hand.

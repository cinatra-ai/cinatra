# RUN-READBACK — the rows behind the pictures

Round 4's run comes first, because it is the run C2 and C6 are photographed on;
round 3's two runs follow unchanged, and they are still the runs C1, C3, C5, C7
and C8 are photographed on.

Every value below was READ BACK out of the lane database after the last capture
was taken. Nothing here is a driver's log line and nothing was written by hand:
`agent_runs`, `agent_run_triggers`, `trigger_schedule_proposal_consumes`,
`assistant_turns` and — for round 4's model reading — `usage_events` are the
tables quoted.

## ROUND 4 — the run C2 and C6 are photographed on

The cell that carried a supersede line and the cell that carried a disabled
control were re-walked on a run of their own, through the same recipe. Every
value is read out of `cinatra.agent_runs`, `cinatra.agent_run_triggers`,
`cinatra.trigger_schedule_proposal_consumes`, `cinatra.assistant_turns` and
`cinatra.usage_events`.

| field | value |
|---|---|
| `agent_runs.id` | `98f50b86-8619-48bf-adf1-3278684daa02` |
| `agent_runs.status` | `completed` |
| `agent_runs.template_id` | `1c8437a3-e172-43f7-9e00-6c37eea7546c` (`@cinatra-ai/company-discovery-agent`) |
| `agent_runs.run_by` | `cb7ef761-06ac-4e39-af43-8fd3d6fc06a4` |
| `agent_runs.created_at` | `2026-08-24 09:26:33.009191+00` |
| `agent_runs.started_at` | NULL |
| `agent_runs.completed_at` | `2026-08-24 09:34:05.347+00` |
| `agent_runs.error` | none |
| `agent_runs.step_results` | 1 entry (`wayflow_response`, task `49079d45-…`) |

CREATED-BY PATH: the run does not exist until **Confirm** is pressed on the
schedule card. The proposal was minted by the shipped producer
`schedule_proposal_render` over self-MCP, and the press consumed it through the
shipped consume path:

| field | value |
|---|---|
| `trigger_schedule_proposal_consumes.run_id` | `98f50b86-8619-48bf-adf1-3278684daa02` |
| `…consumed_by` | `cb7ef761-06ac-4e39-af43-8fd3d6fc06a4` |
| `…consumed_at` | `2026-08-24 09:26:33.009191+00` |
| `…org_id` / `…template_id` | the lane's org / the template above |

ADJUSTED, THEN CONFIRMED — which is what C2's plan sentence governs, and it is
read off two rows rather than asserted. The deterministic producer proposes a
DAILY RECURRENCE and only that (`scripted-test-provider.ts`: `frequency: "daily",
interval: 1`), and the trigger the press installed is a ONE-OFF at an instant the
person typed into the card's own **Run at** field:

| field | value |
|---|---|
| `agent_run_triggers.trigger_type` | `scheduled` (a ONE-OFF — `cron_expression` is NULL) |
| `agent_run_triggers.scheduled_at` | `2026-08-24 09:34:00+00` |
| `agent_run_triggers.timezone` | `UTC` |
| `agent_run_triggers.enabled` | `t` |
| `agent_run_triggers.job_scheduler_id` | `trigger-release-98f50b86-…` (the shipped delayed job) |
| `agent_run_triggers.created_at` | `2026-08-24 09:26:33.033+00` |
| `agent_run_triggers.released_at` | **`2026-08-24 09:34:00.088+00`** |

FIRED-BY: **the schedule's own tick** — and the stamp alone is not what says so,
which is worth being exact about. `released_at` is written by
`markTriggerReleased`, and an administrator's **Run now** lands on the SAME stamp,
so the row proves release and not what caused it. Three things together identify
the release job: the walk plan contains no *Run now* action and no browser context
in this round was ever on the run page; the stamp lands 88 ms after the second the
person typed into the card, seven minutes after the row was written; and the
runtime named the actor itself, logging `[trigger-release] released gate for run
98f50b86-…` and then `[trigger-release] enqueued execution for run 98f50b86-…`
at that second.

MODEL: **real, and recorded as such by the shipped usage ledger.** The agent's
model call goes out over `/api/llm-bridge`, which resolved the instance's own
sealed `openai_connection` row (`POST /api/llm-bridge 200`, selected by this run's
own run token). The row it resolved was written before the walk through the
shipped sealed writer, from a credential held only in the process environment; no
provider key was written to any file produced here.

| field | value |
|---|---|
| `usage_events.source` / `operation` | `llm` / `generate` |
| `usage_events.provider` / `model` | `openai` / `gpt-5.5-2026-04-23` |
| `usage_events.requested_provider` / `effective_provider` | `openai` / `openai` |
| `usage_events.input_tokens` / `output_tokens` | 1918 / 34 |
| `usage_events.created_at` | `2026-08-24 09:34:04.87602+00` |

The scripted runtime never served this run: it is consulted only after real
adapter resolution finds nothing, and a scripted call would have recorded the
model `scripted-test-model` in the row above. The 424 a toolbox load can raise
without a public MCP URL did not occur, so nothing was removed on the clock.

THE CONVERSATION C2 AND C6 ARE PHOTOGRAPHED IN:

| thread | turns | first turn |
|---|---|---|
| `7d5c87b2-84e4-487a-a9f8-103df32f78d1` | 1 user + 2 assistant | `2026-08-24 09:26:29.507327+00` |

A real assistant thread written by the shipped chat route. No transcript was
seeded, no turn was written by a driver and no proposal token was minted by hand.

## ROUND 3 — the runs C1, C3, C5, C7 and C8 are photographed on

### The run round 3's walk armed and the scheduler fired

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

FIRED-BY: **the schedule's own tick**, as round 3 recorded it. Round 3's rows are
reproduced here exactly as round 3 read them back, and round 4 did not re-verify
them; the stricter reading above — `released_at` proves release and not who
released, because *Run now* writes the same stamp — applies to this row too, and
what round 3 could say for it is that its walk pressed nothing and the stamp landed
163 ms after the second the person stated.

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

### The fresh run C7 was photographed on

| field | value |
|---|---|
| `agent_runs.id` | `86b4a279-99a9-41a2-bba1-6f248d081820` |
| `agent_runs.status` | `completed` |
| `agent_runs.created_at` | `2026-08-23 21:08:10.765053+00` |
| `agent_run_triggers` | NO ROW — this run was never armed, which is what makes its scheduling step the FIRST-SHOWN stage |

It was created by the product's own **Run** control on `/agents`
(`/agents/<agent>/new`), which is the shipped path a person takes to start a run.

TWO RUNS IN ROUND 3, DELIBERATELY. C7's two pictures are this fresh run and they
have to be — the setup scheduling step is the FIRST-SHOWN stage, and an armed run
has already passed it. Every other stage round 3 photographed, on both hosts, is
the single armed run above. Round 4 then re-walked C2 and C6 on a third run, for
the reason README.md gives at the top; C1, C3, C5 and C8 still belong to the run
above.

### Round 3's two conversations

| thread | turns | first turn |
|---|---|---|
| `6b4165d5-b8fa-4c34-862c-cda396070163` (the run's) | 1 user + 2 assistant | `2026-08-23 21:04:37.906315+00` |
| `36dd7069-b611-4249-8b36-7cb41c2dd238` (the untouched proposal) | 1 user + 2 assistant | `2026-08-23 20:46:46.895970+00` |

Both are real assistant threads written by the shipped chat route. No transcript
was seeded, no turn was written by a driver and no proposal token was minted by
hand.

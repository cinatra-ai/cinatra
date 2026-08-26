# RUN-READBACK — the rows behind the pictures

Round 5's runs come first, because they are the runs ALL FOURTEEN pictures are
taken on. Rounds 4 and 3 follow, unchanged, as the record of what was withdrawn:
**no committed picture stands on them any more.**

Every value below was READ BACK out of the lane database after the last capture
was taken, from `agent_runs`, `agent_run_triggers`,
`trigger_schedule_proposal_consumes`, `assistant_turns` and `usage_events`.

**The rows are committed, not merely quoted.** `readback/db-readback.json` holds
them as `readback/read-back.mjs` printed them, unedited, and
`readback/runtime-evidence.txt` holds the server log lines this file narrates,
with the greps that produced them. Where a number below and a row there disagree,
the row is right: this prose is a reading of that file, and the file is the
record.

## ROUND 5 — the run C1, C2, C3, C6 and C8 are photographed on

| field | value |
|---|---|
| `agent_runs.id` | `9384a346-d9a6-4403-9beb-51ef347618f3` |
| `agent_runs.status` | `completed` |
| `agent_runs.template_id` | `74aed283-ea3a-451a-a9a6-d98cabe1eaf0` (`@cinatra-ai/company-discovery-agent`) |
| `agent_runs.run_by` | `cc5ede72-632d-435e-92c1-80f7ab9dfe5f` |
| `agent_runs.created_at` | `2026-08-24 17:21:18.164+00` |
| `agent_runs.started_at` | NULL |
| `agent_runs.completed_at` | `2026-08-24 17:42:12.471+00` |
| `agent_runs.error` | none |

CREATED-BY PATH: the run does not exist until **Confirm** is pressed on the
schedule card. The proposal was minted by the shipped producer
`schedule_proposal_render`, called by the REAL model over provider-hosted MCP,
and the press consumed it through the shipped consume path:

| field | value |
|---|---|
| `trigger_schedule_proposal_consumes.consume_key` | `46361b9b3254…` (the full 64-hex value is in `readback/db-readback.json`) |
| `…run_id` | `9384a346-d9a6-4403-9beb-51ef347618f3` |
| `…consumed_by` | `cc5ede72-632d-435e-92c1-80f7ab9dfe5f` |
| `…consumed_at` | `2026-08-24 17:21:18.164+00` |
| `…org_id` / `…template_id` | `e44780e4-c4fc-4e64-84ee-4a6177a6dca7` / the template above |

**THE TURN-TO-RUN BINDING, READ OFF THE THREAD AND NOT OFF "THE NEWEST ROW."**
This is the one join a reader should be able to check, so it is spelled out. The
proposal ref carried in the pictured thread's own DISPATCH PART decrypts under
this instance's key to `[version 1, templateId 74aed283-…, userId cc5ede72-…,
orgId e44780e4-…, schedule, nonce, iat 2026-08-24T17:21:12Z, exp
2026-08-24T17:51:12Z]` — a 1800-second window, which is `PROPOSAL_TTL_SECONDS`.
Its nonce derives the single-use consume identity through the shipped
`proposalConsumeKey`, and that value **is** the primary key of the consume row
above. So the run behind C3, C6 and C8 is bound to the card in the conversation
behind C1 and C2 by the proposal's own identity, not by ordering.

THE SCHEDULE THAT WAS ARMED — a ONE-OFF, at the instant the person stated:

| field | value |
|---|---|
| `agent_run_triggers.trigger_type` | `scheduled` (a ONE-OFF — `cron_expression` is NULL) |
| `agent_run_triggers.scheduled_at` | `2026-08-24 17:42:00+00` |
| `agent_run_triggers.timezone` | `UTC` |
| `agent_run_triggers.enabled` | `t` |
| `agent_run_triggers.job_scheduler_id` | `trigger-release-9384a346-…` (the shipped delayed job) |
| `agent_run_triggers.created_at` | `2026-08-24 17:21:18.181+00` |
| `agent_run_triggers.released_at` | **`2026-08-24 17:42:00.143+00`** |

FIRED-BY: **the schedule's own tick.** `released_at` alone proves RELEASE and not
WHO released — an administrator's *Run now* writes the same stamp — so three
things are given together instead of one: the walk plan contains no *Run now*
action and no context in this round was ever on the run page between Confirm and
the fire; the stamp lands **143 ms** after the second the person typed, twenty-one
minutes after the row was written; and the runtime named the actor itself, logging
`[trigger-release] released gate for run 9384a346-…` and then
`[trigger-release] enqueued execution for run 9384a346-…` at that second.

MODEL — **real on BOTH halves of this round, and recorded as such by the shipped
usage ledger.**

*The conversation.* The chat turn ran on the real provider with the platform's
tool catalogue handed over as ONE provider-hosted MCP reference. The proof is in
the thread itself: the assistant turn's parts carry
`{"type":"tool_call","name":"schedule_proposal_render","serverLabel":"cinatra",
"id":"mcp_0e1afcff…"}` — an `mcp_…`
hosted-MCP call id — and the server answered the provider's own callbacks on the
public ingress (`POST /api/mcp 200`, repeatedly, through the funnel origin).

| field | value |
|---|---|
| `usage_events.source` / `operation` | `llm` / `stream` |
| `usage_events.provider` / `model` | `openai` / `gpt-5.5` |
| `usage_events.input_tokens` / `output_tokens` | 21231 / 118 |
| `usage_events.created_at` | `2026-08-24 17:21:13.852+00` |

*The agent's own execution.* The agent runtime called back into the shipped
`/api/llm-bridge`, which resolved the instance's own sealed `openai_connection`
row by this run's own run token (`[llm-bridge-run-select] served-by=run_token
run=9384a346-… token-invalid=false token-divergent=false`, then
`POST /api/llm-bridge 200`).

| field | value |
|---|---|
| `usage_events.source` / `operation` | `llm` / `generate` |
| `usage_events.provider` / `model` | `openai` / `gpt-5.5-2026-04-23` |
| `usage_events.requested_provider` / `effective_provider` | `openai` / `openai` |
| `usage_events.input_tokens` / `output_tokens` | 37093 / 37 |
| `usage_events.created_at` | `2026-08-24 17:42:11.792+00` |

The scripted runtime served nothing in this round: it is consulted only after real
adapter resolution finds nothing, a scripted call would have recorded the model
`scripted-test-model` in the rows above, and the server log carries **zero**
scripted-runtime lines. The 424 a toolbox load can raise without a public MCP URL
did not occur.

THE CONVERSATION C1, C2 AND C6 ARE PHOTOGRAPHED IN:

| thread | turns | first turn |
|---|---|---|
| `efba5760-304d-4b6a-9ca7-80b7b9af9262` | 1 user + 2 assistant | `2026-08-24 17:21:03.867+00` |

A real assistant thread written by the shipped chat route. No transcript was
seeded, no turn was written by a driver and no proposal token was minted by hand.

### The fresh run C7 is photographed on

| field | value |
|---|---|
| `agent_runs.id` | `d8e1de27-dc8f-4559-853a-0829a991065b` |
| `agent_runs.status` | `pending_input` |
| `agent_runs.created_at` | `2026-08-24 16:43:33.532+00` |
| `agent_run_triggers` | **NO ROW** — this run was never armed, which is what makes its scheduling step the FIRST-SHOWN stage |

It was created by the product's own **Run** control on `/agents`
(`/agents/<agent>/new`), the shipped path a person takes to start a run.

### The untouched proposal C5 is photographed on

| thread | turns | first turn |
|---|---|---|
| `1bfacdfc-871f-4ecc-a9c2-de49fff427f1` | 1 user + 2 assistant | `2026-08-24 14:51:53.227+00` |

Stated at `14:51:53Z` and then left alone; `PROPOSAL_TTL_SECONDS = 1800`, so the
window ran out at about `15:21:53Z` and the cell was photographed at `15:23:49Z`.
Nothing confirmed it, no clock was moved, and no run exists for it.

### The passes this round DISCARDED, named rather than left in the ledger unexplained

The lane database holds five other armed runs. None of them is behind a committed
picture, and each was superseded for a stated reason rather than quietly dropped.
They are listed because a reader querying `agent_runs` will find them.

| run | armed for | released_at | why it is not pictured |
|---|---|---|---|
| `bb4dc438-…` | `15:15:00+00` | `15:15:00.118+00` | first pass; its dark C2 frame caught Next's dev "Compiling …" toast |
| `0ab5bfe9-…` | `15:30:00+00` | `15:30:00.126+00` | second pass; the model's longer reply pushed the person's turn out of the window |
| `fde9f2fa-…` | `15:45:00+00` | `15:45:00.041+00` | third pass; taken before the agent runtime was brought up on this lane, so it could not execute |
| `64d97494-…` | `16:35:00+00` | `16:35:00.131+00` | fourth pass; fired and executed on the real model, then failed artifact materialization — the lane's dev registry held no published copy of the agent package |
| `c800ed56-…` | `17:05:00+00` | `17:05:00.090+00` | fifth pass; same materialization failure. The operator then pressed the run page's own **Retry**, which returns a run to its setup step — that reset this run out of the fired state, which is why it was superseded rather than re-photographed |

Two things are worth reading off that table rather than only the pictured run.
**Every one of those one-offs released within 143 ms of the second it was armed
for, with nobody on the run page** — five independent corroborations that the
schedule fires on its own tick. And the two materialization failures were a LANE
gap, not a product finding: `@cinatra-ai/company-discovery-agent@0.1.2` was not
published to this lane's own dev registry, so the run package's artifact bindings
could not be loaded. Publishing it to the lane registry is what let the pictured
run reach `completed`.

---

## Earlier rounds, kept for the record

**Everything below is HISTORY.** These sections are reproduced as rounds 3 and 4
wrote them, because withdrawing a round's account is worse than keeping it; but
**no committed picture stands on any run named below** — round 5 re-shot all
fourteen. Where a sentence below reads in the present tense about which cell a run
carries, it was true when it was written and is not true now. The runs behind
today's pictures are in the round 5 section at the top of this file.

Those rounds read their values out of the lane database of the day, from
`agent_runs`, `agent_run_triggers`, `trigger_schedule_proposal_consumes`,
`assistant_turns` and `usage_events`. Unlike round 5, they committed no readback
artifact beside the prose, so their numbers cannot be re-checked against a row —
which is one of the reasons round 5 commits one.

## ROUND 4 — the run C2 and C6 WERE photographed on (superseded by round 5)

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

## ROUND 3 — the runs C1, C3, C5, C7 and C8 WERE photographed on (superseded by round 5)

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


## 5. The 2026-08-26 re-shoot (cinatra#2970, PR #2975) — the run behind C7, C9, C10 and C11

Every value below is a DATABASE column or a grep over the app server's own log,
and both are committed unedited beside this file:
`readback/2975-reshoot-readback.json` (rows + runtime screens, written by
`readback/2975-reshoot-read-back.mjs`) and `readback/2975-runtime-evidence.txt`
(the log lines, with the grep that produced each block). Nothing in this round
inserts a run, a trigger, a gate or a record.

### The run

- **run id** `2b9859f8-3efc-448e-8659-e8246713b5e2`
- **status at every shutter** `pending_approval` (read back per record in `dbAt`)
- **`agent_runs.created_at`** `2026-08-26 05:41:31.728575+00`
- **`agent_runs.started_at`** NULL — the run has never executed
- **`agent_runs.human_present`** `t`; **`source_type`** `agent_builder`
- **`agent_run_triggers`** none until Continue was pressed; then exactly one:
  `scheduled`, `scheduled_at 2026-08-26 19:30:00+00`, `timezone Europe/Berlin`,
  `enabled t`, `released_at` NULL, `job_scheduler_id trigger-release-2b9859f8-…`,
  row created `2026-08-26 05:49:58.71+00`
- **`artifact_review_gates`** 0 on the whole lane — which is why the review row
  reads "not reached"
- **run page** `/agents/cinatra-ai/blog-draft-writer-agent/2b9859f8-…/trigger`

### The provider, and the limits of what these readings establish

```
 provider |  model  | source | operation | calls | input_tokens | output_tokens |           first_at            |            last_at
----------+---------+--------+-----------+-------+--------------+---------------+-------------------------------+-------------------------------
 openai   | gpt-5.5 | llm    | stream    |     2 |        43324 |           303 | 2026-08-26 05:41:13.726925+00 | 2026-08-26 05:41:39.278666+00
(1 row)
```

The provider was configured through the app's own `/setup/model` form, so the app
sealed the connection itself; the credential is in no file, no argument, no log and
no record here.

**The runtime screens** (a hit is proof of a problem; a zero is the absence of that
particular line and nothing more):

| screen | reading |
|---|---|
| `scriptedRuntimeLines` | 0 |
| `preRouterAttempts` / `preRouterShortCircuits` | 0 / 0 |
| `noProviderRefusals` | 0 |
| `mcpToolListRecoveries` (the cold 424 earlier rounds saw) | 0 |
| `mcpPublicUnreachableRefusals` | **2** — the two turns refused before the ingress was warmed; see below |
| `publicMcpCallbacks` (positive, unattributed) | **8** |
| `bridgeRunSelects` (positive) | 0 — no run executed this round |

**What CANNOT be established here, said plainly.** This host prints **no
environment at all** for the listening process — `ps -Ewww` returns zero `KEY=`
tokens under macOS System Integrity Protection — so
`serverScriptedProviderEnv: null` establishes NOTHING, and the readback records
`serverEnvAvailable: false` beside it rather than letting the null read as
"absent". What IS positively established is elsewhere: the usage rows above, the
eight callbacks from the provider's own servers into this instance's `/api/mcp`
over the public origin, the zero scripted-runtime lines, and the fact that the
server was launched with the switch explicitly removed from its environment.

### The one fallback in this round, named

The runtime HEADs the public MCP URL with a 2.5-second budget before every turn and
refuses the turn outright if it does not answer (`#1699`). The FIRST TLS handshake
through this lane's ingress takes about five seconds; warmed it takes about 0.3 s.
Two chat turns were refused for that reason before the ingress was warmed with one
HEAD request. Both refusals are quoted in `readback/2975-runtime-evidence.txt`,
left in rather than trimmed out. Nothing was stood in for, and the measured turn
ran on the real provider through the real public toolbox.

### The direct-SQL lane writes, disclosed — there is one driver that writes

`evidence/2970-setup-rail/drivers/11-lane-identity.mjs` makes the throwaway lane
account an administrator (`UPDATE public."user" SET role='admin'`) and writes ONE
Better Auth membership row (`INSERT INTO public.member`) so the account is a member
of the organization the instance's own boot import stamped every agent template
with. Both are account provisioning on a database that is dropped when the lane
ends; neither touches a run, a trigger, a gate, a record or any row a photographed
screen reads. This round creates NO second organization — round 5's driver pair did,
and a second organization is a lane artefact a picture of the product should never
carry.

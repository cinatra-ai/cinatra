# RUN READBACK — the rows the pictures stand on

Every value below is read out of the database by
`drivers/13-run-readback.mjs`, whose whole output is
`readback/run-readback.json`. Nothing in this lane inserts a run, a trigger, a
gate, a park, a record or a review task: the rows are the app's own, created by
its own dispatch out of the sequence in `TIMELINE.md`.

## 1. The run in the pictures

- **run id** `d7086390-20bb-425c-9bfd-a12e68d404f4`
- **template** `@cinatra-ai/blog-draft-writer-agent` (`agent_templates.type` `leaf`,
  `source_type` `internal`, `status` `published`; its approval policy projects
  **zero** renderer-gate steps, which is what puts its run page on the branch that
  mounts this card — `runDetailPanelKind`,
  `packages/agents/src/instance-screens.tsx:331`–`345`)
- **`agent_runs.created_at`** `2026-08-26T23:20:52.007Z`
- **`agent_runs.started_at`** NULL at both HITL screens — the run had not executed
  when it first asked, and the setup park is a pre-execution park
- **`agent_runs.completed_at`** `2026-08-27T00:03:34.767Z`
- **`agent_runs.human_present`** `true`
- **`agent_runs.source_type`** `agent_builder`
- **run page** `/agents/cinatra-ai/blog-draft-writer-agent/d7086390-20bb-425c-9bfd-a12e68d404f4`
- **review page** `/agents/cinatra-ai/blog-draft-writer-agent/d7086390-20bb-425c-9bfd-a12e68d404f4/review/lifecycle-review:046e55ca9f1b8ff97f21c61d658f15990a01412dd38c8147955a9d7e5b0375a9`

### The moment the run recorded, and the one it did not

| gate | `review_task_id` | `x_renderer` | `field_name` | `lifecycle_moment` / `lifecycle_card_kind` / `lifecycle_card_ref` |
|---|---|---|---|---|
| setup | `setup-d7086390-20bb-425c-9bfd-a12e68d404f4` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `hitl` / `agent_hitl_screen` / `setup-d7086390-20bb-425c-9bfd-a12e68d404f4` |
| mid-run | `wayflow-c8a1367a-22bb-4f6f-8200-2f8c8d8335bd` | `@cinatra-ai/context-selection-agent:context-selector` | (none) | **none — the row states no moment** |

Both rows are in `cinatra.agent_run_hitl_gates`, materialised at
`2026-08-26T23:20:53.058Z` and `2026-08-26T23:52:31.658Z`. The asymmetry is the
shipped one and is worth stating plainly: `packages/agents/src/execution.ts:2673`
records the moment for the SETUP LOOP ONLY — *"The generic mid-run gate in
`handleWayflowTaskState` is an APPROVAL of work already done … Which moment that
gate is at belongs to the review core"* — so the mid-run screen is drawn from the
run's derived HITL context with `screenRef` `null`, exactly as
`packages/agents/src/agent-hitl-screen-core.ts:105`–`115` says it will be. The
card's condition is the run panel's condition, not the stated moment, which is
why the mid-run question has a card at all.

### `input_params`, before and after each Continue

| moment | `agent_runs.status` | `agent_runs.input_params` |
|---|---|---|
| at the setup screen (before the press) | `pending_approval` | `{}` |
| after the press in the card, `2026-08-26T23:42:47.829Z` | `pending_trigger` | `{"idea": {"title": "How small teams keep their customer research organised"}}` |
| at the mid-run screen | `pending_approval` | unchanged |
| after the card's own Continue, `2026-08-27T00:03:45.761Z` | `completed` | unchanged |

The reader's typed value is merged into the run's own inputs under the gate's own
field name, which is what the setup ladder keys off. The mid-run press changes no
input — that gate answers a context slot, not a field — and its proof is the
status: the run left `pending_approval` and finished.

### Triggers and review gates

- `cinatra.agent_run_triggers` — **no row**. The run was released by the trigger
  step's *Run right after setup* option, which is the immediate kind and writes no
  persistent trigger row.
- `cinatra.artifact_review_gates` — **one row**, opened after the run completed:
  `9486766b-f29b-4462-9b6b-09c05b42f029`, `review_task_id`
  `lifecycle-review:046e55ca…`, status `pending`. That row is what makes the
  review page exist, and `README.md` states why the HITL card is correctly absent
  on it.

### The transcript's own tool calls

Read from `cinatra.assistant_turns` rather than from the pixels:
`agent_run`, `skill_file_read`, `agent_run_get`. **No lifecycle-card tool call of
any kind** — not `artifact_review_gate_render`, not `schedule_proposal_render`,
not `verification_record_render`, not `lifecycle_bound_card_decide`. The card
arrives at the `agent_run` dispatch part's own slot from the run's state, which is
what the pull request claims.

## 2. Every run row on the lane at the end

One run. `readback/run-readback.json` carries the whole table; there is nothing
else in it, because this lane created exactly one.

## 3. The provider, and what the readings can and cannot establish

`CINATRA_TEST_LLM_PROVIDER` is set in nothing this lane starts, and no driver
starts a process with it. The process-table reading that other rounds report
**could not be taken on this host**: `ps -E` returned no environment tokens for
the listening process (`tokensSeen: 0` in
`readback/run-readback.json > serverScriptedProviderEnv`), so that particular
screen is INCONCLUSIVE here rather than a pass. It is reported as such.

What is positively established is the other side — the calls the instance actually
made, from `cinatra.usage_events`:

```
 provider |       model        | source | operation | calls | input_tokens | output_tokens |          first_at          |          last_at
----------+--------------------+--------+-----------+-------+--------------+---------------+----------------------------+----------------------------
 openai   | gpt-5.5-2026-04-23 | llm    | generate  |    11 |        57544 |          2573 | 2026-08-27 00:03:31.922+00 | 2026-08-27 00:04:14.428+00
 openai   | gpt-5.5            | llm    | stream    |     2 |        43919 |           370 | 2026-08-26 23:20:39.650+00 | 2026-08-26 23:21:00.778+00
```

The two streamed calls are the warm-up turn and the measured turn in the app's own
chat; the eleven generate calls are the run's own work, between the mid-run press
and the completion. The provider was configured through the app's own
`/setup/model` form and the app sealed the connection itself; the credential is in
no file here, in no argument, in no log and in no record.

**The negative screens**, over the app server's own log for this session. A hit is
proof of a problem; a zero is the absence of that particular line and nothing
more:

| screen | reading |
|---|---|
| `scriptedRuntimeLines` (`CINATRA_TEST_LLM_PROVIDER` / "scripted provider" / "scripted-llm") | 0 |
| `noProviderRefusals` ("no provider configured") | 0 |
| `mcpToolListFailures` ("MCP tool enumeration failed") | 0 |
| `publicMcpRefusals` ("public MCP URL … is not reachable") | 0 |
| `bridgeRunSelects` | 0 |

(`sessionLogBytes` 371613 — the screens are read over the whole session's log, and
the earlier cold-path refusal quoted in `TIMELINE.md` belongs to a PREVIOUS server
session whose log this one replaced. It is reported there rather than hidden.)

## 4. Every direct-SQL write this lane made — the whole list

1. `UPDATE public."user" SET role='admin' WHERE email=$1` — `drivers/01-lane-setup.mjs:31`
2. `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")` — `drivers/04-join-template-org.mjs:20`

Both are Better Auth account provisioning for a throwaway lane account on a
database that is dropped when the lane ends. **Neither touches a run, a trigger, a
gate, a park, a record, a review task or any row a photographed screen reads.**
`grep -rniE "insert into|update |delete from" drivers/` returns exactly these two
and nothing else.

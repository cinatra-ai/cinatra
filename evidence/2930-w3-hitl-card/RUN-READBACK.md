# RUN-READBACK — cinatra#2930 W3 (PR #3014), the picture leg re-driven at this head

Every row below is read out of the database or the app server's own log by
`drivers/13-run-readback.mjs` and `drivers/17-register-records.mjs`; the raw output is
`readback/run-readback.json` and `readback/run-page-settled-probe.json`. Nothing in this round wrote a
run, a gate, a trigger, a park, a record or a review task by hand.

## The runs

| run | status | created | completed | a2a task | moment at capture | human present | source |
|---|---|---|---|---|---|---|---|
| `9dc2d652-4d09-480c-97e5-184a99cc3466` | **failed** | `13:50:58.272Z` | `14:02:26.557Z` | `a2d51aff-…` | — | true | `agent_builder` |
| **`6928e825-6eb0-49da-88ae-a9faf446a5bc`** | **completed** | `14:11:03.562Z` | **`14:20:19.843Z`** | `0afeda2a-…` | — | true | `agent_builder` |

The first run failed at dispatch on this round's own environment — the agent runtime container held no
bridge token, so `/api/context-resolve` refused its callback (`code=forbidden … bridge auth failed`).
It is kept in the readback rather than deleted. **Every cell stands on the second run.**

## The HITL gates

| run | `review_task_id` | `x_renderer` | field | created | materialised |
|---|---|---|---|---|---|
| `9dc2d652…` | `setup-9dc2d652-…` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `13:50:59.334Z` | `13:50:59.335Z` |
| `6928e825…` | `setup-6928e825-…` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `14:11:04.553Z` | `14:11:04.554Z` |
| `6928e825…` | `wayflow-f1a87077-1de0-42a5-bdd8-bbfda070f836` | `@cinatra-ai/context-selection-agent:context-selector` | *(none)* | `14:16:19.411Z` | `14:16:19.412Z` |

## The two Continue readbacks

### The SETUP gate — pressed IN the card, on `chat_thread`

| | before | after |
|---|---|---|
| read at | `2026-08-27T14:14:38.141Z` | `2026-08-27T14:15:54.802Z` |
| `status` | `pending_approval` | **`pending_trigger`** |
| `lifecycle_moment` | `hitl` | `schedule` |
| `lifecycle_card_kind` | `agent_hitl_screen` | `trigger_schedule_proposal` |
| `input_params` | `{}` | **`{"idea": {"title": "How small teams keep customer research organised"}}`** |

The app's own shipped server action took it, from the conversation host, with the reader's value
wrapped under the gate's OWN field name:

```
[approveReviewTaskInternal] setup-path resumed run=6928e825-… fieldName=idea actor=55884fd9-…
  ƒ approveReviewTask("setup-6928e825-…", {"idea":{"title":"How small teams keep customer research organised"}}, "idea")
    in 52ms  packages/agents/src/hitl-actions.ts
```

There is no second submit path: this is the same action the run page's Continue calls.

### The MID-RUN gate — pressed IN the card, on `chat_thread`

| | before | after |
|---|---|---|
| read at | `2026-08-27T14:19:06.964Z` | `2026-08-27T14:20:36.887Z` |
| `status` | `pending_approval` | **`completed`** |
| `completed_at` | *(null)* | **`2026-08-27T14:20:19.843Z`** |
| `a2a_task_id` | `f1a87077-1de0-42a5-bdd8-bbfda070f836` | `0afeda2a-6a17-452f-952e-d12f72eba427` |
| review gates for this run | **0** | **1**, `pending` |

```
[wayflow] run=6928e825-… task=0afeda2a-… state=completed status={"state":"completed","timestamp":"2026-08-27T14:20:18.355945"}
[approveReviewTaskInternal] wayflow-path resumed run=6928e825-… task=f1a87077-… actor=55884fd9-… resultState=completed
[lifecycle-review-orchestration] scanned=1 gatesCreated=1 noGate=0 notClassifiable=0 failed=0
```

## What the run produced

| | |
|---|---|
| review gate | `777841e8-81fd-4a73-a5a0-ad814e7cb83e`, `lifecycle-review:b61c5e70ae488125c0c4ea3dd2a73a400825339650744fa1117affb9c5b31887`, **`pending`**, created `2026-08-27T14:20:22.929Z` |
| artifact | *How Small Teams Keep Customer Research Organized*, `@cinatra-ai/blog-post-artifact:post`, revision `4b04877e-7a5…`, ownership organization, `text/markdown`, updated `2026-08-27T14:20:32.199Z` |
| trigger | `immediate`, `Europe/Berlin`, created `14:16:17.440Z`, released `14:16:17.443Z` |

## The provider — real, and configured through the app's own form

| provider | model | source | operation | calls | input tokens | output tokens | first | last |
|---|---|---|---|---|---|---|---|---|
| `openai` | `gpt-5.5` | `llm` | `stream` | **3** | 64,520 | 802 | `13:50:45.276Z` | `14:11:05.974Z` |
| `openai` | `gpt-5.5-2026-04-23` | `llm` | `generate` | **11** | 59,004 | 2,752 | `14:20:18.347Z` | `14:20:58.407Z` |

## The negative screens

A hit is proof of a problem; a zero is the absence of that particular line and nothing more.

| screen | count |
|---|---|
| scripted-runtime lines in the whole session log | **0** |
| "no provider configured" refusals | **0** |
| MCP tool-enumeration failures | **0** |
| public-MCP refusals ("is not reachable" / "is unreachable") | **0** — the ingress was warmed before the first pictured turn |
| `POST /api/mcp 200` callbacks from the provider's own servers over the public ingress | **12** |
| `[llm-bridge-run-select]` lines from the agent runtime | **1** |
| session log bytes screened | 590,974 |

`CINATRA_TEST_LLM_PROVIDER` is set in nothing this round starts, and each driver aborts if it finds
it. The process-table read establishes nothing on this host: `ps -E` prints no environment for the
listening process (`tokensSeen: 0`), which is recorded as a limit rather than as evidence.

## The transcript

| | |
|---|---|
| tool calls in the assistant's turns | `agent_run`, `agent_list`, `agent_run` — **nothing lifecycle-shaped** |
| threads | `4ca2006a-…` (the failed run), **`e84977d4-3427-4210-9b6b-d3b7d42d8fce`** (every cell) |

## The run page's settled reading — probed, not claimed

`readback/run-page-settled-probe.json`, both themes, after `completed`:

| theme | at | `agent_hitl_screen` | `hitl-screen-fields` | `submit-hitl-screen` | what the surface draws instead |
|---|---|---|---|---|---|
| light | `14:29:53.843Z` | **0** | **0** | **0** | `artifact_review_gate` / `run_card` / `pending` |
| dark | `14:30:07.085Z` | **0** | **0** | **0** | `artifact_review_gate` / `run_card` / `pending` |

## The capture index

| | |
|---|---|
| records before | **89** |
| records after | **93** — 8 replaced in place, 4 added |
| this kind's records | **12** — 8 `pending`, **4 `decided`, each pinning the absence** |
| shipped validator (`graded` tier) | accepts all **93** |
| `chat-hitl-acceptance-gate` | exit 0 — 16 rows, capture index host-anchored, **93 records**, anchor contract ratified at the manifest's design pin |
| anchor digest | `recorded == recomputed == fa31fa2f1e73b545ba42e923636af4e4ac6025d623b6c5fdcc68d32342994d46` — **unchanged** |

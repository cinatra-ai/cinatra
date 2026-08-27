# TIMELINE — the shutters beside the database's own clock

Every row marked **db** is a database column, named where it is read from. Every
row marked **shutter** is `recordedAt` in `capture-records.json`, taken by the
capture driver at the moment it wrote the image. Every row marked **driver** is a
driver's own clock at the instant it acted on the page. All times UTC.

## The run, from the sentence to the review gate

| at | source | what |
|---|---|---|
| 2026-08-26T23:20:24.434Z | db · `assistant_threads.created_at` | the conversation is minted by the product |
| 2026-08-26T23:20:39.650Z | db · `usage_events.first_at` | the first real model call of the measured sequence (`openai` / `gpt-5.5`, streamed) |
| ~2026-08-26T23:20:4x | driver | the person asks, in their own words: *"Please run the Blog Draft Writer Agent for me now."* |
| 2026-08-26T23:20:52.007Z | db · `agent_runs.created_at` | the app's own dispatch creates the run `d7086390-20bb-425c-9bfd-a12e68d404f4` |
| 2026-08-26T23:20:53.058Z | db · `agent_run_hitl_gates.materialized_at` | the SETUP gate is materialised: `setup-d7086390…`, renderer `@cinatra-ai/agent-builder:schema-field-fallback`, field `idea` |
| 2026-08-26T23:20:53.064Z | db · `agent_run_hitl_gates.created_at` | the durable row for that gate |
| 2026-08-26T23:21:00.778Z | db · `usage_events.last_at` (stream) | the assistant's own turn finishes |
| **2026-08-26T23:37:39.060Z** | **shutter** | `HC-light__chat_thread__hitl-screen-asking` — db at the shutter: `pending_approval`, moment `hitl` |
| **2026-08-26T23:37:50.792Z** | **shutter** | `HC-dark__chat_thread__hitl-screen-asking` |
| **2026-08-26T23:37:59.819Z** | **shutter** | `HR-light__run_card__hitl-screen-asking` |
| **2026-08-26T23:38:09.011Z** | **shutter** | `HR-dark__run_card__hitl-screen-asking` |
| 2026-08-26T23:42:34.643Z | db · readback | before the press: `pending_approval`, `input_params` `{}` |
| 2026-08-26T23:42:46.796Z | driver | the answer is typed into the field the card draws |
| **2026-08-26T23:42:46.802Z** | **driver** | **`Continue` is pressed INSIDE the card**, in the conversation (the cookie host) |
| 2026-08-26T23:42:47.829Z | db · readback | after the press: `pending_trigger`, `input_params` `{"idea": {"title": "How small teams keep their customer research organised"}}` |
| **2026-08-26T23:44:36.253Z** | **shutter** | `HCS-light__chat_thread__hitl-screen-none` — every card anchor 0 |
| **2026-08-26T23:44:47.309Z** | **shutter** | `HCS-dark__chat_thread__hitl-screen-none` |
| 2026-08-26T23:51:47.809Z | db · readback | before the dispatch: `pending_trigger`, no trigger row |
| 2026-08-26T23:51:51.742Z | driver | *Run right after setup* + `Continue` pressed on the run's own trigger step |
| 2026-08-26T23:51:54.014Z | db · readback | the run is `running` |
| 2026-08-26T23:52:31.658Z | db · `agent_run_hitl_gates.materialized_at` | the MID-RUN gate is materialised: `wayflow-c8a1367a-22bb-4f6f-8200-2f8c8d8335bd`, renderer `@cinatra-ai/context-selection-agent:context-selector` |
| 2026-08-26T23:52:32.171Z | db · readback | the run is `pending_approval` again, on that gate |
| **2026-08-26T23:53:47.780Z** | **shutter** | `HRM-light__run_card__hitl-screen-asking-midrun` — the card's own Continue counted 1 |
| **2026-08-26T23:53:57.652Z** | **shutter** | `HRM-dark__run_card__hitl-screen-asking-midrun` |
| **2026-08-26T23:56:45.409Z** | **shutter** | `HCM-light__chat_thread__hitl-screen-asking-midrun` |
| **2026-08-26T23:57:00.551Z** | **shutter** | `HCM-dark__chat_thread__hitl-screen-asking-midrun` |
| 2026-08-27T00:01:55.740Z | db · readback | before the second press: `pending_approval` |
| **2026-08-27T00:02:06.956Z** | **driver** | **the card's OWN `Continue` — `[data-action="submit-hitl-screen"]` — is pressed in the conversation** |
| 2026-08-27T00:03:31.922Z | db · `usage_events.first_at` (generate) | the run's own model work begins (`openai` / `gpt-5.5-2026-04-23`) |
| 2026-08-27T00:03:34.767Z | db · `agent_runs.completed_at` | the run completes |
| 2026-08-27T00:04:14.428Z | db · `usage_events.last_at` (generate) | the last model call of the run |
| **2026-08-27T00:05:52.052Z** | **shutter** | `HP-light__page_gate_region__hitl-screen-none` — the region holds the review card, not this one |
| **2026-08-27T00:06:08.285Z** | **shutter** | `HP-dark__page_gate_region__hitl-screen-none` |

## What the gap between a shutter and its state means

The four `HC`/`HR` shutters stand about sixteen minutes after the park. That is a
lane fact, not a product one: a parked run stays parked until somebody answers it,
and the two host cells and their two themes were shot from four separate browser
contexts in one pass. The database readback carried on every record
(`dbAt.read_at`) is taken at the shutter itself, so each picture states the row it
was taken against rather than inheriting an earlier reading.

The two mid-run run-page shutters precede the two chat ones by three minutes for
the same reason, and the run was parked on the same gate throughout: one gate row,
materialised once at `23:52:31.658Z`, and one `pending_approval` interval that
ends at the press at `00:02:06.956Z`.

## The one fallback in this lane, named

The model's hosted MCP connector fetches this instance's tool list over the public
origin, and on the FIRST turn of a cold path that fetch can exceed the runtime's
2.5 s budget; the app then refuses the turn outright with *"Cinatra tools are
unavailable: the public MCP URL … is not reachable (no response within 2500ms)"*.
That happened on an earlier attempt of this lane, before the origin's route had
ever been compiled — the refusal is in that attempt's own assistant turn and its
run count is zero, which is why no run exists for it. The measured sequence above
was driven after the route was warmed, and it sends a **warm-up turn first**; the
negative screens in `RUN-READBACK.md` §3 are read from the log offset taken after
that warm-up was answered.

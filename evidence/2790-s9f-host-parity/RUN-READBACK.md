# cinatra#2790 (S9f) — the pictured run, read out of the database

Every LIFECYCLE value below is a column read from the capture lane's own database
with `psql`, on the run the eight rework cells photograph. The raw `psql` output
is committed beside this file as `logs/rework-db-readback.txt`, so every
microsecond quoted here can be found in it. The capture times are the recorder's
own `recordedAt`, the press times are the driver's clock and the runtime
completion is WayFlow's own status payload — each row says which. Nothing
anywhere is read off a screen, and nothing is hand-written.

The run: **`8ff25a9b-2e54-4daf-acd1-9688a1e196b1`**, started from the
conversation `/chat/cinatra-ai/cinatra-assistant/…` by one typed turn.

## Who created it, who decided it, and what model was configured

| Question | Answer | Column it was read from |
|---|---|---|
| Created by | `6beab699-f0dc-47fd-b0d5-b191e44e4d9b` — the lane's own signed-in person, the same account the browser typed the turn as | `cinatra.agent_runs.run_by` |
| Person present? | `t` | `cinatra.agent_runs.human_present` |
| How it was started | `agent_builder` source, dispatched by the chat turn's hard pre-router | `cinatra.agent_runs.source_type` |
| Organization | `d78e8d02-6bd3-4652-bd80-d419addd1f89` | `cinatra.agent_runs.org_id` |
| Agent | `@cinatra-ai/blog-draft-writer-agent` (template `83c38f46-1b9f-42d7-87ab-2c4f82644f5d`) | `cinatra.agent_runs.template_id` → `cinatra.agent_templates.package_name` |
| Decided by | the same person, through the card's own per-chip controls in the chat — four presses, `confirm`, `adjust` → *"Keep it in this run"*, `skip`, `confirm` | `logs/rework-sequence.txt` (`PRESS …` lines) and the selection rows below |
| How this run id was bound to this turn | the driver's STRONG binding (the inline run panel's own link-out) did not resolve at that instant, so it fell back to the newest `agent_runs` row — `runIdSource: "newest agent_runs row"` in `logs/rework-sequence-state.json`. The independent check is in the PICTURE: the assistant's own dispatch line prints `runId: 8ff25a9b-2e54-4daf-acd1-9688a1e196b1` in the transcript, legible in both `S1` cells, and the whole lane holds three runs whose ids and times are in `logs/rework-db-readback.txt` | `logs/rework-sequence-state.json`, the `S1` pictures, `cinatra.agent_runs` |
| Model configured when the run was created | a REAL sealed OpenAI connection, `defaultModel` **`gpt-5.5`**, `serviceTier` `flex` | `cinatra.metadata` row `openai_connection`, written by the shipped `writeOpenAIConnection` |

## The clock

`cinatra.agent_runs.created_at` IS trusted on this lane: the schema carries
`core__0096_agent-run-created-at-immutable`, and the column reads **before** the
park it could only be parked on once it existed (`23:38:20.260` < `23:38:21.032`).
Earlier rounds in this lane could not trust it; this one can, and the two rows
agree.

| # | What happened | Time (UTC, 2026-08-23) | Read from |
|---|---|---|---|
| 1 | The run was created, person-present, from the conversation | `23:38:20.260378` | `cinatra.agent_runs.created_at` |
| 2 | It PARKED at the recommendation hold | `23:38:21.032623` | `cinatra.lifecycle_continuation_park.created_at` (`checkpoint=recommendation`, `status=parked`) |
| 3 | `S1` was photographed with NOTHING produced — representation, produced-outbox and review-gate rows for this run all **0** | `23:38:38.695` / `23:38:39.757` | the `dbAt` block on each `S1` record, `recordedAt` on the same records |
| 4 | `R5` was photographed on the run page with the SAME hold still `parked` | `23:38:56.218` / `23:38:57.256` | `dbAt`/`recordedAt` on the two `R5` records |
| 5 | The real provider connection was removed so the step's model call would resolve the scripted runtime | `23:38:59.845` | `timeline-rework.json` row `T1c`, with the shipped writer's own read-back (`storeResolvesAKey: false`) |
| 6 | The three kept decisions were written — `blog-post-matcher → user_adjusted`, `blog-writing → recommended_confirmed`, `web-research → recommended_confirmed` (one release transaction, one timestamp) | `23:39:20.352069` | `cinatra.run_selected_skill_revisions.selected_at` + `.selection_source` |
| 7 | The hold was RELEASED | `23:39:20.358286` | `cinatra.lifecycle_continuation_park.resolved_at`, `status=released` |
| 8 | `S2` was photographed — the row settled in place, after a reload | `23:39:46.673` / `23:39:47.760` | `recordedAt` on the two `S2` records |
| 9 | The step ran in the WayFlow runtime; its model call to `POST /api/llm-bridge` answered **200** and the flow reached `completed` inside the runtime | `23:39:49.956579` | the runtime's own status payload in the app log: `[wayflow] run=8ff25a9b… state=completed` |
| 10 | The run reached its terminal state — `failed` at artifact materialization | `23:39:50.537` | `cinatra.agent_runs.completed_at` + `.error` |
| 11 | `R6` was photographed on the run page with the question decided | `23:40:10.326` / `23:40:11.412` | `recordedAt` on the two `R6` records |

## What the run produced, and what it did not

| Table | Rows for this run |
|---|---|
| `cinatra.run_selected_skill_revisions` | **3** — the three kept skills, above |
| `cinatra.representation` | **0** |
| `cinatra.artifact_produced_outbox` | **0** |
| `cinatra.artifact_review_gates` | **0** |

`cinatra.agent_runs.error`, verbatim:

```
artifact materialization failed — the run declared artifact output(s) it did not
produce (1 of 1 failed): content [@cinatra-ai/blog-post-artifact]: titleFrom
output "title" did not resolve to a non-empty string
```

That failure is DOWNSTREAM of everything the eight cells show, and it is a lane
fact rather than a statement about this branch: the flow completed inside the
runtime, and the artifact binding then found no `title` in what the SCRIPTED
model returned. The recommendation hold, the chips, the decision, the release
and the dispatch — the whole surface these pictures are about — all landed, and
the rows above are the proof.

## The two attempts before it, and why they are named here

Both are on the same lane database and both are readable in `cinatra.agent_runs`.

| Run | Died at | What it establishes |
|---|---|---|
| `7eddddbb-25cd-4ff2-9523-f22c1587ede3` | `POST /api/llm-bridge` **500** | The step's model call went to the REAL configured provider, and the provider could not load this instance's cinatra toolbox: *"could not reach this instance's public MCP server … HTTP 424 Failed Dependency"*. This machine has no public MCP ingress. That is the measured reason the pictured run does not finish on the real model. |
| `a2622ce0-0690-470c-8944-640f46ff778a` | artifact binding resolution | The lane registry held none of the extension packages, so the materializer could not read the run package's bindings (`404 … no such package available`). Fixed by publishing the lane's own extension checkouts to the lane registry before the pictured run. |

## What is NOT in this directory

No credential and nothing derived from one. The provider key reached exactly one
process — the seeding step, through its environment, inside the operator's
secret-manager `run` wrapper — and that step reports presence and the published
model name only. The `openai_connection` row as it stands after the sequence
carries no sealed key at all (the mid-sequence clear), which the row itself
shows: `{"defaultModel":"gpt-5.5","serviceTier":"flex",…}` with no key member.

# cinatra#2790 (S9f) — the order the run actually happened in

Every row below is a timestamp READ FROM THE DATABASE or from a runtime log, not
from a screen and not from a narrative. The right-hand column names the exact
source of each one. All times are UTC on 2026-08-22; `timeline.json` beside this
file carries the same rows machine-readably.

The run: `e7c77fc6-da28-4bca-80f7-46c56867772e`, started **person-present** from
`/agents/cinatra-ai/blog-draft-writer-agent/new`, on the capture lane's own
database.

## Which column is trusted, and why one is not

**`agent_runs.created_at` is NOT trusted as the run's creation time, and this
round measured why.** On this run it reads `17:04:22.009` — *byte-identical to
`completed_at`*, forty-nine seconds AFTER the recommendation hold that the run
could only have parked on once it already existed. The terminal write appears to
overwrite the column. (The previous round on this branch observed the same thing
on a run that ended `failed`; this run ended `completed`, so the overwrite is not
a failure-path artefact.)

So the run's existence is anchored on rows that are written once and never
rewritten:

* **`lifecycle_continuation_park.created_at`** — the hold row. The run must
  exist before it can be parked, so this is an UPPER BOUND on creation that is
  never revised.
* **`cinatra.representation.created_at` / `.created_by_run_id`** and
  **`artifact_produced_outbox.created_at`** — the output the step wrote.
* **`artifact_review_gates.created_at`** — the gate the sweeper opened.

## The sequence

| # | What happened | Time (UTC) | Read from |
|---|---|---|---|
| 1 | The recorder opened the run-start page in a real browser | `17:02:43.142` | `logs/real-sequence.txt` first line (the driver's own clock) |
| 2 | **The run was created, person-present, and PARKED at the recommendation hold** | `17:02:53.103178` | `cinatra.lifecycle_continuation_park.created_at` — `checkpoint=recommendation`, `status=parked`. **NOT** `agent_runs.created_at`; see above |
| 3 | **The four chips were decided one at a time**, through the card's own per-chip controls — `confirm`, `adjust` → *“Keep it in this run”*, `skip`, `confirm` | presses between `17:02:53` and `17:03:10` | `logs/real-sequence.txt` (`PRESS …` lines, in order) |
| 4 | **The three kept decisions were written** — `blog-post-matcher → recommended_confirmed`, `blog-writing → user_adjusted`, `web-research → recommended_confirmed` (one release transaction, one timestamp) | `17:03:10.434846` | `cinatra.run_selected_skill_revisions.selected_at` + `.selection_source` |
| 5 | **The hold was RELEASED** | `17:03:10.446268` | `cinatra.lifecycle_continuation_park.resolved_at`, `status=released` |
| 6 | **The WayFlow dispatch was ACCEPTED** and the flow's first step ran inside the runtime, parking on its own context-slot gate | `17:03:58.606715` | the runtime's own status payload in the app log: `[wayflow] run=e7c77fc6… state=input-required status={…,"timestamp":"2026-08-22T17:03:58.606715"}`, and `POST /agents/cinatra-ai/blog-draft-writer-agent/ 200 OK` in the WayFlow container log |
| 7 | The run's own in-flight gate was answered (`Continue`) | `17:04:01.976` | `logs/real-sequence.txt` (`GATE Continue pressed (#1)`), `logs/run-execution-readback.json` `gatePresses[0].at` |
| 8 | **THE STEP EXECUTED** — the agent's model call went out through the bridge and came back | model call returned by `17:04:20`; step `completed` at `17:04:20.800435` | `POST /api/llm-bridge 200 in 18.1s` in the app log (the bridge answered **200**, not the previous round's 503), then `[wayflow] run=e7c77fc6… state=completed status={…,"timestamp":"2026-08-22T17:04:20.800435"}` |
| 9 | **THE OUTPUT ARTIFACT WAS WRITTEN BY THE STEP** — `Connector Rollout Note`, `text/markdown`, 5 695 bytes | `17:04:21.865797` | `cinatra.representation.created_at` with `created_by_run_id = e7c77fc6…`, and `cinatra.artifact_produced_outbox.created_at` with `producer_run_id = e7c77fc6…`, `emitter=createSemanticArtifact`, `origin_kind=agent_produced` |
| 10 | The run reached its terminal state | `17:04:22.009` | `cinatra.agent_runs.completed_at`, `status=completed`, `error` empty |
| 11 | **THE SHIPPED SWEEPER OPENED THE REVIEW** | `17:04:46.914590` | `cinatra.artifact_review_gates.created_at`, `status=pending`; the sweep itself in the app log: `[lifecycle-review-orchestration] scanned=1 gatesCreated=1 noGate=0 notClassifiable=0 failed=0` |
| 12 | The produced-artifact outbox row was processed | `17:04:47.249846` | `cinatra.artifact_produced_outbox.processed_at` |
| 13 | **The review page was CAPTURED** — `R1`–`R4` | `17:30:21.550` … `17:30:22.839` | `capture-records.json` `recordedAt` on each of the four cells |

## What the order proves

Read down the table: **every chip decision (row 4, `17:03:10`) is earlier than
the step that used those skills (row 8, `17:04:20`), which is earlier than the
artifact that step wrote (row 9, `17:04:21`), which is earlier than the review
gate the sweeper opened on it (row 11, `17:04:46`), which is earlier than the
pictures (row 13).** Nothing on the review page was staged into its state: the
decided row in `R1`–`R4` is the state a decision taken ninety-six seconds
earlier, on a different page, left behind — and the review page it sits on could
not have existed before the step produced something for it to review.

## The runtime, and the model

The WayFlow runtime was up for the whole sequence. Its own health probe — the
one the compose healthcheck and the app use — answered:

```
GET /.health -> 200 {"status":"ok","agents":29,"failed":0,"failed_agents":[],"last_reload_at":null}
```

The model provider resolved: the agent's call to `POST /api/llm-bridge` answered
**200** (row 8). The previous round on this branch got `503 NO_LLM_PROVIDER`
there, which is why nothing downstream of it existed to photograph. No
credential, and nothing derived from one, appears in this directory.

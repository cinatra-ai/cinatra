# cinatra#2790 (S9f) — the order the run actually happened in

Every row below is a timestamp READ FROM THE DATABASE or from a runtime log or
the driver's own clock, not from a screen and not from a narrative. The
right-hand column names the exact source of each one. All times are UTC on
2026-08-22; `timeline.json` beside this file carries the same rows
machine-readably.

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

---

# The CHAT round — cinatra#2790 (S9f), 2026-08-23

The round above walked the order on the **run page**. This one walks the same
order in a **real conversation** — the `chat_thread` host — because the
maintainer's objection is about that surface and about framing: *"the whole chat
should always be visible in the screenshots, not just a close-up of the skill
recommendation pills"*, and *"the re-shoot does not show the skills
recommendation card before the agent creates output, only afterwards"*.

Same rule as above: **every lifecycle timestamp below is read from a database
column**, named beside it, and the capture, press and runtime times are the
recorder's, the driver's and the runtime's own clocks — the right-hand column
names which for each row. Nothing is read off a screen. `timeline-chat.json`
beside this file carries the same rows machine-readably, and
`logs/chat-sequence.txt` is the driver's own verbatim log.

The run: `c2a07df4-07e1-4bd5-94dd-9167a18e0b9d`, started **from the conversation**
`/chat/cinatra-ai/cinatra-assistant/dc7b8f36-d868-4ea4-8d5c-f4d9fc539c1c` by one
typed turn, on the chat lane's own database. Its id is taken off the page — from
the inline run panel's own link out, which the platform builds from the run id —
not from "whatever ran last".

## The column that is still not trusted

`agent_runs.created_at` reads `10:26:02.703` on this run — **byte-identical to
`completed_at`**, sixty-one seconds AFTER the hold it could only have parked on
once it already existed. That is the same defect the previous round reported as
issue 2911; its fix is on `main` and is **not** in this branch, so the column is
still not trusted here and the run's existence is anchored on
`lifecycle_continuation_park.created_at`, which is written once and never
rewritten.

## The sequence

| # | What happened | Time (UTC) | Read from |
|---|---|---|---|
| 1 | **The run was created from the conversation and PARKED at the recommendation hold** | `10:25:01.033` | `cinatra.lifecycle_continuation_park.created_at` — `checkpoint=recommendation`, `status=parked`; `agent_runs.status=pending_input`, `human_present=t`. **NOT** `agent_runs.created_at`; see above |
| 2 | **S1 was photographed with NOTHING PRODUCED** — `representation`, `artifact_produced_outbox` and `artifact_review_gates` rows for this run all **0**, and `run_selected_skill_revisions` **0** | `10:25:19.590` / `10:25:20.673` | the zero counts are the `dbAt` block on each S1 record (`capture-records-chat.json`); the capture times are `recordedAt` on those records |
| 3 | The lane's provider **presence placeholder** was removed through the shipped `clearOpenAIConnection`, so the agent's own model call would resolve the scripted runtime | `10:25:23.507` | `timeline-chat.json` row `T2a`, with the writer's own read-back (`storeResolvesAKey: false`) |
| 4 | **The four chips were decided one at a time**, in the chat, through the card's own per-chip controls — `confirm`, `adjust` → *“Keep it in this run”*, `skip`, `confirm` | presses between `10:25:23` and `10:25:29` | `logs/chat-sequence.txt` (`PRESS …` lines, in order) |
| 5 | **The three kept decisions were written** — `blog-post-matcher → user_adjusted`, `blog-writing → recommended_confirmed`, `web-research → recommended_confirmed` (one release transaction, one timestamp) | `10:25:29.903` | `cinatra.run_selected_skill_revisions.selected_at` + `.selection_source` |
| 6 | **The hold was RELEASED** | `10:25:29.911` | `cinatra.lifecycle_continuation_park.resolved_at`, `status=released` |
| 7 | S2 was photographed — the row settled in place, same slot, after a reload | `10:25:57.925` / `10:25:58.996` | `recordedAt` on the two S2 records |
| 8 | **THE STEP EXECUTED** — the agent's model call went out through `POST /api/llm-bridge`, which answered **200** served by the scripted runtime (`preferredProvider openai unavailable, falling back to configured default`), and the flow then reached `completed` inside the runtime | model call returned in `679ms`; the runtime read `completed` at `10:26:01.331740` | `logs/chat-bridge-readback.txt` — the app log verbatim: `[llm-bridge-run-select] served-by=run_token run=c2a07df4…`, `POST /api/llm-bridge 200 in 679ms`, then `[wayflow] run=c2a07df4… state=completed status={…,"timestamp":"2026-08-23T10:26:01.331740"}` |
| 9 | **THE OUTPUT ARTIFACT WAS WRITTEN BY THE STEP** — `@cinatra-ai/blog-post-artifact:post`, `text/markdown`, revision `798dc74f-cf02-45dc-845e-af98d86137a3` | `10:26:02.616` | `cinatra.representation.created_at` with `created_by_run_id = c2a07df4…`, and `cinatra.artifact_produced_outbox.created_at` with `producer_run_id = c2a07df4…`, `emitter=createSemanticArtifact`, `origin_kind=agent_produced` |
| 10 | The run reached its terminal state | `10:26:02.703` | `cinatra.agent_runs.completed_at`, `status=completed`, `error` empty |
| 11 | **THE SHIPPED SWEEPER OPENED THE REVIEW** on that output | `10:26:12.872` | `cinatra.artifact_review_gates.created_at`, `status=pending`, `review_task_id=lifecycle-review:5310fc97…` |
| 12 | The produced-artifact outbox row was processed | `10:26:13.046` | `cinatra.artifact_produced_outbox.processed_at` |
| 13 | **S3 was photographed** — the review card in the conversation | `10:26:44.494` / `10:26:45.614` | `recordedAt` on the two S3 records |
| 14 | **S4 was photographed** — the review page for the same run | `10:27:09.964` / `10:27:11.056` | `recordedAt` on the two S4 records |

## What the order proves

Read down the table. **The card was photographed HELD (row 2) while the run's
own representation, produced-outbox and review-gate row counts were all ZERO** —
so the recommendation was on screen, actionable, before the agent had produced
anything at all. The chips were then decided (row 5, `10:25:29`), which is
earlier than the step that used them (row 8), which is earlier than the artifact
that step wrote (row 9, `10:26:02`), which is earlier than the review the sweeper
opened on it (row 11, `10:26:12`), which is earlier than the pictures of that
review (rows 13-14).

Nothing on this page is staged into its state: the decided row in `S3` and `S4`
is what a decision taken thirty-three seconds before the output existed left
behind, and the review it sits above could not have existed before the step
produced something to review.

---

# The REWORK round — cinatra#2790 (S9f), PR #2890, 2026-08-23

The two rounds above walked the run page and then the conversation. This one
answers the owner's demand for **the skills question and the decided skills,
each in the chat AND on the run page, on one real run** — eight pictures, four
states, light and dark, one run.

**Which clock each row is on is named in its own right-hand column, and they are
not all the same clock.** The run's own lifecycle times — creation, park,
selection, release, completion — are DATABASE columns, and the raw `psql` output
they are quoted from is committed beside this file as
`logs/rework-db-readback.txt`. The capture times are the recorder's `recordedAt`,
the press times are the driver's clock, and the runtime completion is WayFlow's
own status payload; those are process and runtime clocks, and the rows say so.
Nothing anywhere is read off a screen. `timeline-rework.json` carries the
driver's own rows machine-readably, `logs/rework-sequence.txt` is its verbatim
log, and **`RUN-READBACK.md` is the full readback of this run** — who created it,
who decided it, what model was configured, and what it did and did not produce.

**One row in `timeline-rework.json` is wrong and is left standing.** `T3` is
labelled "the step executed against the real model"; it did not — the provider
was removed one row earlier and the scripted runtime served that call. The
recorded artifacts are the driver's own output and are not rewritten; the
correction rides beside them (`whatCorrection` on the row, a marked footer on the
log) and the driver's label is fixed for any re-run.

The run: `8ff25a9b-2e54-4daf-acd1-9688a1e196b1`, started **from the
conversation** by one typed turn, on this round's own lane database.

## The column that IS trusted this time

`cinatra.agent_runs.created_at` reads `23:38:20.260378` — **before** the hold it
could only have parked on once it existed (`23:38:21.032623`). The two earlier
rounds could not trust this column; this lane's schema carries
`core__0096_agent-run-created-at-immutable`, and the column and the park agree.

## The sequence

| # | What happened | Time (UTC) | Read from |
|---|---|---|---|
| 1 | The run was created from the conversation and PARKED at the recommendation hold | `23:38:20.260` / `23:38:21.033` | `cinatra.agent_runs.created_at`; `cinatra.lifecycle_continuation_park.created_at` (`checkpoint=recommendation`, `status=parked`) |
| 2 | **S1 was photographed with NOTHING PRODUCED** — `representation`, `artifact_produced_outbox` and `artifact_review_gates` rows for this run all **0**, and `run_selected_skill_revisions` **0** | `23:38:38.695` / `23:38:39.757` | DB (the zero counts, via each S1 record's `dbAt` block) + RECORDER CLOCK (`recordedAt` on those records) |
| 3 | **R5 was photographed on the RUN PAGE with the SAME hold still parked** | `23:38:56.218` / `23:38:57.256` | DB (`dbAt`: `parkStatus: parked`) + RECORDER CLOCK (`recordedAt` on the two R5 records) |
| 4 | The REAL provider connection was removed through the shipped `clearOpenAIConnection`, so the agent's own model call would resolve the scripted runtime | `23:38:59.845` | DRIVER CLOCK — `timeline-rework.json` row `T1c`, with the shipped writer's own read-back (`storeResolvesAKey: false`) |
| 5 | **The four chips were decided one at a time**, in the chat, through the card's own per-chip controls — `confirm`, `adjust` → *"Keep it in this run"*, `skip`, `confirm` | presses between `23:38:59` and `23:39:20` | DRIVER CLOCK — `logs/rework-sequence.txt` (`PRESS …` lines, in order) |
| 6 | **The three kept decisions were written** — `blog-post-matcher → user_adjusted`, `blog-writing → recommended_confirmed`, `web-research → recommended_confirmed` (one release transaction, one timestamp) | `23:39:20.352069` | DB — `cinatra.run_selected_skill_revisions.selected_at` + `.selection_source` (`logs/rework-db-readback.txt`) |
| 7 | **The hold was RELEASED** | `23:39:20.358286` | DB — `cinatra.lifecycle_continuation_park.resolved_at`, `status=released` (`logs/rework-db-readback.txt`) |
| 8 | **S2 was photographed** — the row settled in place, same slot, after a reload | `23:39:46.673` / `23:39:47.760` | RECORDER CLOCK — `recordedAt` on the two S2 records |
| 9 | **THE STEP RAN IN THE RUNTIME** — its model call to `POST /api/llm-bridge` answered **200**, and the flow reached `completed` inside WayFlow | `23:39:49.956579` | `logs/rework-bridge-readback.txt`: `[llm-bridge-run-select] served-by=run_token run=8ff25a9b…`, `POST /api/llm-bridge 200 in 523ms`, then `[wayflow] run=8ff25a9b… state=completed` |
| 10 | The run reached its terminal state — **`failed`**, at artifact materialization, AFTER the flow completed | `23:39:50.537` | DB — `cinatra.agent_runs.completed_at` + `.error` (`logs/rework-db-readback.txt`) |
| 11 | **R6 was photographed on the RUN PAGE with the question decided** | `23:40:10.326` / `23:40:11.412` | RECORDER CLOCK — `recordedAt` on the two R6 records |

## What the order proves

**The card was photographed HELD in the chat (row 2) AND on the run page (row 3)
while the run's own representation, produced-outbox and review-gate counts were
all ZERO and the hold still read `parked`** — so the question was on screen and
actionable, on both surfaces, before the agent had produced anything at all. The
chips were then decided (row 6, `23:39:20`), which is earlier than the step that
used them (row 9, `23:39:49`).

**The two decided pictures fall on OPPOSITE sides of that step, and saying so
matters.** `S2` (row 8, `23:39:46`) was shot while the step was still running —
which is exactly why its run progress card reads mid-flight. `R6` (row 11,
`23:40:10`) was shot after the run had reached its terminal state. Both are after
the decision, which is the claim these two cells carry; neither is claimed to be
after the step except `R6`, which is.

Nothing on either surface was staged into its state.

## The two things this round could NOT do, said plainly

1. **The chat turn answers on the DETERMINISTIC BRIDGE.** The turn carries
   embedded `inputParams`, which takes the hard pre-router's brace-matched fast
   path and dispatches server-side without consulting a model. A real-model chat
   turn needs a publicly reachable MCP ingress, which this environment does not
   have.
2. **The agent's own step could not COMPLETE on the real model.** The run was
   created with a REAL sealed `openai_connection` row configured (written through
   the shipped writer inside the operator's secret-manager wrapper), and the run
   before the pictured one died proving why it cannot finish here: the bridge
   loads this instance's cinatra toolbox into the provider call, the provider
   fetches that toolbox from this instance's PUBLIC MCP URL, and this machine has
   none — `POST /api/llm-bridge 500`, *"could not reach this instance's public
   MCP server … HTTP 424 Failed Dependency"* (`logs/rework-bridge-readback.txt`,
   from the runtime's own container log). So the connection was removed in the
   open at row 4 and the scripted runtime served that one call.

Neither substitution touches the hold, the chips, the decision, the release or
the dispatch: those are the server's own shipped path throughout.

---

# The R6 RE-SHOOT — the order ITS run actually happened in

`64c0b1412` fixes the defect the R6 pair filed, so those two cells are re-shot on
their own real run. Every row below is a timestamp read from a DATABASE COLUMN,
from the running server's own log, or from the driver's clock; the right-hand
column names which. All times are UTC on **2026-08-24**; `timeline-r6.json`
beside this file carries the same rows machine-readably, and
`logs/r6-db-readback.txt` is the raw `psql` output behind every column here.

Two runs are in this timeline, and they are named apart on purpose:

* **`8a6a113d-a47f-46be-b917-f65c162e9a68`** — the REAL-PROVIDER run. Driven
  first, end to end, so this machine's limit is MEASURED rather than assumed.
* **`b632737c-a18c-4c3a-acbf-1aa6c60af623`** — the PICTURED run, the one both R6
  cells photograph.

## Which column is trusted here

`agent_runs.created_at` IS trusted on this lane: the schema carries
`core__0096_agent-run-created-at-immutable` (the migration ran at this lane's own
boot), and the two rows agree — the pictured run reads `11:44:06.877` and its
park, which it could only be parked on once it existed, reads `11:44:07.822`.

| # | What happened | Time (UTC) | Read from |
|---|---|---|---|
| 1 | The REAL-PROVIDER run was created, person-present, from one typed chat turn | `11:42:55.447308` | `cinatra.agent_runs.created_at` |
| 2 | It parked at the recommendation hold, was decided chip by chip, and was released | park `11:42:56.245715` → released `11:43:21.039935` | `cinatra.lifecycle_continuation_park.created_at` / `.resolved_at` |
| 3 | Its step's model call went to the REAL sealed provider and DIED there: the provider could not fetch this instance's public MCP toolbox — `HTTP 424 Failed Dependency` → `POST /api/llm-bridge` **500**, three times | `11:43:2x`–`11:43:41` | the server's own bridge lines under `run=8a6a113d…` (`logs/r6-bridge-readback.txt`) |
| 4 | That run reached `failed` (`WayFlow task failed`) | `11:43:41.445` | `cinatra.agent_runs.completed_at` / `.error` |
| 5 | The PICTURED run was created, person-present, from its own typed chat turn | `11:44:06.877588` | `cinatra.agent_runs.created_at` |
| 6 | It PARKED at the recommendation hold | `11:44:07.822411` | `cinatra.lifecycle_continuation_park.created_at` (`checkpoint=recommendation`, `status=parked`) |
| 7 | THE PROVIDER WINDOW CLOSES — the real connection is removed through the shipped `clearOpenAIConnection`, at THIS run's hold and after row 3 measured why | `11:44:27.429` | `timeline-r6.json` row `T1c`; the writer's own read-back reads `storeResolvesAKey: false` |
| 8 | The four chips were pressed, one at a time, through the card's own per-chip controls | `11:44:28.661` → `11:44:33.868` | `logs/r6-sequence.txt` (`PRESS …`), the driver's clock |
| 9 | The three kept decisions were written, in one release transaction | `11:44:33.932359` | `cinatra.run_selected_skill_revisions.selected_at` |
| 10 | The hold was RELEASED | `11:44:33.942714` | `cinatra.lifecycle_continuation_park.resolved_at`, `status=released` |
| 11 | The run's own in-flight gate was answered by its own `Continue` | `11:44:45.909` | `logs/r6-sequence.txt` (`GATE Continue pressed`), the driver's clock |
| 12 | The step's model call was SERVED — `POST /api/llm-bridge` **200** | in the `11:44:46` window | the server's own bridge lines under `run=b632737c…` |
| 13 | The run reached `failed` at artifact materialization, downstream of everything R6 shows | `11:44:47.758` | `cinatra.agent_runs.completed_at` / `.error` |
| 14 | `R6` light was photographed | `11:45:10.624` | `recordedAt` on the light record |
| 15 | `R6` dark was photographed | `11:45:11.688` | `recordedAt` on the dark record |

Read rows 9 → 12 → 14: the skills were decided BEFORE the step that would use
them ran, and the step ran BEFORE the shutter.

## The two things this round could NOT do, said plainly

1. **The chat turn answers on the DETERMINISTIC BRIDGE.** The turn carries
   embedded `inputParams`, which takes the hard pre-router's brace-matched fast
   path and dispatches server-side without consulting a model. A real-model chat
   turn needs a publicly reachable MCP ingress, which this environment does not
   have.
2. **The agent's own step could not COMPLETE on the real model** — and this round
   proved it on a REAL run of its own rather than citing an earlier one. Row 3 is
   that proof, bound to that run's own bridge line. The connection was then
   removed in the open at row 7 and the scripted runtime served the pictured run's
   one call (row 12).

There is also one thing this round could not do the way the driver first tried
it, and it is stated because it changed the sequence: **the provider row cannot
be removed BEFORE the pictured run's chat turn.** A turn that starts a run needs
a configured provider to reach its pre-router at all — with the row already gone
the assistant answers *"The configured default LLM provider \"openai\" is not
available"* and no run is created. So the window sits at the pictured run's own
hold, where the run already exists and no model has yet been consulted.

Neither substitution touches the hold, the chips, the decision, the release, the
dispatch or the settled rail entry R6 is about: those are the server's own
shipped path throughout.

---

# The stood-in-legs re-shoot — the order ITS run actually happened in

**2026-08-24.** This round replaces the rework round's eight cells and the R6
re-shoot's two. The reason is the chain, not the picture: both earlier rounds had
a leg that did not reach a model — the chat turn took the deterministic
pre-router, and the agent's own step was served by the scripted runtime after the
real provider's public-MCP fetch answered `424 Failed Dependency`.

## Which clock each row is on

Rows marked **db** are columns read from the lane database with `psql`
(`logs/realchain-db-readback.txt`). Rows marked **process** are this driver's own
clock — the shutter times (`recordedAt` on each record), the press times, and the
ingress probe. No row anywhere is read off a screen.

## The sequence

| # | Time (UTC) | Clock | What |
|---|---|---|---|
| 1 | `21:14:10.446` | process | The public ingress is proved BEFORE any pictured turn: `HEAD /api/mcp` answers `405` in **207 ms**, inside the app's own 2500 ms dead-ingress budget, and `/api/health` answers `200`. Row `T0`. |
| 2 | `21:14:36.747170` | db | The run is created, `human_present = t`. The deterministic pre-router did not dispatch it: it cannot match a message carrying no package token, and its counters read 0 on every record. `agent_runs.created_at`. |
| 3 | `21:14:37.431509` | db | It parks at the recommendation hold. `lifecycle_continuation_park.created_at`. |
| 4 | `21:14:55.379` | process | Row `T1` reads the park and the three output tables at **0**, with the evidence block attached. |
| 5 | `21:14:56.520` / `21:14:57.664` | process | `S1` light and dark. |
| 6 | `21:15:13.167` / `21:15:14.263` | process | `R5` light and dark, on the run page, the SAME hold still `parked`. |
| 7 | `21:15:16.996` | process | Row `T1c`: the sealed REAL provider row is READ BACK through the shipped reader and is still there. **This is where the earlier round removed it.** Nothing is cleared here. |
| 8 | `21:15:37.305670` | db | The three kept decisions are written in one release transaction. |
| 9 | `21:15:37.312113` | db | The hold is RELEASED. |
| 10 | `21:16:03.557` / `21:16:04.691` | process | `S2` light and dark — the row settled in place, after a reload. |
| 11 | `21:16:05.637` | process | The person answers the run's own in-flight gate with its own `Continue`. One press, landed. |
| 12 | `21:16:33.745010` | db | The artifact the run produced is written — `representation` revision 1, a 6228-byte `text/markdown` blob. |
| 13 | `21:16:33.810` | db | The run reaches `completed`, `error` empty. `agent_runs.completed_at`. |
| 14 | `21:16:57.377` | process | Row `T3a`: the sealed provider row is read AGAIN, after the step's own model call. `T1c` and `T3a` BRACKET that call. |
| 15 | `21:17:13.195` / `21:17:14.293` | process | `R6` light and dark, on the run page, question decided and run finished. |

## What the order proves

**Rows 4-6 are all on one side of row 9, and rows 10-15 are all on the other.**
`S1` and `R5` are photographed while the park is `parked` and the three output
tables read zero; `S2` and `R6` are photographed after the release timestamp. The
held cells cannot be a decided card mislabelled, and the decided cells cannot be
a held one — the database says which side of the release each shutter is on.

**Rows 7 and 14 bracket the model call rows 12-13 depend on.** The earlier round
removed the provider at row 7's position; this one reads it there and reads it
again after the step. Two point reads are what is claimed — not uninterrupted
presence, which no point read can establish.

**Row 15 follows row 13.** R6 is photographed after the run completed, so the
`Step 1` and `Review` rows its rail carries are the run's own executed steps.

## What this round could not do, said plainly

**Several sequences before this one ended at `pending_trigger`.** When the model
hands `agent_run` no `inputParams`, the run parks on the agent's setup field and
then on its trigger, and neither surface on this branch draws a control for that
trigger state — the schedule card in the conversation is the slice cinatra#2788
adds. The driver fails LOUD on that state rather than photographing a run that
did not run, and the person's turn states the idea so the run reaches its own
gate. That is a property of a real chain, and it is on the record.

**And what the counters cannot do.** `publicMcpCallbacks` and `bridgeRunSelects`
are cumulative over the app server's log for this lane session, so the raw
numbers include earlier runs; the figure that carries any claim is the
`deltaSinceStart` on each record. The five must-be-zero counters are screens: a
hit is proof of a problem, a zero is only the absence of that line. What the AGENT'S
STEP rests on is the resolver's own ordering — the scripted runtime is its last
resort and a configured provider preempts it — together with the provider row read
on both sides of the call (rows 7 and 14). What the CHAT TURN rests on is the
pre-router counters, which are structural, plus an environment read taken one hop
above the listening process: presence would be proof, absence there is consistent
rather than conclusive. That difference is stated, not smoothed over.

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

---

# The R6 RE-SHOOT's own run, read out of the database

`64c0b1412` fixes the defect the two R6 cells filed, so those two cells — and only
those two — are re-shot on their own real run. Everything below is a column read
with `psql` from the capture lane's database; the raw output is committed beside
this file as `logs/r6-db-readback.txt`, and what served the agent's own model call
is in `logs/r6-bridge-readback.txt`, read off the running server and bound to each
run's own bridge line. The capture times are the recorder's own `recordedAt` and
the press times are the driver's clock; each row says which. Nothing is read off a
screen.

**The pictured run: `b632737c-a18c-4c3a-acbf-1aa6c60af623`**, started from the
conversation `/chat/cinatra-ai/cinatra-assistant/…` by one typed turn, decided chip
by chip in that same conversation.

## Who created it, who decided it, and what served its model call

| Question | Answer | Column it was read from |
|---|---|---|
| Created by | `8573dc1e-228e-4eb0-9f7a-b6a1ed403979` — the lane's own signed-in person, the account the browser typed the turn as | `cinatra.agent_runs.run_by` |
| Person present? | `t` | `cinatra.agent_runs.human_present` |
| How it was started | `agent_builder` source, dispatched by the chat turn's hard pre-router | `cinatra.agent_runs.source_type` |
| Organization | `197ba74d-3ac5-4647-bcde-7b662323f524` — the ONE organization in this lane, and the owner of the agent template | `cinatra.agent_runs.org_id`, `cinatra.agent_templates.org_id` |
| Agent | `@cinatra-ai/blog-draft-writer-agent` (template `6909ff9e-b0ad-4408-9b2d-ddf2d1e67a6b`) | `cinatra.agent_runs.template_id` → `cinatra.agent_templates.package_name` |
| Decided by | the same person, through the card's own per-chip controls in the chat — four presses, `confirm`, `adjust` → *"Keep it in this run"*, `skip`, `confirm` | `logs/r6-sequence.txt` (`PRESS …` lines) and the selection rows below |
| How this run id was bound to this turn | the driver's STRONG binding (the inline run panel's own link-out) did not resolve at that instant and it fell back to the newest `agent_runs` row — `runIdSource: "newest agent_runs row"` in `logs/r6-sequence-state.json`, which is a WEAK binding and says so. The strong binding is read from the database instead, and the SERVER wrote it: the assistant turn in this run's own thread carries the pre-router's dispatch part, `{"id":"explicit_dispatch_pre_router","name":"agent_run","runId":"b632737c-a18c-4c3a-acbf-1aa6c60af623"}` | `cinatra.assistant_turns.content`, in `logs/r6-db-readback.txt` |
| Model configured when the run was created | a REAL sealed OpenAI connection, `defaultModel` **`gpt-5.5`**, `serviceTier` `flex`, written through the shipped `writeOpenAIConnection` inside the operator's secret-manager `run` wrapper; the writer's own read-back reported `keyPresent: true` at seeding time | `cinatra.metadata` row `openai_connection`; the seeding step's read-back line |
| That same row AFTER the sequence | member names only — `availableModels`, `defaultModel`, `promptCachingEnabled`, `serviceTier`. **There is no key member**: the mid-sequence `clearOpenAIConnection` removed it, which is why the pictured run's own call fell through to the scripted runtime | `cinatra.metadata`, `jsonb_object_keys`, in `logs/r6-db-readback.txt` |
| What served the STEP's model call | the SCRIPTED runtime — the bridge answered `POST /api/llm-bridge` **200** for this run after the real connection was removed at its own hold | `logs/r6-bridge-readback.txt`, bound to `run=b632737c…` |

## The clock

| # | What happened | Time (UTC, 2026-08-24) | Read from |
|---|---|---|---|
| 1 | The REAL-PROVIDER run `8a6a113d-a47f-46be-b917-f65c162e9a68` was created, decided and dispatched, and its own model call died on the provider's fetch of this instance's public MCP toolbox — `HTTP 424 Failed Dependency` → `POST /api/llm-bridge` **500** | created `11:42:55.447308`, failed `11:43:41.445` | `cinatra.agent_runs.created_at` / `.completed_at` / `.error`; the bridge lines in `logs/r6-bridge-readback.txt` |
| 2 | The PICTURED run was created, person-present, from the conversation | `11:44:06.877588` | `cinatra.agent_runs.created_at` |
| 3 | It PARKED at the recommendation hold | `11:44:07.822411` | `cinatra.lifecycle_continuation_park.created_at` (`checkpoint=recommendation`, `status=parked`) |
| 4 | The real provider connection was removed — at THIS run's own hold, so the step's model call would resolve the scripted runtime, and after row 1 had measured why | `11:44:27.429` | `timeline-r6.json` row `T1c`, with the shipped writer's own read-back (`storeResolvesAKey: false`) |
| 5 | The four chips were pressed, one at a time, in the chat | `11:44:28.661` → `11:44:33.868` | `logs/r6-sequence.txt` (`PRESS …`), the driver's clock |
| 6 | The three kept decisions were written — `blog-post-matcher → user_adjusted`, `blog-writing → recommended_confirmed`, `web-research → recommended_confirmed` (one release transaction, one timestamp) | `11:44:33.932359` | `cinatra.run_selected_skill_revisions.selected_at` + `.selection_source` |
| 7 | The hold was RELEASED | `11:44:33.942714` | `cinatra.lifecycle_continuation_park.resolved_at`, `status=released` |
| 8 | The run's own in-flight gate was answered by its own `Continue` | `11:44:45.909` | `logs/r6-sequence.txt` (`GATE Continue pressed`), the driver's clock |
| 9 | The step's model call was served — `POST /api/llm-bridge` **200** | `11:44:46` window | `logs/r6-bridge-readback.txt`, under this run's own select line |
| 10 | The run reached `failed` at artifact materialization | `11:44:47.758` | `cinatra.agent_runs.completed_at` / `.error` |
| 11 | `R6` light was photographed | `11:45:10.624` | `recordedAt` on `R6__recommendation-card__run_card__decided` |
| 12 | `R6` dark was photographed | `11:45:11.688` | `recordedAt` on `R6__recommendation-card__run_card__decided__dark` |

The order is the point: the recommendation was decided (row 6) BEFORE the step
that would use it ran (row 9), and both are behind the shutter (rows 11–12).

## What the pictured run ended on, said plainly

```
artifact materialization failed — the run declared artifact output(s) it did not
produce (1 of 1 failed): content [@cinatra-ai/blog-post-artifact]: titleFrom
output "title" did not resolve to a non-empty string
```

That failure is DOWNSTREAM of everything R6 shows — the hold, the chips, the
decision, the release, the dispatch and the settled rail entry all landed first,
and the rows above are the proof. It is the same class of downstream failure the
earlier rework run recorded, it is a lane fact rather than a statement about this
branch, and it is legible IN the picture: the run detail carries the run's own
`failed` pill and its Error block, which is what a decided run that then failed
actually looks like.

## What this round did NOT reuse, and why it had to be rebuilt

The rework round's lane database no longer exists, so this round rebuilt the lane
from the same clone: one organization (the platform's own `slug="default"`, the
one the agent template already belongs to — `drivers/10-r6-lane-setup.mjs` waits
for the platform's own admin adoption instead of creating a second organization
and deleting it afterwards), the four skills assigned to the agent through the
shipped `upsertCustomSkillAssignment`, the instance identity through the shipped
`/setup/name` wizard step in a browser, the lane registry, and the sealed provider
row through the shipped writer inside the operator's secret-manager wrapper.

**Two writes in that rebuild are direct SQL, not a shipped writer, and they are
named rather than left to be found.** `drivers/10-r6-lane-setup.mjs` sets
`public."user".role='admin'` on the lane's own account (the platform's
`ensureDefaultOrganizationMembership` only adopts a platform admin, so the
promotion has to land before the session that must be adopted) — the same
promotion every earlier round in this lane made — and it will repoint
`cinatra.agent_templates.org_id` at the lane organization IF the template does not
already belong to it. On THIS run it did not fire: the driver printed *"template
org_id: already this organization"*, and `logs/r6-db-readback.txt` shows the one
organization in the lane owning the template. Both are lane DATA: they change who
may open the run, never what is drawn.

Two further lane facts are stated because they changed a RESULT rather than only a
setting:

1. **The skill assignment is keyed by the agent's PACKAGE NAME**, not by the
   template's id. Assigned by template id, all four rows write and read back
   through `getAssignedSkillIdsForAgent` for that id — and the recommendation
   seam, which resolves candidates by package name, then finds none, returns
   `held:false` and dispatches the run unheld. Measured through the shipped seam
   (`walk.test.ts` step `DIAG`): `assignedForViewer: []` before, all four after.
2. **`CINATRA_TEST_LLM_PROVIDER=scripted` is set on this lane.** Without it, an
   install with no configured provider does not reach the scripted runtime at all
   — `resolveConfiguredLlmRuntime()` returns `null` and the bridge answers `503
   NO_LLM_PROVIDER` (measured here, on the run before this one). It changes
   nothing while the sealed connection exists: the real provider resolves first,
   which is exactly what row 1 of the clock shows it doing.

## What is NOT in this directory

No credential and nothing derived from one. The provider key reached exactly one
process — the seeding step, through its environment, inside the operator's
secret-manager `run` wrapper — and that step reports presence and the published
model name only.

# The runs, read back out of their own rows

Every value below is SELECTED, never described. The lane database is dropped when this round ends.

## The registry publish — the thing batch 1 was missing

`drivers/01-publish-run-packages.mjs`, output in `registry-publish.json`. The registry's own
answer, not this round's memory of what it sent:

| package | HTTP | latest | manifest kind | produces | tarball shasum (the registry's) |
| --- | --- | --- | --- | --- | --- |
| `@cinatra-ai/blog-draft-writer-agent` | **200** | `0.1.4` | `agent` | `[{"extension":"@cinatra-ai/blog-post-artifact"}]` | `b22237efe773d4aaf10b91e12cd409ddcf315fb2` |
| `@cinatra-ai/context-selection-agent` | **200** | `0.1.1` | `agent` | — | `5c163bf8d81976b76ce33b3f07d38235c1d6d825` |
| `@cinatra-ai/blog-post-artifact` | **200** | `0.1.4` | `artifact` | — | `6ea1d5ef18fc9cac716d110915861216a8c873a7` |

Batch 1's run died at `failed to load the run package's artifact bindings: 404 Not Found …
no such package available` because the first of those three had never been published. Both runs
of this round materialised their artifact.

## Run one — the pending review, the placeholder, and the change request

```json
{
  "id": "cda1cd00-7091-47e0-bd66-5e43fb2e5fb1",
  "status": "completed",
  "source_type": "agent_builder",
  "human_present": true,
  "error": null,
  "thread": "/chat/cinatra-ai/cinatra-assistant/08793bde-008c-42a7-bfd5-f1cb44afdf7c"
}
```

| read | value |
| --- | --- |
| HITL gates on file | `setup-cda1cd00-…` (field `idea`, 00:18:05.107Z) and `wayflow-41ce9c7e-…` (`@cinatra-ai/context-selection-agent:context-selector`, 00:18:45.960Z) |
| artifact review gate | `lifecycle-review:73aee18a3265252fd9e0173b451271734068f86239062b8e4414c6a95c09f289`, created 00:19:54.398Z |
| the gate's disposition | `changes_requested`, resolved 00:43:01.066Z |
| skills the run recorded as selected | 4 of 4 assigned |
| `agent_run_triggers` rows | 1 (this run) |

### The placeholder window, measured

| read | value |
| --- | --- |
| the mid-run gate was answered at | 2026-08-28T00:18:59.989Z |
| the slot first read `working` with a placeholder at | 2026-08-28T00:19:36.768Z |
| the review gate was on file at | 2026-08-28T00:19:55.107Z (row `created_at` 00:19:54.398Z) |
| **the window** | **18 339 ms**, 36 polled samples, both themes |
| the slot after the mint | `{"slot":"review","placeholder":0,"gate":1}` |

### The repair, and where it stops

```json
{
  "lifecycle_repair": {
    "id": "531ca79f-e572-4c6c-b95d-7060c229b3e8",
    "gate_id": "0dead103-5c87-4605-b1f1-859c416d87aa",
    "producer_run_id": "cda1cd00-7091-47e0-bd66-5e43fb2e5fb1",
    "route": "producer_repair",
    "status": "dispatched",
    "attempt": 1,
    "successor_gate_id": null,
    "findings": [{ "id": "prompt-window", "message": "<the reviewer's typed request>" }],
    "created_at": "2026-08-28T00:43:01.066Z"
  },
  "repairRun": {
    "id": "lifecycle-repair-run:531ca79f-e572-4c6c-b95d-7060c229b3e8",
    "parent_run_id": "cda1cd00-7091-47e0-bd66-5e43fb2e5fb1",
    "source_type": "lifecycle_repair",
    "status": "pending_approval",
    "lifecycle_moment": "hitl",
    "lifecycle_card_kind": "agent_hitl_screen",
    "human_present": null,
    "run_by": "<the same reviewer who typed the request>",
    "org_id": "<the reviewer's active organization>"
  },
  "repairRunHitlGate": {
    "review_task_id": "setup-lifecycle-repair-run:531ca79f-e572-4c6c-b95d-7060c229b3e8",
    "field_name": "idea",
    "x_renderer": "@cinatra-ai/agent-builder:schema-field-fallback"
  },
  "successorReviewGates": 0,
  "artifact_verification_records": 0
}
```

## Run two — the approved review

```json
{
  "id": "c00920ac-4631-460a-946d-9821c3df7f80",
  "status": "completed",
  "source_type": "agent_builder",
  "human_present": true,
  "error": null,
  "thread": "/chat/cinatra-ai/cinatra-assistant/9b2418eb-372e-487c-afa9-cc3436cbb050"
}
```

| read | value |
| --- | --- |
| HITL gates on file | `setup-c00920ac-…` (field `idea`, 01:14:09.006Z) and `wayflow-4dae56bf-…` (context-selector, 01:14:49.326Z) |
| artifact review gate | `lifecycle-review:5e518830710f1fa4384b9df4e83f817f4e648eeffb825823f1e396b9f0bcabea`, created 01:15:45.755Z |
| the placeholder window | **7 781 ms**, 27 polled samples, both themes; slot `working` → `review` |
| Approve pressed on the RUN PAGE's own decision bar at | 2026-08-28T01:16:44.449Z |
| the gate row after it | `status=resolved`, `disposition=approve`, `resolved_at=2026-08-28T01:17:24.527Z`, `resolved_by` = the lane account |
| the card, re-read off the live DOM after a reload | `host=run_card`, `state=settled`, decision bars **0**, `review-gate-settled` **1**, `[data-review-outcome]` = `["approved"]` |

## What the STORED transcript carries — measured for all FIVE kinds

| read | count |
| --- | --- |
| assistant turns in this lane's store | 30 |
| turns anywhere carrying `artifact_review_gate` | **0** |
| turns anywhere carrying `verification_summary` | **0** |
| turns anywhere carrying `recommendation_hold` | **0** |
| turns anywhere carrying `agent_hitl_screen` | **0** |
| turns anywhere carrying `trigger_schedule_proposal` | **0** |

Batch 1 measured three of those five. This round measures all five, on two runs, and the answer
is the same: on this head no lifecycle card is carried by the turn's own durable content. The
cards that DO survive a reload — and B3 is a picture of one that does — are projected from the
run's own row, not from the transcript. Plan (B) §6's clause *"the card is still there after a
reload on every host, **carried by the turn's durable content**"* holds in its OUTCOME and not in
its stated MECHANISM, which is what batch 1 reported and this round widens.

## The instance's canonical install rows

```json
[
  { "package_name": "@cinatra-ai/blog-draft-writer-agent", "status": "active", "version": "0.1.4" },
  { "package_name": "@cinatra-ai/blog-post-artifact",      "status": "active", "version": "0.1.4" },
  { "package_name": "@cinatra-ai/context-selection-agent", "status": "active", "version": "0.1.1" }
]
```

## Provider evidence, and its limits

| read | run one | run two |
| --- | --- | --- |
| `POST /api/mcp 200` callbacks from the provider's own servers over the public ingress | 5 | 6 |
| `[llm-bridge-run-select]` lines the agent runtime produced | 1 | 1 |
| scripted-provider lines in the server log | **0** | **0** |
| `CINATRA_TEST_LLM_PROVIDER` in the driving environment | unset | unset |
| ingress refusals DURING the measured turns | 0 | 0 |
| ingress refusals on the cold probe before them | 0 | 1 (recorded, retried with the same words, answered) |

**The limit, stated, and it is sharper than batch 1's.** `cinatra.llm_usage` does not merely have
no rows on this instance — the relation **does not exist** (`relation "cinatra.llm_usage" does not
exist`), because the public-schema fixture this lane's database is built from does not create it.
So there is no per-call token table to quote at all. The positive evidence for a real provider is
therefore the eleven public-MCP callbacks across the two runs, the two bridge lines, the absent
scripted lines, and the two blog drafts themselves — *"A Sustainable Weekly Publishing Rhythm for
Small Teams"* and *"A 20-Minute Weekly Retrospective for Small Teams"*, both visible in the
committed pictures — which no fixture in this repository produces.

## The disclosed lane writes

1. **The four skill assignments**, through the SHIPPED writer `upsertCustomSkillAssignment`
   (`drivers/02-assign-skills.test.ts`), read back through the shipped reader.
2. **The registry publish** (`drivers/01-publish-run-packages.mjs`) — three packages into the
   lane's own throwaway dev registry. Nothing in the app is written by it.
3. Two provisioning writes shared with the sibling rounds and disclosed in `TIMELINE.md`: the lane
   account is made an administrator, and it joins the organization the instance's own boot stamped
   every agent template with.

`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status" drivers/` over this
round's drivers is EMPTY. **No run, gate, park, record or review task was inserted, and no status
was written by hand.**

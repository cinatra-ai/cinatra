# The run, read back out of its own rows

Every value below is SELECTED, never described. The lane database is dropped when this round ends.

## The run

```json
{
  "id": "e8729686-57f8-4b5b-9437-f5bf5be8ab63",
  "status": "failed",
  "created_at": "2026-08-27T21:41:01.385Z",
  "started_at": null,
  "completed_at": "2026-08-27T22:18:36.808Z",
  "lifecycle_moment": null,
  "lifecycle_card_kind": null,
  "lifecycle_card_ref": null,
  "source_type": "agent_builder",
  "human_present": true,
  "error": "artifact materialization failed \u2014 the run declared artifact output(s) it did not produce (1 of 1 failed): (binding-resolution): failed to load the run package's artifact bindings: 404 Not Found - GET http://127.0.0.1:4873/@cinatra-ai%2fblog-draft-writer-agent - no such package available"
}
```

## The gates on file

```json
[
  {
    "review_task_id": "setup-e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "field_name": "idea",
    "x_renderer": "@cinatra-ai/agent-builder:schema-field-fallback",
    "created_at": "2026-08-27T22:03:20.496Z"
  },
  {
    "review_task_id": "wayflow-dcde7217-e987-4587-b279-5cf87c0349eb",
    "field_name": null,
    "x_renderer": "@cinatra-ai/context-selection-agent:context-selector",
    "created_at": "2026-08-27T22:16:56.718Z"
  }
]
```

## The skills — assigned, and the set the hold recorded

The four assignments are this round's ONE disclosed lane write, made through the shipped writer
`upsertCustomSkillAssignment` and read back through the shipped reader `getAssignedSkillIdsForAgent`.

```json
{
  "assigned": [
    "@cinatra-ai/blog-idea-authoring-skill:blog-idea-authoring",
    "@cinatra-ai/blog-post-matcher-skill:blog-post-matcher",
    "@cinatra-ai/blog-writing-skill:blog-writing",
    "@cinatra-ai/brand-voice-matcher-skill:brand-voice-matcher"
  ],
  "recordedAsSelectedByTheRun": [
    "@cinatra-ai/blog-idea-authoring-skill:blog-idea-authoring",
    "@cinatra-ai/blog-post-matcher-skill:blog-post-matcher",
    "@cinatra-ai/blog-writing-skill:blog-writing"
  ]
}
```

Four assigned, three recorded as selected: the fourth chip was SKIPPED on the card, and the
skipped skill is the one the run does not carry. The row still draws it — that is section V's
settled reading and cinatra#3018's fix.

## What the STORED transcript carries

| read | count |
| --- | --- |
| turns in the run's own thread | 5 |
| turns anywhere carrying `trigger_schedule_proposal` | 0 |
| turns anywhere carrying `recommendation_hold` | 0 |
| turns anywhere carrying `agent_hitl_screen` | 0 |
| rows in `agent_run_triggers` for this run | 1 |

## The instance's canonical install rows for the run's packages

```json
[
  {
    "package_name": "@cinatra-ai/blog-draft-writer-agent",
    "status": "active",
    "version": "0.1.4"
  },
  {
    "package_name": "@cinatra-ai/context-selection-agent",
    "status": "active",
    "version": "0.1.1"
  }
]
```

## Provider evidence, and its limits

| read | value |
| --- | --- |
| `POST /api/mcp 200` callbacks from the provider's own servers over the public ingress | 7 |
| `[llm-bridge-run-select]` lines the agent runtime produced | 1 |
| scripted-provider lines in the server log | 0 |
| `CINATRA_TEST_LLM_PROVIDER` in the driving environment | unset |
| ingress refusals DURING the measured turns | 0 |
| ingress refusals before them, on the cold route | 1 (recorded in TIMELINE.md) |

**The limit, stated.** `cinatra.llm_usage` is EMPTY on this instance, so there is no per-call
token table to quote. The positive evidence for a real provider is therefore the seven public-MCP
callbacks, the bridge line, the absent scripted lines, and the model's own prose in the
transcript — which no fixture in this repository produces.

## The page-control records (the sidecar)

```json
[
  {
    "control": "S1",
    "name": "schedule-moment-in-the-conversation",
    "theme": "light",
    "url": "/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a",
    "sha256": "2a63aee75e8f58c397c494814f487e80192f3fc3e7240f0609aecf56a444fa3b",
    "dbAtCapture": {
      "status": "pending_trigger",
      "lifecycle_moment": "schedule",
      "lifecycle_card_kind": "trigger_schedule_proposal",
      "lifecycle_card_ref": null
    }
  },
  {
    "control": "S1",
    "name": "schedule-moment-in-the-conversation",
    "theme": "dark",
    "url": "/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a",
    "sha256": "6fcd43f806c3f262f802ec9d1c2c10d4cfb787d641473c664d88ac311b7c1d44",
    "dbAtCapture": {
      "status": "pending_trigger",
      "lifecycle_moment": "schedule",
      "lifecycle_card_kind": "trigger_schedule_proposal",
      "lifecycle_card_ref": null
    }
  },
  {
    "control": "S2",
    "name": "schedule-moment-on-the-run-page",
    "theme": "light",
    "url": "/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "sha256": "d3fe710a673b024db61a371ed9c376ddf7dad7fd530fb8fb0b3618b302d7359c",
    "dbAtCapture": {
      "status": "pending_trigger",
      "lifecycle_moment": "schedule",
      "lifecycle_card_kind": "trigger_schedule_proposal",
      "lifecycle_card_ref": null
    }
  },
  {
    "control": "S2",
    "name": "schedule-moment-on-the-run-page",
    "theme": "dark",
    "url": "/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "sha256": "81075efe7e9761f07ac8898709ff7f7107398bcfd05f1dd9790717dbc6818760",
    "dbAtCapture": {
      "status": "pending_trigger",
      "lifecycle_moment": "schedule",
      "lifecycle_card_kind": "trigger_schedule_proposal",
      "lifecycle_card_ref": null
    }
  }
]
```

## The index records this round wrote

```json
[
  {
    "cell": "A1__recommendation-card__chat_thread__pending__light",
    "host": "chat_thread",
    "kind": "recommendation_hold",
    "state": "pending",
    "finalUrl": "/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a",
    "sha256": "a3fa8291b9f6f2083bcc55176b3c971aeb0c828b2d8bd0750ab3067a95f576d6"
  },
  {
    "cell": "A1__recommendation-card__chat_thread__pending__dark",
    "host": "chat_thread",
    "kind": "recommendation_hold",
    "state": "pending",
    "finalUrl": "/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a",
    "sha256": "fb1037052f9c4934befa5331791928b74846900ca6bacdea83a86c0299a8e223"
  },
  {
    "cell": "A2__recommendation-card__run_card__pending__light",
    "host": "run_card",
    "kind": "recommendation_hold",
    "state": "pending",
    "finalUrl": "/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "sha256": "2540a311e0e16e9d8a5b0b3997ec834380d2a9e9bb62edd3e45b8816abb20123"
  },
  {
    "cell": "A2__recommendation-card__run_card__pending__dark",
    "host": "run_card",
    "kind": "recommendation_hold",
    "state": "pending",
    "finalUrl": "/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "sha256": "b2fbab4a4e1ebbdd42433f0479fcf833cc48873bf1e036e90a7284a66c3db97a"
  },
  {
    "cell": "A3__recommendation-card__chat_thread__decided__light",
    "host": "chat_thread",
    "kind": "recommendation_hold",
    "state": "decided",
    "finalUrl": "/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a",
    "sha256": "d07b8c95d001da94935f0420931e0c24df584369565e7bb23c4c8b820edcce44"
  },
  {
    "cell": "A3__recommendation-card__chat_thread__decided__dark",
    "host": "chat_thread",
    "kind": "recommendation_hold",
    "state": "decided",
    "finalUrl": "/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a",
    "sha256": "fd1e87ff3dffeb55b9a878e1d02fec2366148ecd6dc7980ea159ba1e88c3b6e4"
  },
  {
    "cell": "A4__recommendation-card__run_card__decided__light",
    "host": "run_card",
    "kind": "recommendation_hold",
    "state": "decided",
    "finalUrl": "/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "sha256": "3f282133293d703074359b52df3831ddec74fad37b6c2ab94f351f9a9f6b19ad"
  },
  {
    "cell": "A4__recommendation-card__run_card__decided__dark",
    "host": "run_card",
    "kind": "recommendation_hold",
    "state": "decided",
    "finalUrl": "/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63",
    "sha256": "e50f22f98f912193961fd94bb62734fa0b994068098beb06db2bc3c354fa5253"
  }
]
```

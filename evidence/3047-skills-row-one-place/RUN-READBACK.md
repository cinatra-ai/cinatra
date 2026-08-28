# The run, read back out of its own rows

Every value below is SELECTED (`drivers/06-run-readback.mjs`, output in `run-readback.json`),
never described. The lane database is dropped when this round ends.

## The registry publish, proved by the registry's own answer

| package | HTTP | latest | manifest kind | produces | tarball shasum (the registry's) |
| --- | --- | --- | --- | --- | --- |
| `@cinatra-ai/blog-draft-writer-agent` | **200** | `0.1.4` | `agent` | `[{"extension":"@cinatra-ai/blog-post-artifact"}]` | `b22237efe773d4aaf10b91e12cd409ddcf315fb2` |
| `@cinatra-ai/context-selection-agent` | **200** | `0.1.1` | `agent` | — | `5c163bf8d81976b76ce33b3f07d38235c1d6d825` |
| `@cinatra-ai/blog-post-artifact` | **200** | `0.1.4` | `artifact` | — | `6ea1d5ef18fc9cac716d110915861216a8c873a7` |

## The measured run

```json
{
  "id": "67d76eb1-5806-4129-a555-e187b78bbf6d",
  "status": "completed",
  "source_type": "agent_builder",
  "human_present": true,
  "error": null,
  "created_at": "2026-08-28T11:12:56.271Z",
  "template_id": "19fec033-7a5a-41c5-8bea-35d848398908"
}
```

| read | value |
| --- | --- |
| HITL gates on file | `setup-67d76eb1-…` (field `idea`, renderer `@cinatra-ai/agent-builder:schema-field-fallback`, 11:13:35.652Z) and `wayflow-191dafd6-…` (renderer `@cinatra-ai/context-selection-agent:context-selector`, 11:15:07.926Z) |
| artifact review gate | `lifecycle-review:2a4391dfb07190415f554844ae0c7abc3dbf854387877e60c53d9d9bcca59912`, row `dbd3372a-2f85-4fe4-b856-eb13d83f16c8`, `status=pending`, `disposition=null`, created 11:16:16.321Z |
| skills ASSIGNED to the agent (all `owner_type=organization`) | 4 — `blog-idea-authoring`, `blog-writing`, `brand-voice-matcher`, `web-research` |
| what the run RECORDED, `cinatra.run_selected_skill_revisions` | 3 rows: `blog-idea-authoring` **`recommended_confirmed`**, `blog-writing` **`user_adjusted`**, `brand-voice-matcher` **`recommended_confirmed`** |
| `cinatra.agent_run_skills_used` | the same three |
| the fourth | `web-research`, **SKIPPED on its own chip** — drawn on the settled row as `SKIPPED` and correctly carried by neither table |
| `cinatra.artifact_verification_records` | **0** rows |
| assistant turns in this lane's store | 13 |
| turns anywhere carrying `recommendation_hold` in their durable content | **0** |
| runs on this instance when the round ended | 4 (three lane faults, recorded in `TIMELINE.md`, and this one) |

The chip plan the driver pressed was **Confirm / Adjust / Confirm / Skip**, one press per chip on
that chip's own affordance, all four on the RUN PAGE. The rows above are what the run recorded
for them, and they agree.

## The instance's canonical install rows

```json
[
  { "package_name": "@cinatra-ai/blog-draft-writer-agent", "status": "active", "version": "0.1.4" },
  { "package_name": "@cinatra-ai/blog-post-artifact",      "status": "active", "version": "0.1.4" },
  { "package_name": "@cinatra-ai/context-selection-agent", "status": "active", "version": "0.1.1" }
]
```

## Two relations this instance does not carry, stated rather than glossed

- `cinatra.run_recommendation_parks` — **does not exist** on an instance built from the
  public-schema fixture, so the park row could not be quoted. The hold's own reading is the card's
  `data-lifecycle-card-state` (`held`, then `decided`), which IS quoted, and the selection rows
  above.
- `cinatra.llm_usage` — **does not exist**, so there is no per-call token table. The provider
  evidence is in `README.md` and it is stated with its limit.
- `cinatra.run_recommendation_skips` exists but carries no `skill_id` column, so the skipped chip
  could not be read from it by name; it is read from the offered set and the absent selection,
  which is what the settled row draws.

## Provider evidence for the measured run

| read | value |
| --- | --- |
| `POST /api/mcp 200` callbacks over the lane's public origin during the run | **5** |
| `[llm-bridge-run-select]` lines from the agent runtime | **1** |
| scripted-provider lines in the server log | **0** |
| `CINATRA_TEST_LLM_PROVIDER` | **unset** — the driver aborts if it is set |
| ingress refusals, warm-up and measured turns | **0** and **0** |

The run materialised its artifact (`@cinatra-ai/blog-post-artifact:post`, revision
`9ed41aaf-52d…`, `text/markdown`, updated 2026-08-28T11:16:06.809Z) and opened a review gate on
it; the rendered body is legible in the dark P3 frame.

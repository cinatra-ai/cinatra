# RUN-READBACK — the rows every picture stands on

Read out of the lane database by `drivers/13-run-readback.mjs`, which writes nothing. The
machine-readable copy is `readback/run-readback.json`.

## 1. The runs

| run | status | created | completed | `a2a_task_id` | `input_params` |
|---|---|---|---|---|---|
| `0f99ca1c-c81f-4170-83ea-dd6940d893d7` | **failed** | `2026-08-27T08:50:58.671Z` | `2026-08-27T09:15:40.744Z` | `6637daaa…` | `{"idea": {"title": "How small teams keep their customer research organised"}}` |
| `0998c3fb-facd-4881-acfe-f372decc73f5` | **completed** | `2026-08-27T09:19:37.051Z` | `2026-08-27T09:29:35.715Z` | `fbc8dc4b…` | `{"idea": {"title": "How small teams keep their customer research organised"}}` |

The first run's `error`, quoted in full rather than summarised:

> artifact materialization failed — the run declared artifact output(s) it did not produce
> (1 of 1 failed): (binding-resolution): failed to load the run package's artifact bindings:
> 404 Not Found - GET …/@cinatra-ai%2fblog-draft-writer-agent - no such package available

The agent had been installed through the product's **Upload Extension** screen, which writes
the install row but publishes no tarball to the instance's own registry, and the binding
resolver reads the package from that registry. The three packages were published and the leg
was driven again. **Nothing about the card differs between the two runs**; the second is the
one every cell stands on.

Both runs were **created by the app's own dispatch** off the model's own `agent_run` tool
call. The transcript's tool calls across the session are `agent_list`, `agent_run`,
`agent_list`, `agent_run`, `agent_run` — **no lifecycle-card tool call anywhere in the
trace**.

## 2. The HITL gates

| run | `review_task_id` | `x_renderer` | `field_name` | materialised |
|---|---|---|---|---|
| `0f99ca1c…` | `setup-0f99ca1c-c81f-4170-83ea-dd6940d893d7` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `2026-08-27T08:50:59.819Z` |
| `0f99ca1c…` | `wayflow-f39d7511-1321-453f-8764-50f2131982e2` | `@cinatra-ai/context-selection-agent:context-selector` | — | `2026-08-27T09:11:10.651Z` |
| **`0998c3fb…`** | **`setup-0998c3fb-facd-4881-acfe-f372decc73f5`** | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `2026-08-27T09:19:38.010Z` |
| **`0998c3fb…`** | **`wayflow-6a85b4cd-e6fb-45c3-99ce-5242fbeabcb4`** | `@cinatra-ai/context-selection-agent:context-selector` | — | `2026-08-27T09:25:09.577Z` |

The setup gate's own `input_schema`, as the row carries it:

```json
{"type": "object", "title": "idea", "required": ["title"],
 "properties": {"title": {"type": "string"},
                "outline": {"type": "array", "items": {"type": "string"}},
                "summary": {"type": "string"}},
 "x-multiline": true, "x-placeholder": "What should this post be about?",
 "x-object-text-property": "title"}
```

This is the row behind the *"Idea (optional)"* reading recorded in README.md: the gate's own
schema names `title` as required, not `idea`, so the fallback renderer has nothing at the
field's own level to read as required.

## 3. The two Continues, either side

**The setup gate, answered in the card's own field** (cookie host, `/chat`):

| | at | status | `input_params` | `lifecycle_moment` |
|---|---|---|---|---|
| before | `2026-08-27T09:23:09.393Z` | `pending_approval` | `{}` | `hitl` |
| after | `2026-08-27T09:23:53.927Z` | `pending_trigger` | `{"idea": {"title": "How small teams keep their customer research organised"}}` | `schedule` |

**The mid-run gate, answered with the card's OWN `[data-action="submit-hitl-screen"]`**
(cookie host, `/chat`):

| | at | status | `completed_at` |
|---|---|---|---|
| before | `2026-08-27T09:28:50.101Z` | `pending_approval` | — |
| after | `2026-08-27T09:29:39.569Z` | **`completed`** | `2026-08-27T09:29:35.715Z` |

And the gate that opened behind it:

| table | rows | id | status | created |
|---|---|---|---|---|
| `cinatra.artifact_review_gates` | 1 | `lifecycle-review:15259f72a7e4b00ec2da917c4e5b69b40a65518c354cf3ab7555ce87ed14530a` | `pending` | `2026-08-27T09:30:01.351Z` |

The triggers, both released by the app from the run's own step, never inserted here:

| run | type | released |
|---|---|---|
| `0f99ca1c…` | `immediate` | `2026-08-27T09:11:06.695Z` |
| `0998c3fb…` | `immediate` | `2026-08-27T09:25:07.920Z` |

## 4. The provider, and the limits of what this establishes

`cinatra.usage_events`, grouped:

| provider | model | source | operation | calls | input tokens | output tokens | first | last |
|---|---|---|---|---|---|---|---|---|
| `openai` | `gpt-5.5` | `llm` | `stream` | **6** | 128,545 | 1,324 | `2026-08-27T08:29:10.136Z` | `2026-08-27T09:19:39.483Z` |
| `openai` | `gpt-5.5-2026-04-23` | `llm` | `generate` | **12** | 94,135 | 4,018 | `2026-08-27T09:15:40.059Z` | `2026-08-27T09:30:12.440Z` |

Negative and positive screens over the app server's own log for this session
(831,569 bytes):

| screen | count | what a number means |
|---|---|---|
| scripted-runtime lines | **0** | the absence of that particular line, and nothing more |
| "no provider configured" refusals | **0** | same |
| MCP tool-enumeration failures | **0** | same |
| public-MCP refusals | **4** | **a positive**: four turns really were refused before the ingress was warmed, all of them before the pictured turns |
| `POST /api/mcp 200` | **26** | **a positive**: callbacks from the provider's own servers over the lane's public ingress |
| `[llm-bridge-run-select]` | **2** | **a positive**: the agent runtime's own bridge calls, served by run token |

**What this cannot say.** This host prints no environment at all for the listening process —
`ps -E` yields `tokensSeen: 0` — so the process-table read establishes nothing either way
about `CINATRA_TEST_LLM_PROVIDER`. The positive evidence is the usage rows, the 26 public
callbacks, the 2 bridge lines and the absent scripted lines; the driver that started the app
set no such variable.

**A correction to this driver, made here.** `publicMcpRefusals` matched the wording the app
STORES on a refused turn ("is not reachable") while the server writes "is unreachable", so it
reported **zero** on a session that refused four turns. Both spellings are counted now, and
`publicMcpCallbacks` and `bridgeRunSelects` were corrected to the shipped spellings at the
same time. The earlier zero is named here rather than left in the file.

## 5. The threads

Five threads exist in the lane; four are warm-up or pre-install attempts, and the one every
cell stands on is `0ae6d363-2081-48cc-91f5-2113b949c5cf` (opened `2026-08-27T09:19:08.659Z`).
The pre-install attempts are on the record too: two turns were answered *"Agent is not
installed: `@cinatra-ai/blog-draft-writer-agent` — it ships with Cinatra but is opt-in.
Install it from the marketplace before running it."*, which is what sent this lane to the
Upload Extension screen.

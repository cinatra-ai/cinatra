# TIMELINE — the shutters beside the database's own clock

One lane, one instance, one agent, two runs. Every timestamp is UTC and comes from the
row or from the recorder, never from prose. The run every cell stands on is
`0998c3fb-facd-4881-acfe-f372decc73f5`; the first run is on the record because it failed and
why it failed matters.

## The lane, before any picture

| at | what |
|---|---|
| — | the worktree was checked out at the pull request's head; the pinned extension tree (112 packages) was synced |
| — | the app booted on a **dedicated lane database** on the verify Postgres (5634) and the verify Redis (6579), loopback-only, with this checkout's own package registry and agent runtime container beside it |
| — | the lane account signed up through the app's own `/api/auth/sign-up/email`; org created and set active through the app's own endpoints |
| — | `/setup/name` provisioned the instance namespace **through the app's own step** |
| — | the wizard's Secrets step was completed **through the app's own form** (lane-local placeholder; disclosed in README.md) |
| — | `/setup/model` sealed a REAL provider connection **through the app's own form**; `cinatra.metadata` holds one `openai_connection` row |
| — | `/configuration/development?tab=tunnel` set the public origin **through the app's own UI**; `/api/mcp-settings` read it back as the one just saved |
| — | the lane account joined the organization the instance's boot stamped every agent template with |
| — | the run package and its two dependencies were published to the instance's own registry; the agent and its agent dependency were installed through `/configuration/extensions/upload` — both rows `owner_level: organization`, `status: active` |

## Run 1 — `0f99ca1c-c81f-4170-83ea-dd6940d893d7`, on the record because it FAILED

| at | what |
|---|---|
| `2026-08-27T08:50:58.671Z` | the app's own dispatch created the run out of the chat turn |
| `2026-08-27T08:50:59.819Z` | the setup gate materialised — `setup-0f99ca1c…`, renderer `@cinatra-ai/agent-builder:schema-field-fallback`, field `idea` |
| `2026-08-27T09:07:37.442Z` | readback before the answer — `pending_approval`, `input_params {}` |
| `2026-08-27T09:08:21.415Z` | readback after the answer in the card — `pending_trigger`, `input_params {"idea": {"title": "How small teams keep their customer research organised"}}` |
| `2026-08-27T09:11:06.695Z` | the trigger was released from the run's own step (`immediate`) |
| `2026-08-27T09:11:10.651Z` | the mid-run gate materialised — `wayflow-f39d7511…`, renderer `@cinatra-ai/context-selection-agent:context-selector` |
| `2026-08-27T09:15:40.744Z` | after the card's own Continue: the run RESUMED, ran the flow, wrote the draft — and then **failed** at artifact materialisation: *"failed to load the run package's artifact bindings: 404 Not Found … no such package available"*. The package had been installed by upload, which writes no tarball to the instance's registry. |

The three packages were then published to that registry, and the whole leg was driven again.

## Run 2 — `0998c3fb-facd-4881-acfe-f372decc73f5`, the run every cell stands on

| at | what | cell |
|---|---|---|
| `2026-08-27T09:19:08.659Z` | the thread was opened — `0ae6d363-2081-48cc-91f5-2113b949c5cf` | |
| `2026-08-27T09:19:2x` | a warm-up turn was sent and answered before the measured turn | |
| `2026-08-27T09:19:37.051Z` | **the app's own dispatch created the run** out of *"Please run the Blog Draft Writer Agent for me now."* | |
| `2026-08-27T09:19:38.010Z` | the setup gate materialised — `setup-0998c3fb…`, field `idea` | |
| `2026-08-27T09:19:39.483Z` | the last streamed chat call of that turn (`openai` / `gpt-5.5`) | |
| `2026-08-27T09:20:38.588Z` | shutter — the conversation at the setup screen, light | `HC-pending…__pending` |
| `2026-08-27T09:20:55.670Z` | shutter — the same, dark | `HC-pending…__pending__dark` |
| `2026-08-27T09:21:08.095Z` | shutter — the run page at the same moment, light | `HR-pending…__pending` |
| `2026-08-27T09:21:20.040Z` | shutter — the same, dark | `HR-pending…__pending__dark` |
| `2026-08-27T09:23:09.393Z` | readback before the answer — `pending_approval`, `input_params {}`, moment `hitl` | |
| `2026-08-27T09:23:3x` | **the answer was typed into the field the card draws and Continue was pressed INSIDE the card** | |
| `2026-08-27T09:23:53.927Z` | readback after — `pending_trigger`, `input_params {"idea": {"title": "How small teams keep their customer research organised"}}`, moment `schedule` | |
| `2026-08-27T09:24:31.411Z` | shutter — the settled conversation, light | `HC-decided…__decided` |
| `2026-08-27T09:24:43.069Z` | shutter — the same, dark | `HC-decided…__decided__dark` |
| `2026-08-27T09:25:07.920Z` | the trigger was released from the run's own step (`immediate`, `Europe/Berlin`) | |
| `2026-08-27T09:25:09.577Z` | **the mid-run gate materialised** — `wayflow-6a85b4cd-e6fb-45c3-99ce-5242fbeabcb4`, renderer `@cinatra-ai/context-selection-agent:context-selector` | |
| `2026-08-27T09:26:08.741Z` | shutter — the mid-run question in the conversation, light | `HC-midrun-pending…__pending` |
| `2026-08-27T09:26:24.803Z` | shutter — the same, dark | `HC-midrun-pending…__pending__dark` |
| `2026-08-27T09:26:37.222Z` | shutter — the run page at the mid-run gate, light | `HR-midrun-pending…__pending` |
| `2026-08-27T09:26:50.145Z` | shutter — the same, dark | `HR-midrun-pending…__pending__dark` |
| `2026-08-27T09:27:5x` | the occlusion probe: the card's Continue is topmost at the resting scroll AND after scrolling to the end | |
| `2026-08-27T09:28:50.101Z` | readback before the press — `pending_approval`, `completed_at` null, `a2a_task_id` `6a85b4cd…` | |
| `2026-08-27T09:28:5x` | **`[data-action="submit-hitl-screen"]` was pressed INSIDE the card, in the conversation** | |
| `2026-08-27T09:29:35.715Z` | the run **completed** | |
| `2026-08-27T09:29:39.569Z` | readback after — `completed` | |
| `2026-08-27T09:29:46.801Z` | the artifact was updated — *How Small Teams Keep Customer Research Organised*, `@cinatra-ai/blog-post-artifact:post` | |
| `2026-08-27T09:30:01.351Z` | **the run's own review gate opened** — `cinatra.artifact_review_gates`, 1 row, `lifecycle-review:15259f72…`, `pending` | |
| `2026-08-27T09:30:12.440Z` | the last generate call of the session (`openai` / `gpt-5.5-2026-04-23`) | |
| `2026-08-27T09:30:43.929Z` | shutter — the settled conversation with the review card in the slot, light | `HC-midrun-decided…__decided` |
| `2026-08-27T09:30:56.405Z` | shutter — the same, dark | `HC-midrun-decided…__decided__dark` |

## After the shutters

| at | what |
|---|---|
| — | the run page was probed once more with the run `completed`: `[data-lifecycle-card="agent_hitl_screen"]` **0**, the surface draws `artifact_review_gate`. No HR-decided cell is claimed. |
| — | the five drawings were rendered from the two spec files fetched read-only at `design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f` |
| — | `chat-hitl-acceptance-gate`, `chat-hitl-evidence-gate`, `chat-hitl-one-card-gate` (bare and `--audit`) and `file-size-ratchet` all exit 0; the anchor digest reads `recorded == recomputed == fa31fa2f…` |

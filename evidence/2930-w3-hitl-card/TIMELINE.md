# TIMELINE — cinatra#2930 W3 (PR #3014), the picture leg re-driven at this head

Every stamp is UTC and comes from the database, the shipped recorder's own `capturedAt`, or the app
server's own log. Nothing here is reconstructed from memory.

## The environment

| at | what |
|---|---|
| — | the branch checked out at `d061c116fb1867413a7f5c1eff4db466c083097a`; 112/112 pinned extension repos synced |
| — | a fresh database created on the verify Postgres (5634); the committed `public` schema seed applied with `scripts/apply-public-schema.mjs` |
| — | `docker compose --profile wayflow up -d verdaccio wayflow` from this checkout; the dev package registry answered 200 |
| — | `node scripts/dev-server.mjs` on 127.0.0.1:3000 — Next.js 16.2.10 (Turbopack), `CINATRA_RUNTIME_MODE=development`; the public origin answered before any pictured turn |
| — | the account signed up through the app's own `/api/auth/sign-up/email`; the organization created and made active through the app's own endpoints |
| — | `/setup/name` completed through the app's own step; the wizard's Secrets step completed through the app's own form; `/setup/model` completed by the provider driver on `main`, inside the operator's credential wrapper — *"the instance holds a sealed openai_connection row"* |
| — | `/configuration/development?tab=tunnel` set through the app's own field; `/api/mcp-settings` read the origin back as the one just saved |
| — | `@cinatra-ai/blog-draft-writer-agent`, `@cinatra-ai/context-selection-agent` and `@cinatra-ai/blog-post-artifact` published to the instance's own registry; the two agents installed through the app's own **Upload Extension** screen (`owner_level: organization`, `status: active`) |

## The first run — FAILED, and left on the record

| at | what |
|---|---|
| `13:50:31.131Z` | thread `4ca2006a-…` created by the app's own chat |
| `13:50:58.272Z` | run `9dc2d652-…` created by the app's own dispatch; `pending_approval`, moment `hitl` |
| `13:50:59.334Z` | setup gate `setup-9dc2d652-…` created (`@cinatra-ai/agent-builder:schema-field-fallback`, field `idea`), materialised `.335Z` |
| ~`14:01:0xZ` | the card's own Continue pressed in the conversation; `approveReviewTask("setup-9dc2d652-…", {"idea":{"title":"…"}}, "idea")` — `pending_approval → pending_trigger`, the value merged |
| `14:02:23.653Z` | trigger created, released `.656Z` |
| `14:02:26.5xZ` | `[context-route] rejected kind=resolve code=forbidden status=403 … bridge auth failed` ×3, then `[wayflow] … state=failed`; the run `failed` at `14:02:26.557Z` |
| — | **cause, and it is this round's own environment**: `docker/wayflow/.wayflow.env` had not been generated for this checkout, so the agent runtime container held no bridge token. `node scripts/gen-wayflow-env.mjs` wrote it (3 keys; the token matches the app's), the container was recreated and reported `/.health` `{"status":"ok","agents":29,"failed":0,"failed_agents":[]}` |

## The run every cell stands on

| at | what |
|---|---|
| `14:10:46.033Z` | thread `e84977d4-3427-4210-9b6b-d3b7d42d8fce` created; a warm-up turn sent and answered before the measured turn |
| `14:10:45.3Z` | the person asked in their own words: *"Please run the Blog Draft Writer Agent for me now."* |
| `14:11:03.562Z` | run `6928e825-6eb0-49da-88ae-a9faf446a5bc` created **by the app's own dispatch** (`agent_run`, off the model's own tool call) |
| `14:11:04.553Z` | setup gate `setup-6928e825-…` created (`@cinatra-ai/agent-builder:schema-field-fallback`, field `idea`), materialised `.554Z`; run `pending_approval`, moment `hitl`, card kind `agent_hitl_screen` |

### The setup screen — pictured

| at | cell / reading |
|---|---|
| `14:12:26.454Z` | **HC-pending** light — `chat_thread`, `pending` |
| `14:12:42.924Z` | **HC-pending** dark |
| `14:12:55.588Z` | **HR-pending** light — `run_card`, `pending` |
| `14:13:07.459Z` | **HR-pending** dark |
| `14:13–14:14` | the field treatment and the send counts measured on all four cells |
| `14:14:38.141Z` | readback: `pending_approval`, moment `hitl`, `input_params` `{}` |

### The card's own Continue, on the setup gate

| at | what |
|---|---|
| ~`14:15:13Z` | `[data-action="submit-hitl-screen"]` pressed IN THE CARD, in the conversation |
| — | `[approveReviewTaskInternal] setup-path resumed run=6928e825-… fieldName=idea actor=…` and `approveReviewTask("setup-6928e825-…", {"idea":{"title":"How small teams keep customer research organised"}}, "idea")` |
| `14:15:42.796Z` | **HC-decided** light — `chat_thread`, `decided`; every HITL anchor 0, the conversation list 1 |
| `14:15:54.713Z` | **HC-decided** dark |
| `14:15:54.802Z` | readback: **`pending_trigger`**, moment `schedule`, card kind `trigger_schedule_proposal`, `input_params` **`{"idea": {"title": "How small teams keep customer research organised"}}`** |

### The schedule step and the dispatch

| at | what |
|---|---|
| `14:16:17.216Z` | "Run right after setup" and Continue pressed on the run's own trigger step |
| `14:16:17.440Z` | trigger created, released `.443Z` |
| `14:16:19.177Z` | WayFlow task `f1a87077-…` `state=input-required`; `[wayflow-interrupt] … slotId: "draftContext"` |
| `14:16:19.411Z` | mid-run gate `wayflow-f1a87077-…` created (`@cinatra-ai/context-selection-agent:context-selector`, no field), materialised `.412Z`; `[human-gate-park] run=6928e825-… parked on WayFlow gate` |

### The mid-run screen — pictured

| at | cell / reading |
|---|---|
| `14:16:56.152Z` | **HC-midrun-pending** light — `chat_thread`, `pending` |
| `14:17:12.261Z` | **HC-midrun-pending** dark |
| `14:17:24.909Z` | **HR-midrun-pending** light — `run_card`, `pending` |
| `14:17:37.442Z` | **HR-midrun-pending** dark |
| `14:17–14:19` | the field treatment and the send counts measured on all four cells |
| `14:19:06.964Z` | readback: `pending_approval`, task `f1a87077-…`; review gates for this run: **0** |

### The card's own Continue, on the mid-run gate

| at | what |
|---|---|
| ~`14:19:2xZ` | `[data-action="submit-hitl-screen"]` pressed IN THE CARD, in the conversation |
| `14:20:18.347Z` | the resumed run's first `generate` call to the real provider |
| `14:20:18.355Z` | WayFlow task `0afeda2a-…` `state=completed` |
| — | `[approveReviewTaskInternal] wayflow-path resumed run=6928e825-… task=f1a87077-… actor=… resultState=completed` |
| `14:20:19.843Z` | the run **`completed`** (`completed_at`) |
| `14:20:22.929Z` | **the run's own review gate opened** — `cinatra.artifact_review_gates`, `lifecycle-review:b61c5e70…`, `pending` |
| `14:20:32.199Z` | the artifact updated — *How Small Teams Keep Customer Research Organized*, `@cinatra-ai/blog-post-artifact:post` |
| — | the first attempt at the settled reading was REFUSED by the shipped validator: *"the recorded absence counted 1 card(s) … a root that is still on the screen is not a settled reading"* — the run had not finished resuming. Nothing was changed; the walk was split into a press step and a reading step that waits for the review gate's own card. |
| `14:23:41.516Z` | **HC-midrun-decided** light — `chat_thread`, `decided`; every HITL anchor 0, the conversation list 1, the review card in the slot |
| `14:23:54.596Z` | **HC-midrun-decided** dark |

### After

| at | what |
|---|---|
| `14:29:53.843Z` / `14:30:07.085Z` | the run page probed in both themes after completion: every HITL anchor **0**, `artifact_review_gate` (`run_card`, `pending`) in its place, step rail 1 (the completed run's rail, not a HITL-gate row) |
| — | the drawings re-rendered at the contract's pin, read-only, from a loopback copy |
| — | the twelve records registered through the shipped merge: **89 → 93**; annotated with runtime, run id, database readback and provider evidence; the shipped validator accepts all 93 |

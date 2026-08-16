# chat-hitl S9b — the chat-origin recommendation hold, photographed

Captured 2026-08-16 on the DEVELOPMENT RUNTIME against this branch's own worktree.

## The runtime, said first, because the capture rule turns on it

This is a **DEV-RUNTIME round**, and it is labelled as one on every cell below.
`pnpm dev` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_TEST_LLM_PROVIDER=scripted`.

That follows the standing rule for this program unchanged: production-build
screenshots for deterministic and card-fixture cells, explicitly labelled
development-runtime screenshots for **dispatch-dependent** cells. This cell is
dispatch-dependent by construction — it needs a real chat turn to create a real
run — and the two fences that make a production build and an LLM-backed dispatch
mutually exclusive (`assertScriptedProviderNotProduction`, and
`lifecycleSeedEnvVerdict` FENCE 1a answering 404 on `NODE_ENV === "production"`)
were **not weakened**. Neither fence was touched by this branch.

## The stack, and what it was not

A throwaway, fully isolated Compose project: **`s9b2786cap`**, Postgres on
`127.0.0.1:55432`, Redis on `127.0.0.1:56379`, its own volumes and network, and
a dev server on port **3100** with its own BullMQ queue name
(`cinatra-s9b2786cap-jobs`). The operator's `cinatra_cinatra` project was never
started, stopped, written to, or read from. The stack was destroyed after the
capture (containers, volumes, network).

Schema: `scripts/apply-public-schema.mjs` + `pnpm auth:migrate` on an empty
database. `CINATRA_E2E_SETUP_BYPASS=true` was set to pass the **setup wizard**
only; it is not in the path of anything asserted below.

## What is real, and the four fixtures, stated exactly

**Real:** the application, the chat surface, the pre-router, the `agent_run`
primitive, the recommendation hold, the park store, the run card, the
Confirm/Skip release, BullMQ, and Postgres. The message was typed into the real
composer and sent with Enter. Confirm was pressed on the real card.

**Fixtures**, all four DB-level, none of them in the decision under test:

1. `cinatra.agent_assigned_skills` — one row
   (`@cinatra-ai/blog-draft-writer-agent` → `@cinatra-ai/chat:blog-content`,
   position 1, `created_by` = the actor), in the shape the shipped store writes.
   The scorer only returns candidates bounded to the agent's assigned set, and a
   fresh instance has none. This supplies the assignment a settings screen would
   have written, and nothing else.
2. `cinatra.agent_templates.org_id` / `owner_id` for that one agent, set to the
   capturing org. Boot registration leaves `owner_level='organization'` with both
   org anchors NULL, which the run-scope guard correctly refuses as
   `unknown_scope`. This anchors the template the install screen would have
   anchored.
3. `connector_config:openai_connection` — a **presence placeholder** key, a
   fixed non-secret literal naming itself as a placeholder. The runtime binds a provider
   adapter before the pre-router runs, so a provider must resolve. It is not a
   credential: the real generation is served by the scripted provider, and the
   one call that did reach OpenAI (the optional input-extraction round) was
   rejected 401 and degraded exactly as designed. No real key was read, used, or
   stored anywhere.
4. `connector_config:mcp_server.publicBaseUrl = http://localhost:3100` and
   `WAYFLOW_BASE_URL` pointing at an unused local port. The first makes the self
   MCP tool assemble; the second makes the WayFlow preflight answer
   `PREFLIGHT_UNAVAILABLE`, which proceeds. Neither is consulted by the hold.

## The cells

| cell | host | runtime | what it shows |
|---|---|---|---|
| `S9b-1__chat_thread__held-dispatch-paused.png` | chat_thread | **development** | The real conversation after a real dispatch. The assistant turn reads `status: pending_input` and **"The run is paused for your decision — confirm or skip the recommended skills on the run card above, and it starts."** |
| `S9b-2__run_card__recommendation-hold-held.png` | run_card | **development** | The §V recommendation card drawn for that held run, with **Confirm** and **Skip**. |
| `S9b-3__run_card__card-closeup-confirm-skip.png` | run_card | **development** | The same card, close up: heading, the recommended skill chip, Confirm and Skip. |
| `S9b-4__run_card__after-confirm-released.png` | run_card | **development** | The same surface after Confirm was pressed. |

`capture-log.txt` is the machine output of the same session, unedited.

## The seven recorded assertions

| # | assertion | verdict | how |
|---|---|---|---|
| 1 | The §V card is drawn for the held run, with Confirm and Skip | **PROVEN** | S9b-2 / S9b-3; `Confirm visible=true Skip visible=true` |
| 2 | The run is `pending_input`, and the surface says so | **PROVEN** | S9b-1 prints `status: pending_input`; DB: `pending_input\|true` |
| 3 | The conversation does NOT claim the agent is running | **PROVEN** | S9b-1 shows the paused wording; `"The agent is running" absent = true` |
| 4 | DB while held: `status=pending_input`, `human_present=true`, a `parked` recommendation park | **PROVEN** | `agent_runs status\|human_present = pending_input\|true`; `recommendation park = parked` |
| 5 | **No queue job exists for the run while held** | **PROVEN** | `jobs_ever_created=<empty>`, `job_keys: <none>`, `jobs_naming_this_run=0` |
| 6 | **After Confirm: park released, run dispatched, exactly one job** | **PROVEN** | `park after Confirm = released`; `jobs_ever_created=1`; exactly one job key, and it IS the run id; the run advanced off `pending_input` |
| 7 | The captured host, and what belongs to a later slice | **RECORDED** — see below |

Assertions 5 and 6 are the pair that separates a real hold from a card drawn
over a run that was dispatched anyway, so they are stated in full. While held the
queue has **no job at all** and its "jobs ever created" counter is unset. After
Confirm the counter is **1**, and the single job key is the run id itself. The
job key survives completion here, so "exactly once" stays checkable after the
worker has run.

## Assertion 7 — the finding, recorded rather than rounded up

The §V card is photographed on the **run_card** host, not inside the conversation
transcript, because **the recommendation card has no chat_thread mount in this
build**. Measured, not assumed: the dispatch's `agent_run` tool result emits its
`DATA_PART { kind: "agent_run", runId }` correctly, and the conversation renders
the turn with a collapsed "Used 1 tool" group; no inline run card mounts, live or
after a reload, expanded or collapsed.

That is exactly the gap the epic assigns to a later slice — the host-ownership
table names the recommendation kind's `chat_thread` mount as S9f's to define, and
says the inline run card counts as `run_card`, not `chat_thread`. So this slice
proves what it owns: **a chat-started run pauses, reports itself honestly in the
conversation, and is releasable through the canonical path**. The card's
conversation mount is S9f's, and this round is the measurement that says so.

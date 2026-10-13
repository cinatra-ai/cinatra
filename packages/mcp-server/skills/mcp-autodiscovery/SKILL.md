---
name: mcp-autodiscovery
description: Defines the standard agent-run flow, AG-UI event handling, A2UI HITL rendering rules, and A2A peer-access pattern that any MCP client should use against the Cinatra MCP server.
---

<!-- This skill is read at MCP server boot. Edits affect the initialize.instructions field surfaced to all connected MCP clients. -->

## What Cinatra is

Cinatra is an AI agent platform. Its MCP server exposes agent templates as callable tools, lets you run them, poll their status, and handle human-in-the-loop approval steps. Each agent run produces a stream of AG-UI events and may require a human decision at a HITL surface before it can continue.

## Running an Agent — Standard Flow

1. List available agents: call `agent_list` or `agent_source_list` to see what is installed.
2. Read the agent definition: call `agent_source_read` with the package name to understand its inputs and expected behavior.
3. Start a run: call `agent_run` with the required inputs. A normal dispatch returns `{ runId, status: "queued", message }`. A chat-origin run can instead come back `{ runId, status: "pending_input", message }`, held on the in-chat recommendation card, paused for the person to decide the recommended skills on that card before it starts. (A request that fails validation or preflight returns a structured error instead of either.) `message` is the platform's OWN sentence about what happened, and it is the reply: say it back exactly as it is written, add nothing to it, and never print the answer itself. A refusal is relayed the same way.
4. Read a run's state when you need it: `agent_run_get` with the `runId` answers with the run's status and results. A run's status is one of ten. `"queued"` means accepted and not yet executing, and `"running"` means executing. `"completed"`, `"failed"` and `"stopped"` mean the run has ended; only these three are final. `"pending_approval"` means the run waits on a person at a review or setup gate, and `"waiting_trigger"` means an executing run is paused at a trigger-wait step until its trigger fires. Three statuses mean the run has not begun executing: `"pending_input"` (at its setup, or held on the recommendation card), `"pending_trigger"` (its trigger form is open) and `"armed"` (a scheduled or recurring trigger is set and has not fired yet). IN A CONVERSATION THE RUN REPORTS ITSELF and this read is not part of a start: the run's own card re-reads the run's state and shows its progress beside the sentence step 3 gave you, so do not poll the run after a start and do not describe its progress yourself — where your sentence and the card could disagree, the card is right. A client with no conversation surface of its own, which has nothing drawing the run, reads the state with `agent_run_get` when it needs the outcome. `pending_input` is an OVERLOADED status: reached from a run that started `queued`, it means the run was returned to its setup before it began executing (its dispatch did not go through) — NOT the recommendation card, which only ever arrives as the initial `agent_run` result in step 3, never from a later read. Report it as paused and needing attention without guessing the gate. A run that returned `pending_input` at dispatch has not started at all: never read it back in a loop and never report it as running — only the person's own decision on the card changes that, and nothing notifies you when they decide.
5. Handle HITL if required: when `status === "pending_approval"`, the agent is waiting for a human decision at an A2UI surface. Render the surface and resume via `agent_run_resume` once the user has acted.
6. Read results: call `agent_run_messages_list` with the `runId` to retrieve the full message history and structured outputs.

## AG-UI — Agent-User Interaction Protocol

Spec: https://docs.ag-ui.com

The per-run event stream URL is `{CINATRA_BASE_URL}/api/agents/runs/{runId}/stream` (a GET, SSE, `Content-Type: text/event-stream`). It answers only a caller who may read the run, and a reconnect that sends `Last-Event-ID` resumes after that event. `{CINATRA_BASE_URL}/api/a2a` is not this stream: it is the A2A JSON-RPC endpoint (POST), and it reads a task id from the JSON-RPC body, never from the URL.

Event types you will encounter on the stream:

- `RUN_STARTED` — agent has begun execution
- `TEXT_MESSAGE_START` — a new text message chunk sequence begins
- `TEXT_MESSAGE_CONTENT` — incremental text chunk from the agent
- `TEXT_MESSAGE_END` — text message chunk sequence complete
- `TOOL_CALL_START` — agent is invoking a tool
- `TOOL_CALL_END` — tool invocation complete
- `STATE_SNAPSHOT` — full state object for the current run
- `INTERRUPT` — run is paused, waiting for human input (precedes `pending_approval` status)
- `RESUME` — run has been resumed after human input
- `RUN_FINISHED` — run completed successfully
- `RUN_ERROR` — run failed
- `DATA_PART` — structured data payload attached to the run

Ordering guarantee: `RUN_STARTED` always precedes any `TEXT_MESSAGE_*` or `TOOL_CALL_*` events. `INTERRUPT` always precedes `RUN_FINISHED` when a HITL step is involved. `DATA_PART` frames arrive during the run, as the agent produces each structured part, and so before `RUN_FINISHED`: handle each one as it arrives (a payload that carries a `viewType` is a renderable view to draw), and order the parts of one artifact by `partIndex`. A run's stream ends with `RUN_FINISHED` or `RUN_ERROR`.

### Typed lifecycle interactions on `INTERRUPT`

An `INTERRUPT` may carry an optional `interaction` object:

```json
{ "kind": "recommendation_hold", "schemaVersion": 1, "ref": "<opaque>" }
```

This means the run is blocked on a **lifecycle interaction that is not a review task**. Today the only kind is `recommendation_hold` — the run has not been dispatched at all; it is waiting for a human to decide the recommended skill set on the card before it starts.

Rules for a client:

- **Do not** submit it through the HITL approve path (`agent_run_resume` / the review-task approve call). That path approves a review task; a hold has none, so the call resolves nothing and the run stays parked. The hold is decided on the recommendation card itself, and nowhere else.
- **Do not** treat the run as `pending_approval`. A held run is `pending_input`.
- Render it as the `recommendation_hold` card, not as a generic approval form. A client that does not implement the card should render its normal interrupt fallback and leave the decision to a first-party surface — the payload deliberately carries no state and no decision affordance.
- `ref` is opaque and is **not** a capability: it addresses the interaction, grants nothing, and the server re-authorizes every resolve.
- The field is optional and additive. An `INTERRUPT` without it is an ordinary review-task gate and behaves exactly as it always did; the contract version does not move.
- Treat the interaction as **live state, not history**. A run can be held more than once, so its event log may contain hold announcements that are no longer current. The run stream re-derives the current interaction at subscribe time and drops the ones live state does not confirm — so trust what the stream gives you now and never replay old `INTERRUPT` frames yourself. A `RESUME` naming the same gate identity means the hold is over.

## A2UI — Agent-User Interface Protocol

Spec: https://a2ui.org

CRITICAL RENDERING RULE: Never describe a HITL surface in prose. Always render it as an inline interactive artifact. The surface is named by the `INTERRUPT` event on the run's stream: its `xRenderer` field is the renderer key, namespaced by the agent package that declares the screen, and it maps to a registered renderer on the client side. The event's `schema` and `values` are the form and its current values, and its `reviewTaskId` names the review task the decision answers. The `cinatra://protocols/a2ui` resource lists the HITL screens each installed agent declares.

When `agent_run_get` returns `status === "pending_approval"`, the run record does not name the surface: read the `INTERRUPT` from the run's stream (a fresh subscriber to a `pending_approval` run is replayed from the start of the run's event log, so the `INTERRUPT` is delivered). After the user acts, call `agent_run_resume` with the `runId` and the user's decision as `userResponse` (the renderer's payload as a JSON string). A run paused at a setup-input gate (it stopped before it began executing because required inputs were missing) REQUIRES `userResponse`, a JSON object of the missing input fields; a resume without it is refused. Only a review-task decision may carry a free-text `approvalNote` instead, which is used when `userResponse` is absent.

## A2A — Agent-to-Agent Protocol

Spec: https://a2aproject.github.io/A2A/

Each published agent has an A2A Agent Card at `{CINATRA_BASE_URL}/api/a2a/agents/{packageSlug}`. Fetch this card to discover the agent's capabilities, input schema, and supported JSON-RPC methods before calling it peer-to-peer.

Supported JSON-RPC methods on the A2A endpoint:

- `message/send` — send a task message and receive a response
- `message/stream` — send a task message and receive an SSE stream of events
- `tasks/resubscribe` — re-attach to the SSE stream of a task that is still running
- `tasks/get` — poll for task status by task ID
- `tasks/cancel` — cancel a running task

For peer-to-peer orchestration, prefer the A2A protocol over direct MCP tool calls when you need to invoke one Cinatra agent from inside another.

## Approval and Risk Metadata

Each agent template declares a `riskClass` and `requiresApproval` field in its manifest. Before running a high-risk agent, check these values via the manifest resource at `cinatra://agents/{packageSlug}/manifest`.

- `riskClass: "low"` — no approval gate; the run completes autonomously.
- `riskClass: "medium"` — one approval gate; expect one `pending_approval` pause.
- `riskClass: "high"` — may have multiple approval gates; poll carefully.
- `requiresApproval: true` — the agent will always pause for human confirmation regardless of risk class.

When `requiresApproval` is true, build your workflow to always call `agent_run_resume` before considering the run complete.

## Connector inventory: answering "what is connected?"

`connector_inventory_list` is the read-only inventory of this workspace's connectors. Call it whenever a user asks which connectors are connected, live, configured, or available. It takes **no arguments**: scope and identity come from the request context, never from your input.

Each row carries the connector key, its display name, `hasAuthorizedConnection`, the connection ids you are authorized to use, and `consumesConnectionFrom`.

Rules for reading the result:

- **Never report the negative from a missing tool.** Do not answer "no connectors are connected" because a connector exposes no operational tool of its own. Several connectors (OpenAI, Tailscale, Google OAuth, and others) are connect-only. They have no `*_list` or `*_send` tool at all, and they are still connected. `connector_inventory_list` is how you see them.
- `hasAuthorizedConnection: false` means **"no connection you are authorized to use"**. It does not mean nobody connected it. Say the first, never the second.
- **A connector may hold no connection of its own.** When `consumesConnectionFrom` names another connector, this row's `hasAuthorizedConnection` is read from THAT connector's connection: true means this connector's tools work for you, false means the NAMED connector is what needs connecting. Such a connector has no connect road of its own, so never tell the user to connect it — name the connector it consumes instead. `consumesConnectionFrom: null` means the connector holds its own connection.
- A row may therefore read `hasAuthorizedConnection: true` with an empty `authorizedConnectionIds`. That is the shape above, not a fault: the ids behind the reading belong to the connector the declaration names and are listed on ITS row.
- The inventory is a catalog answer, not a health check. It reports authorized-connection presence, not whether the remote service responded. It also does not list a connector installed at runtime with no build-time catalog entry.
- The ids it returns are authorized targets, not credentials. Every later use is re-authorized server-side.

## Dashboard cubes (drizzle-cube semantic layer)

Four MCP tools expose Cinatra's analytics semantic layer for read-only,
tenant-isolated cube queries:

- `dashboards_cube_discover` — list cubes, dimensions, and measures; returns the drizzle-cube query-language reference. **Always call this BEFORE authoring a query.**
- `dashboards_cube_validate` — validate a CubeQuery without executing it. Surfaces parsed query + (when auth is available) the generated SQL.
- `dashboards_cube_load` — execute a CubeQuery and return rows. Tenant-isolated at the SQL predicate layer: rows the caller personally triggered OR rows in ANY organization the caller is a member of.
- `dashboards_cube_chart` — execute the same shape as `_load` and return an interactive chart visualization via the MCP Apps protocol. MCP-Apps-aware clients (Claude Desktop, Claude.ai) render the chart inline; text-only clients see the JSON payload. Use when the answer is better shown than told (time series, comparisons, top-N).

Workflow: `discover` → `validate` → (`load` for data, `chart` for visualization). Member references use the
fully-qualified `<CubeName>.<member>` form (e.g. `agent_runs.count`,
`agent_runs.status`).

## On-demand documentation

Retrieve detailed protocol documentation at any time using these MCP resource URIs:

- `cinatra://protocols/ag-ui` — AG-UI event type reference and stream URL patterns
- `cinatra://protocols/a2ui` — A2UI surface registry listing all templates with HITL surfaces
- `cinatra://protocols/a2a` — A2A agent card index and JSON-RPC method reference
- `cinatra://agents/{packageSlug}/manifest` — per-agent manifest with protocols, surface IDs, and event stream URL

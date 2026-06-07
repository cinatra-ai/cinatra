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
3. Start a run: call `agent_run` with the required inputs. The result contains `{ runId, status: "queued" }`.
4. Poll for completion: call `agent_run_get` with the `runId` every 3-5 seconds. Stop when `status` is `"completed"`, `"failed"`, or `"pending_approval"`.
5. Handle HITL if required: when `status === "pending_approval"`, the agent is waiting for a human decision at an A2UI surface. Render the surface and resume via `agent_run_resume` once the user has acted.
6. Read results: call `agent_run_messages_list` with the `runId` to retrieve the full message history and structured outputs.

## AG-UI — Agent-User Interaction Protocol

Spec: https://docs.ag-ui.com

The event stream URL pattern is `{CINATRA_BASE_URL}/api/a2a?taskId={runId}` (SSE, `Content-Type: text/event-stream`).

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

Ordering guarantee: `RUN_STARTED` always precedes any `TEXT_MESSAGE_*` or `TOOL_CALL_*` events. `INTERRUPT` always precedes `RUN_FINISHED` when a HITL step is involved. Do not process `DATA_PART` until after `RUN_FINISHED`.

## A2UI — Agent-User Interface Protocol

Spec: https://a2ui.org

CRITICAL RENDERING RULE: Never describe a HITL surface in prose. Always render it as an inline interactive artifact using the surface ID provided in the `a2uiSurfaceId` field of the interrupted run node. The surface ID maps to a registered renderer on the client side.

Standard surface IDs in Cinatra:

- `email-sender:step-1:output` — draft email preview; user approves, edits, or rejects
- `email-sender:approval-gate:input` — explicit send confirmation before delivery
- `email-recipients:step-1:output` — recipient list review before bulk send

When `agent_run_get` returns `status === "pending_approval"`, read the `a2uiSurfaceId` field on the run record to determine which surface to render. After the user acts, call `agent_run_resume` with the `runId` and the user decision payload.

Override behavior: if the run record also has an `a2uiSurfaceIdOverride` field, use that value instead of the default `a2uiSurfaceId`.

## A2A — Agent-to-Agent Protocol

Spec: https://a2aproject.github.io/A2A/

Each published agent has an A2A Agent Card at `{CINATRA_BASE_URL}/api/a2a/agents/{packageSlug}`. Fetch this card to discover the agent's capabilities, input schema, and supported JSON-RPC methods before calling it peer-to-peer.

Supported JSON-RPC methods on the A2A endpoint:

- `message/send` — send a task message and receive a response
- `message/sendStreaming` — send a task message and receive SSE stream of events
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

# @cinatra-ai/agent-ui-protocol

Wire-level event and message types for streaming agent runs to a UI. It defines the AG-UI event stream (run lifecycle, text deltas, tool calls, human-in-the-loop interrupts) and A2UI surface messages, plus Redis-backed adapters that publish and subscribe to those events per run.

The package is split into two entry points: a tier-neutral surface (`./src/index.ts`) that is safe to import on the client and exports only types and constants, and a server-only surface (`./src/server.ts`) that carries the Redis publish/subscribe adapters and translators.

## Public API

Tier-neutral (`@cinatra-ai/agent-ui-protocol`):

- `AgentUIAdapter` — adapter interface agents call during a run
- `AgUiEvent`, `AgUiEventType` — AG-UI event union and type tag
- `RunStartedEvent`, `RunFinishedEvent`, `RunErrorEvent` — run lifecycle events
- `TextMessageStartEvent`, `TextMessageContentEvent`, `TextMessageEndEvent` — streamed text
- `ToolCallStartEvent`, `ToolCallEndEvent` — tool invocation events
- `StateSnapshotEvent`, `InterruptEvent`, `ResumeEvent`, `DataPartEvent` — state, HITL, data parts
- `AG_UI_EVENT_TYPES` — frozen array of event type names
- `channelFor(runId)` — Redis channel name for a run
- `A2UiMessage`, `A2UiMessageType`, `ComponentDefinition` — A2UI surface message types
- `CreateSurfaceMessage`, `UpdateComponentsMessage`, `UpdateDataModelMessage`, `DeleteSurfaceMessage` — A2UI message variants
- `A2UI_MESSAGE_TYPES` — frozen array of A2UI message type names
- `GMAIL_SENDER_FIELD_WHITELIST`, `normalizeGmailSenderFieldName` — allowed Gmail sender fields

Server-only (`@cinatra-ai/agent-ui-protocol/server`):

- `AgUiAdapter`, `publishAgUiEvent` — publish AG-UI events over Redis
- `subscribeToAgUiEvents`, `subscribeToAgUiEventsWithId`, `readLatestAgUiInterrupt` — consume an event stream
- `A2UiAdapter`, `publishA2UiEvent` — publish A2UI surface messages
- `DualAdapterDispatch` — fan an `AgentUIAdapter` call out to AG-UI and A2UI
- `translateHintToA2UiMessages` and related translators — build A2UI messages from output hints
- `enrichSchemaWithResolvedData` — resolve dynamic data sources into an interrupt schema

## Usage

```ts
import { channelFor, type AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import { publishAgUiEvent } from "@cinatra-ai/agent-ui-protocol/server";

const event: AgUiEvent = { type: "RUN_STARTED", threadId, runId };
await publishAgUiEvent(channelFor(runId), event);
```

## Docs

See https://docs.cinatra.ai for the full platform documentation.

# @cinatra-ai/agent-ui-protocol

Wire-level event and message types for streaming agent runs to a UI. It defines the AG-UI event stream (run lifecycle, text deltas, tool calls, human-in-the-loop interrupts) and A2UI surface messages, plus Redis-backed adapters that publish and subscribe to those events per run.

The package is split into two entry points: a tier-neutral surface (`./src/index.ts`) that is safe to import on the client and exports only types and constants, and a server-only surface (`./src/server.ts`) that carries the Redis publish/subscribe adapters and translators.

## The unified assistant-stream contract

[`CONTRACT.md`](./CONTRACT.md) is the single versioned spec for **the** one
AG-UI wire that carries every assistant conversation — first-party `/chat` and
every embedded assistant alike (durable + `Last-Event-ID`-resumable transport, a
capability handshake, and a renderable-view schema). It also names the
transport-vs-persistence boundary with the assistant runtime. Start there for
the wire semantics; the sections below list the exported surface.

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

Unified assistant-stream contract (S1 — see `CONTRACT.md`), exported from the
dedicated `@cinatra-ai/agent-ui-protocol/stream` subpath (kept off the package
barrel so it does not inflate routes that import the package):

- `ASSISTANT_STREAM_CONTRACT_VERSION`, `ASSISTANT_STREAM_SURFACES`, `ASSISTANT_STREAM_TRANSPORT` — the versioned contract, its surfaces, and the durable/resumable transport descriptor
- `TERMINAL_EVENT_TYPES`, `RESUME_HEADER`, `REPLAY_FROM_START_CURSOR` — terminal frames + resume constants
- `isValidStreamCursor`, `normalizeResumeCursor`, `STREAM_CURSOR_PATTERN` — `Last-Event-ID` resume-cursor parsing
- `buildAssistantStreamCapabilities`, `negotiateContract`, `compareContractVersions`, `AssistantStreamCapabilities`, `AssistantStreamAuthMode` — the capability handshake (successor to the `/capabilities` v1/v2 negotiation)
- `RenderableViewRegistry`, `RenderableViewBase`, `isRenderableViewDataPart`, `isRenderableViewOfType`, `renderableViewType`, `renderableViewDataPart` — the typed `DATA_PART` renderable-view seam (S4 registers views here without forking the contract)
- `isAgUiEvent`, `analyzeEventLog`, `CONFORMANCE_CORPUS` — static conformance validation + the seed fixture corpus (S6 begins here)
- `A2UiMessage`, `A2UiMessageType`, `ComponentDefinition` — A2UI surface message types
- `CreateSurfaceMessage`, `UpdateComponentsMessage`, `UpdateDataModelMessage`, `DeleteSurfaceMessage` — A2UI message variants
- `A2UI_MESSAGE_TYPES` — frozen array of A2UI message type names
- `EMAIL_SENDER_FIELD_WHITELIST`, `normalizeEmailSenderFieldName` — allowed email sender fields

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

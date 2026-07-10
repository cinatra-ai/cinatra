// ---------------------------------------------------------------------------
// @cinatra-ai/agent-ui-protocol/stream — the unified assistant-stream contract
// (cinatra#1217, epic #1216 · S1). Tier-neutral surface (types + value
// constants + pure functions); no `server-only`, no Redis.
//
// DELIBERATELY a SEPARATE entry point from the package's main barrel
// (`./index`). The four locked, latency-budgeted routes (`/api/a2a`,
// `/api/llm-bridge`, `/api/mcp`, `/chat`) reach the main barrel transitively;
// re-exporting the S1 contract there pulled these five modules into every one
// of their reachable graphs (route-graph-ratchet: a locked route's first-party
// graph may only shrink). The contract's consumers are the LATER stages
// (S2/S4/S5/S6), which import it explicitly from here — so the wire contract
// lives in the package without inflating routes that never use it.
//
//   import {
//     ASSISTANT_STREAM_CONTRACT_VERSION,
//     negotiateStreamContract,
//     isAgUiEvent,
//   } from "@cinatra-ai/agent-ui-protocol/stream";
//
// The durable publish/subscribe transport itself stays in the server-only
// entry (`@cinatra-ai/agent-ui-protocol/server`).
// ---------------------------------------------------------------------------

// Versioned contract + durable/resumable transport descriptor + resume cursor.
export {
  ASSISTANT_STREAM_CONTRACT_VERSION,
  ASSISTANT_STREAM_SURFACES,
  ASSISTANT_STREAM_TRANSPORT,
  TERMINAL_EVENT_TYPES,
  RESUME_HEADER,
  REPLAY_FROM_START_CURSOR,
  STREAM_CURSOR_PATTERN,
  isValidStreamCursor,
  normalizeResumeCursor,
} from "./contract";

export type {
  AssistantStreamContractVersion,
  AssistantStreamSurface,
  TerminalEventType,
  StreamCursor,
} from "./contract";

// Capability handshake — replaces the bespoke `/capabilities` v1/v2 negotiation.
export {
  ASSISTANT_STREAM_AUTH_MODES,
  buildAssistantStreamCapabilities,
  compareContractVersions,
  negotiateContract,
  negotiateStreamContract,
} from "./handshake";

export type {
  AssistantStreamAuthMode,
  AssistantStreamCapabilities,
  ContractNegotiation,
  StreamClientHello,
  StreamNegotiation,
} from "./handshake";

// Renderable-view extension points — the typed DATA_PART seam S4 registers into.
export {
  renderableViewType,
  isRenderableViewDataPart,
  isRenderableViewOfType,
  renderableViewDataPart,
} from "./renderable-views";

export type {
  RenderableViewBase,
  RenderableViewRegistry,
  RegisteredRenderableView,
  RegisteredRenderableViewType,
  RenderableView,
} from "./renderable-views";

// Static conformance surface + seed fixture corpus (S6 begins here).
export { isAgUiEventType, isAgUiEvent, analyzeEventLog } from "./conformance";

export type {
  EventLogEntry,
  ConformanceCorpus,
  EventLogAnalysis,
} from "./conformance";

export {
  CONFORMANCE_CORPUS,
  FIXTURE_FULL_TURN,
  FIXTURE_INTERRUPT_RESUME,
  FIXTURE_RUN_ERROR,
  FIXTURE_STREAMING_PARTIAL,
  FIXTURE_UNKNOWN_RENDERABLE_VIEW,
} from "./conformance-fixtures";

import "server-only";

// ---------------------------------------------------------------------------
// @cinatra-ai/agent-ui-protocol — server-only surface
//
// AG-UI exports:
//   - AgUiAdapter class, publishAgUiEvent, __disconnectSharedAgUiPublisher
//     (ag-ui-adapter.ts — publish side)
//   - subscribeToAgUiEvents, AgUiSubscribeOptions
//     (ag-ui-subscriber.ts — subscribe side)
//
// A2UI exports:
//   - A2UiAdapter class, publishA2UiEvent, __disconnectSharedA2UiPublisher
//     (a2ui-adapter.ts — publish side)
//   - translateHintToA2UiMessages
//     (a2ui-translator.ts — pure translation utility)
//
// Composite exports:
//   - DualAdapterDispatch class (dual-adapter.ts) — fans out AgentUIAdapter
//     calls to both AG-UI and A2UI children (AG-UI first, then A2UI).
//
// All use ioredis and must never be imported on the client bundle.
// ---------------------------------------------------------------------------

export {
  AgUiAdapter,
  publishAgUiEvent,
  __disconnectSharedAgUiPublisher,
} from "./ag-ui-adapter";

export {
  subscribeToAgUiEvents,
  subscribeToAgUiEventsWithId,
  readLatestAgUiInterrupt,
  type AgUiSubscribeOptions,
  type LatestAgUiInterrupt,
} from "./ag-ui-subscriber";

export {
  A2UiAdapter,
  publishA2UiEvent,
  __disconnectSharedA2UiPublisher,
} from "./a2ui-adapter";

export { DualAdapterDispatch } from "./dual-adapter";

export {
  translateHintToA2UiMessages,
  translateSetupGroupToA2UiMessages,
  translateRecipientsOutputToA2Ui,
  translateDraftsOutputToA2Ui,
  translateSendOutputToA2Ui,
  A2UI_DEFAULT_CATALOG_ID,
  type MidRunTranslator,
} from "./a2ui-translator";

// ---------------------------------------------------------------------------
// Schema enrichment (server-only)
// ---------------------------------------------------------------------------
export {
  enrichSchemaWithResolvedData,
  GMAIL_SEND_AS_DATA_SOURCE,
  SEND_AS_DATA_SOURCE,
  type EnrichmentContext,
} from "./schema-enricher";

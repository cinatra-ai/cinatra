// ---------------------------------------------------------------------------
// @cinatra-ai/chat/renderer/interactive — the AG-UI interactive layer.
// ---------------------------------------------------------------------------
// cinatra#1311 — the DEFERRED S3 half (the AG-UI event-to-UI reducer + the
// interactive components that render its view model). Sibling subpath to the S3
// CONTENT renderer barrel (`@cinatra-ai/chat/renderer`), kept SEPARATE so the
// content barrel's locked pure-content export surface (renderer-surface.test)
// stays untouched and the heavy content deps and this interactive layer never
// entangle.
//
// UNCONSUMED. Nothing imports this yet — /chat keeps its bespoke
// `chat-stream-events` path. Wiring /chat onto this reducer is S2's job (#1218).
// The reducer is a pure fold; the components are pure/presentational; the inline
// run-card mounts are surfaced as a pure selector (`resolveInlineRunMounts`) so
// the host mounts the already-exported `InlineAgentRunCard` without this module
// pulling the heavy AgenticRunPanel wrapper.

export {
  agUiReduce,
  agUiReduceAll,
  createAgUiReducerState,
  type AgUiReducerState,
  type AgUiInterrupt,
  type AgUiDataPart,
  type AgUiRunStatus,
} from "../ag-ui-reducer";

export { AgUiMessageView, type AgUiMessageViewProps } from "./message-view";
export { ToolCallChip } from "./tool-call-chip";
export { ThinkingGroup } from "./thinking-group";
export { CitationList } from "./citation-list";
export { RunErrorBanner } from "./run-error-banner";
export {
  HitlInterruptForm,
  schemaFields,
  type HitlField,
} from "./hitl-interrupt-form";
export {
  resolveInlineRunMounts,
  type InlineRunMount,
} from "./inline-run-mounts";

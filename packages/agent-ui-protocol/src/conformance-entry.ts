// ---------------------------------------------------------------------------
// @cinatra-ai/agent-ui-protocol/conformance — static conformance entry.
//
// The render-parity conformance CI (S6, cinatra#1222) consumes the S1 static
// conformance surface (#1217) — the event validators + the fixture corpus — to
// check a fixture corpus against the wire contract WITHOUT a live producer.
//
// This is a DEDICATED subpath, NOT part of the package's main `index` barrel,
// on purpose: the barrel is reachable from locked routes (`/chat`, `/api/a2a`,
// `/api/mcp`, `/api/llm-bridge`) whose first-party module graph is ratcheted
// (scripts/audit/route-graph-ratchet.mjs). Re-exporting the fixture corpus from
// the barrel would grow every one of those routes for test-only value; a
// separate entry keeps the corpus off the route graph — only the conformance
// harness imports `@cinatra-ai/agent-ui-protocol/conformance`.
//
// Tier-neutral: pure validation + fixture data, no server-only constraint.
// ---------------------------------------------------------------------------

export { isAgUiEvent, isAgUiEventType, analyzeEventLog } from "./conformance";

export type {
  ConformanceCorpus,
  EventLogEntry,
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

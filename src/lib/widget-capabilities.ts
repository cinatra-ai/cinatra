import "server-only";

import {
  CURRENT_CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  MIN_CONTRACT_VERSION,
  MAX_CONTRACT_VERSION,
} from "@/lib/wp-drupal-contract";

// ---------------------------------------------------------------------------
// Widget capability + version negotiation source of truth (cinatra#220).
//
// GET /api/agents/{agentSlug}/capabilities returns ONLY static contract
// metadata. A LOCALLY-shipped widget (which can drift from a per-customer
// instance version) calls this ONCE at boot, and a successful + valid response
// is a HARD PREREQUISITE for the widget to mount. The negotiation contract the
// client enforces:
//   - it picks the highest mutually-supported contractVersion; if NONE is
//     mutually supported the instance is INCOMPATIBLE and the widget does not
//     mount (it shows the unavailable chrome);
//   - supportsTokenExchange MUST be true — the same-origin broker token is the
//     ONLY client stream-auth model; there is NO legacy long-lived-key path and
//     the browser never holds or sends a long-lived key;
//   - forward flags are opt-in: a behavior is enabled ONLY when its flag is
//     explicitly true (supportsChangesFrame → apply-changes UI; supportsMarkdown
//     → markdown rendering). An ABSENT flag DISABLES that behavior.
//
// Any client-side failure to fetch or validate this response — 404 / 5xx /
// network error / timeout / malformed JSON / invalid schema / missing required
// field / no mutual contractVersion / supportsTokenExchange !== true — makes the
// widget UNAVAILABLE. There is NO 404-degrade, NO optimistic default, and NO
// old-instance fallback. (The endpoint still answers 404 for an UNKNOWN agent
// slug; that is a server-side not-found, which the client also treats as
// unavailable.)
//
// SECURITY: the endpoint is AUTH-FREE and MUST leak NOTHING instance-specific —
// no instance data, no auth config keys, no package names, no installed-extension
// internals. The shape below is intentionally all static contract constants
// plus the slug echoed from the path (`bundle.js` is already public, so this
// leaks no more). The SSE frame list is the FROZEN wire format.
// ---------------------------------------------------------------------------

export type WidgetCapabilityFlags = {
  supportsChangesFrame: boolean;
  supportsMarkdown: boolean;
  supportsTokenExchange: boolean;
  maxContextBytes: number;
  maxMessages: number;
  sseFrames: readonly ["text", "changes", "error", "done"];
  streamPath: string;
  tokenPath: string;
};

export type WidgetCapabilitiesResponse = {
  agentSlug: string;
  contractVersion: string;
  supportedContractVersions: string[];
  minContractVersion: string;
  maxContractVersion: string;
  capabilities: WidgetCapabilityFlags;
};

// Static, instance-independent capability constants. The stream route bounds
// history to the last 20 messages (route.ts `.slice(-20)`), so maxMessages
// mirrors that; maxContextBytes is the advertised soft ceiling the local widget
// uses to trim per-page context before sending.
export const WIDGET_CAPABILITIES = {
  supportsChangesFrame: true,
  supportsMarkdown: true,
  supportsTokenExchange: true,
  maxContextBytes: 8192,
  maxMessages: 20,
  sseFrames: ["text", "changes", "error", "done"] as const,
} as const;

/**
 * Build the capabilities payload for a resolved widget-stream agent slug.
 * Pure + static — derives nothing from instance config or extension internals.
 */
export function buildCapabilities(agentSlug: string): WidgetCapabilitiesResponse {
  return {
    agentSlug,
    contractVersion: CURRENT_CONTRACT_VERSION,
    supportedContractVersions: [...SUPPORTED_CONTRACT_VERSIONS],
    minContractVersion: MIN_CONTRACT_VERSION,
    maxContractVersion: MAX_CONTRACT_VERSION,
    capabilities: {
      ...WIDGET_CAPABILITIES,
      streamPath: `/api/agents/${agentSlug}/stream`,
      tokenPath: `/api/agents/${agentSlug}/token`,
    },
  };
}

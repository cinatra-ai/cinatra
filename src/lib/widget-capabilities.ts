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
// metadata so a LOCALLY-shipped widget (which can drift from a per-customer
// instance version) degrades its UX correctly:
//   - older instance with no /capabilities endpoint (404) → the widget assumes
//     { supportedContractVersions: ["v1"], supportsTokenExchange: false } and
//     falls back to the legacy long-lived flow;
//   - supportsTokenExchange === false → legacy flow;
//   - supportsChangesFrame === false → hide apply-changes, render text only;
//   - the widget picks the highest mutually-supported contractVersion.
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

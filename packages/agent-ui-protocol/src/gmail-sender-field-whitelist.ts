// ---------------------------------------------------------------------------
// gmail-sender-field-whitelist — tier-neutral export.
//
// Imported by:
//   - packages/agent-builder/src/gmail-sender-renderer.tsx (browser, "use client")
//     via the @cinatra-ai/agent-ui-protocol public re-export
//   - packages/agent-ui-protocol/src/schema-enricher.ts (server, "server-only")
//     via the local relative import "./gmail-sender-field-whitelist"
//
// Single source of truth for which HITL field names should be treated as
// Gmail sender pickers when Gmail is connected. This file MUST stay free
// of "use client" / "server-only" so both tiers can consume it.
//
// Placed in agent-ui-protocol (not agent-builder) to avoid a circular
// dependency: the enricher in agent-ui-protocol must import this; if it
// lived in agent-builder we'd need agent-ui-protocol → agent-builder, but
// agent-builder already depends on agent-ui-protocol.
// ---------------------------------------------------------------------------

/**
 * Tight whitelist of field names that should be treated as Gmail sender
 * fields ONLY if Gmail is connected AND aliases are available. Anything
 * outside this list MUST use the explicit "x-renderer": "gmail-sender" /
 * "@cinatra-ai/email-outreach-agent:gmail-sender" annotation instead.
 */
export const GMAIL_SENDER_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  "sender",
  "senderemail",
  "senderaddress",
  "fromemail",
  "fromaddress",
  "from",
  "replyto",
]);

/**
 * Normalize a raw HITL field name to the canonical lookup key:
 * lowercase + strip underscores, hyphens, and whitespace. Mirrors
 * the in-renderer normalization at gmail-sender-renderer.tsx line 38.
 */
export function normalizeGmailSenderFieldName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, "");
}

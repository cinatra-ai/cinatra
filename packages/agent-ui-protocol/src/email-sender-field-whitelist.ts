// ---------------------------------------------------------------------------
// email-sender-field-whitelist — tier-neutral, provider-NEUTRAL export
// (renamed from gmail-sender-field-whitelist, cinatra#1625: the mechanism is a
// generic email-sender field heuristic; the gmail-specific ACTIVATION lives in
// the host condition module + the migrated pack renderer).
//
// Imported by:
//   - the host gmail-sender condition module (packages/agents/src/gmail-sender-condition.ts)
//     via the @cinatra-ai/agent-ui-protocol public re-export
//   - packages/agent-ui-protocol/src/schema-enricher.ts (server, "server-only")
//     via the local relative import "./email-sender-field-whitelist"
//
// Single source of truth for which HITL field names should be treated as
// email sender pickers when a sender provider is connected. This file MUST stay
// free of "use client" / "server-only" so both tiers can consume it.
//
// Placed in agent-ui-protocol (not agent-builder) to avoid a circular
// dependency: the enricher in agent-ui-protocol must import this; if it
// lived in agent-builder we'd need agent-ui-protocol → agent-builder, but
// agent-builder already depends on agent-ui-protocol.
// ---------------------------------------------------------------------------

/**
 * Tight whitelist of field names that should be treated as email sender
 * fields ONLY if a sender provider is connected AND aliases are available.
 * Anything
 * outside this list MUST use the explicit "x-renderer": "gmail-sender" /
 * "@cinatra-ai/email-outreach-agent:gmail-sender" annotation instead.
 */
export const EMAIL_SENDER_FIELD_WHITELIST: ReadonlySet<string> = new Set([
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
 * the in-renderer normalization the migrated pack gmail-sender renderer uses.
 */
export function normalizeEmailSenderFieldName(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, "");
}

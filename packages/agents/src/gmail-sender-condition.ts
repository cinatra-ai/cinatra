// ---------------------------------------------------------------------------
// gmail-sender-condition — HOST-OWNED activation for the gmail-sender field
// renderer kind (cinatra#1625: the host owns WHEN a sender picker activates;
// the pack ships the COMPONENT that renders).
//
// The COMPONENT (GmailSenderFieldRenderer) migrated into @cinatra-ai/email-artifacts
// (src/renderers/gmail-sender.tsx). What stays host-side is this condition
// FACTORY: the context gating (a sender provider is connected + aliases present)
// and the strict field-name whitelist heuristic. register-default-renderers.ts
// wires it onto the "gmail-sender" kind via `makeCondition`, so the migrated
// binding (which registers as the ExtensionFieldRenderer wrapper) keeps the
// SAME activation logic — an unannotated `senderEmail`/`from` field still
// resolves to the gmail sender picker when gmail is connected, exactly as before.
//
// This module names no extension and ships no "use client" — it is a pure
// predicate factory consumed by the host registration path.
// ---------------------------------------------------------------------------

import type { FieldRendererCondition } from "./field-renderer-registry";
import {
  EMAIL_SENDER_FIELD_WHITELIST,
  normalizeEmailSenderFieldName,
} from "@cinatra-ai/agent-ui-protocol";

/**
 * Condition FACTORY (cinatra#151 Stage 5): the match-ID set comes from the
 * binding registration (manifest-declared full ID + the host kind table's
 * bare compat aliases) — this module names no extension. The context gating
 * (gmail connected + aliases present) and the strict field-name whitelist
 * heuristic are preserved verbatim from the retired isGmailSenderField.
 */
export const makeGmailSenderCondition =
  (matchIds: readonly string[]): FieldRendererCondition =>
  (fieldName, schema, context) => {
    if (!context.connectedApps.includes("gmail")) return false;
    if (!context.gmailAliases || context.gmailAliases.length === 0) return false;

    const xRenderer = (schema as { ["x-renderer"]?: string })["x-renderer"];
    if (typeof xRenderer === "string" && matchIds.includes(xRenderer)) return true;

    // Strict whitelist check — avoids misclassifying unrelated fields like
    // `fromAddress` in a shipping schema.
    const normalized = normalizeEmailSenderFieldName(fieldName);
    if (!EMAIL_SENDER_FIELD_WHITELIST.has(normalized)) return false;

    const type = (schema as { type?: string }).type;
    const format = (schema as { format?: string }).format;
    // Require string type and either no format or format=email.
    return type === "string" && (format === undefined || format === "email");
  };

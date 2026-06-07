// ---------------------------------------------------------------------------
// schema-enricher — server-only HITL schema enrichment.
//
// Resolves dynamic per-user data (Gmail aliases) and injects JSON Schema
// `enum` + `x-enum-titles` onto relevant properties before the HITL
// InterruptEvent is emitted. External clients (Claude Desktop, A2A) see
// constrained choices; Cinatra UI rendering is unchanged because the
// FieldRendererRegistry takes priority over schema-derived defaults.
// ---------------------------------------------------------------------------

import "server-only";
import { getStoredGmailSendAsAddresses } from "@cinatra-ai/gmail-connector";
import {
  GMAIL_SENDER_FIELD_WHITELIST,
  normalizeGmailSenderFieldName,
} from "./gmail-sender-field-whitelist";

export type EnrichmentContext = {
  /** The run owner whose connector state is consulted. `null` for system runs. */
  userId: string | null;
};

/**
 * Allowlisted `x-data-source` value that triggers Gmail send-as alias
 * resolution. Exported as the single source of truth so test fixtures and
 * the OAS compiler test reuse the same literal.
 */
export const GMAIL_SEND_AS_DATA_SOURCE = "@cinatra/connector-gmail:send-as-aliases";

type GmailAlias = { email: string; displayName?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Match the predicate in gmail-sender-renderer.tsx::isGmailSenderField (lines 31-44). */
function isWhitelistedGmailSenderProperty(name: string, prop: Record<string, unknown>): boolean {
  const normalized = normalizeGmailSenderFieldName(name);
  if (!GMAIL_SENDER_FIELD_WHITELIST.has(normalized)) return false;
  const type = prop.type;
  if (type !== "string") return false;
  const format = prop.format;
  return format === undefined || format === "email";
}

function explicitGmailDataSource(prop: Record<string, unknown>): boolean {
  return prop["x-data-source"] === GMAIL_SEND_AS_DATA_SOURCE;
}

function buildEnumTitles(aliases: GmailAlias[]): string[] {
  return aliases.map((a) => (a.displayName ? `${a.displayName} <${a.email}>` : a.email));
}

/**
 * Pure helper: scan once for any property that needs enrichment. Used to
 * short-circuit BEFORE calling the connector when nothing matches.
 */
function anyPropertyNeedsEnrichment(properties: Record<string, unknown>): boolean {
  for (const [name, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop)) continue;
    if (explicitGmailDataSource(prop)) return true;
    if (isWhitelistedGmailSenderProperty(name, prop)) return true;
  }
  return false;
}

/**
 * Enrich a HITL schema with resolved per-user data. Pure function — never
 * mutates the input. Returns the input reference unchanged when there is
 * nothing to do, which avoids unnecessary connector calls.
 */
export async function enrichSchemaWithResolvedData(
  schema: Record<string, unknown>,
  ctx: EnrichmentContext,
): Promise<Record<string, unknown>> {
  // Step 1 — structural guard.
  if (!isPlainObject(schema)) return schema;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return schema;

  // Step 2 — short-circuit when no property matches to avoid connector calls.
  if (!anyPropertyNeedsEnrichment(properties)) return schema;

  // Step 3 — system runs have no user connector state, so return unchanged.
  if (ctx.userId == null) return schema;

  // Step 4 — clone before write to avoid schema mutation across users.
  const cloned = structuredClone(schema) as Record<string, unknown>;
  const clonedProperties = cloned.properties as Record<string, unknown>;

  // Step 5 — resolve aliases once for this call.
  const { aliases } = getStoredGmailSendAsAddresses(ctx.userId);

  // Step 6 — graceful degradation: no aliases means no enum.
  if (!Array.isArray(aliases) || aliases.length === 0) return cloned;

  const enumValues = aliases.map((a: GmailAlias) => a.email);
  const enumTitles = buildEnumTitles(aliases as GmailAlias[]);

  // Step 7 — per-property write.
  for (const [name, prop] of Object.entries(clonedProperties)) {
    if (!isPlainObject(prop)) continue;
    const matches =
      explicitGmailDataSource(prop) || isWhitelistedGmailSenderProperty(name, prop);
    if (!matches) continue;
    prop.enum = enumValues;
    prop["x-enum-titles"] = enumTitles;
  }

  return cloned;
}

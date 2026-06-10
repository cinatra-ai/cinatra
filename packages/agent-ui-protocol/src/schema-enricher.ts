// ---------------------------------------------------------------------------
// schema-enricher — server-only HITL schema enrichment.
//
// Resolves dynamic per-user data (sender/"send-as" aliases) and injects JSON
// Schema `enum` + `x-enum-titles` onto relevant properties before the HITL
// InterruptEvent is emitted. External clients (Claude Desktop, A2A) see
// constrained choices; Cinatra UI rendering is unchanged because the
// FieldRendererRegistry takes priority over schema-derived defaults.
//
// Provider resolution is INJECTED (transport-registration cutover): this package imports no provider
// package. The host supplies `ctx.resolveEmailSendProviders` (typically backed
// by its `email-send` capability registry); the enricher asks each resolved
// provider for its `listFromAddresses` aliases. A provider that does not
// support multiple From-addresses simply omits the optional contract method.
// ---------------------------------------------------------------------------

import "server-only";
import type { EmailConnector } from "@cinatra-ai/sdk-extensions";
import {
  GMAIL_SENDER_FIELD_WHITELIST,
  normalizeGmailSenderFieldName,
} from "./gmail-sender-field-whitelist";

export type EnrichmentContext = {
  /** The run owner whose connector state is consulted. `null` for system runs. */
  userId: string | null;
  /**
   * Host-injected resolver for the live `email-send` capability providers.
   * Optional for backward compatibility — when absent, enrichment degrades
   * gracefully to a no-op (no provider source, no enum).
   */
  resolveEmailSendProviders?: () => readonly EmailConnector[];
};

/**
 * Allowlisted `x-data-source` values that trigger sender-alias resolution.
 * `GMAIL_SEND_AS_DATA_SOURCE` is the LEGACY data-contract id existing agent
 * schemas already carry (kept recognized verbatim — it is a data-contract id,
 * not a package reference); `SEND_AS_DATA_SOURCE` is the provider-neutral id
 * new schemas should use. Both are exported as the single source of truth so
 * test fixtures and the OAS compiler test reuse the same literals.
 */
export const GMAIL_SEND_AS_DATA_SOURCE = "@cinatra/connector-gmail:send-as-aliases";
export const SEND_AS_DATA_SOURCE = "@cinatra-ai/email:send-as-aliases";

type SenderAlias = { email: string; displayName?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Match the predicate in gmail-sender-renderer.tsx::isGmailSenderField (lines 31-44). */
function isWhitelistedSenderProperty(name: string, prop: Record<string, unknown>): boolean {
  const normalized = normalizeGmailSenderFieldName(name);
  if (!GMAIL_SENDER_FIELD_WHITELIST.has(normalized)) return false;
  const type = prop.type;
  if (type !== "string") return false;
  const format = prop.format;
  return format === undefined || format === "email";
}

function explicitSendAsDataSource(prop: Record<string, unknown>): boolean {
  const v = prop["x-data-source"];
  return v === GMAIL_SEND_AS_DATA_SOURCE || v === SEND_AS_DATA_SOURCE;
}

function buildEnumTitles(aliases: SenderAlias[]): string[] {
  return aliases.map((a) => (a.displayName ? `${a.displayName} <${a.email}>` : a.email));
}

/**
 * Pure helper: scan once for any property that needs enrichment. Used to
 * short-circuit BEFORE calling any provider when nothing matches.
 */
function anyPropertyNeedsEnrichment(properties: Record<string, unknown>): boolean {
  for (const [name, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop)) continue;
    if (explicitSendAsDataSource(prop)) return true;
    if (isWhitelistedSenderProperty(name, prop)) return true;
  }
  return false;
}

/**
 * Resolve the per-user sender aliases across every injected provider that
 * implements the OPTIONAL `listFromAddresses` contract method. Providers are
 * consulted in registration order; aliases are merged (first occurrence of an
 * email wins). A provider failure degrades to "no aliases from that provider"
 * — enrichment is best-effort decoration, never a hard failure.
 */
async function resolveSenderAliases(
  ctx: EnrichmentContext,
  userId: string,
): Promise<SenderAlias[]> {
  const providers = ctx.resolveEmailSendProviders?.() ?? [];
  const seen = new Map<string, SenderAlias>();
  for (const provider of providers) {
    if (typeof provider.listFromAddresses !== "function") continue;
    try {
      const aliases = await provider.listFromAddresses({ userId });
      for (const alias of aliases) {
        if (typeof alias?.email === "string" && alias.email.length > 0 && !seen.has(alias.email)) {
          seen.set(alias.email, { email: alias.email, displayName: alias.displayName });
        }
      }
    } catch {
      // Best-effort — a provider alias failure must not break HITL emission.
    }
  }
  return [...seen.values()];
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

  // Step 5 — resolve aliases once for this call (across injected providers).
  const aliases = await resolveSenderAliases(ctx, ctx.userId);

  // Step 6 — graceful degradation: no aliases means no enum.
  if (aliases.length === 0) return cloned;

  const enumValues = aliases.map((a) => a.email);
  const enumTitles = buildEnumTitles(aliases);

  // Step 7 — per-property write.
  for (const [name, prop] of Object.entries(clonedProperties)) {
    if (!isPlainObject(prop)) continue;
    const matches =
      explicitSendAsDataSource(prop) || isWhitelistedSenderProperty(name, prop);
    if (!matches) continue;
    prop.enum = enumValues;
    prop["x-enum-titles"] = enumTitles;
  }

  return cloned;
}

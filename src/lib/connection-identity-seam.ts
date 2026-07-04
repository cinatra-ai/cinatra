import "server-only";

// ---------------------------------------------------------------------------
// Connection-identity SEAM (cinatra#952 W2, step A2) — the host-side write
// path that keeps the `nango_connection` identity table (W1) in lockstep with
// connection creation and deletion.
//
// W1 shipped the table + the one-shot blob backfill but NO save-path caller
// of `insertNangoConnection`: without this seam every connection saved after
// the backfill would have no identity row and fail CLOSED at the W2 use-gate.
//
//   • `registerSavedConnectionIdentity` — idempotent identity insert + the
//     ONE-time owner-scoped grant seed (`OWNER_DEFAULT` — creating a
//     connection NEVER auto-shares; a reconnect NEVER resets a previously
//     widened policy: the seed fires only when NO policy row exists).
//   • Foreign-row HARD-FAIL: the live-unique index is (connector_key,
//     connection_id) GLOBALLY (not org-qualified), so an insert that lands on
//     an EXISTING row owned by a DIFFERENT user hard-fails the save seam and
//     never seeds/overwrites the foreign row (fail-closed, actionable).
//   • `revokeConnection` — the central delete helper, ORDERED so revocation
//     is effective on the very next resolution: soft-delete the identity row
//     FIRST (the gate fails closed immediately), then the upstream Nango
//     connection (token), then the blob pointer record.
// ---------------------------------------------------------------------------

import {
  insertNangoConnection,
  softDeleteNangoConnection,
  readNangoConnectionByNaturalKey,
  type NangoConnectionIdentity,
} from "@cinatra-ai/extensions/connection-identity-store";
import { defaultAccessPolicyForKind } from "@cinatra-ai/extensions/install-access-contract";
import { seedExtensionAccessPolicyIfAbsent } from "@cinatra-ai/extensions/permissions-store";
import { getConnectorDescriptorBySlug } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL } from "@/lib/connection-use-gate";
import {
  deleteNangoConnection,
  removeNangoConnectionRecord,
  type NangoConnectorKey,
} from "@/lib/nango-system";

/**
 * connectorKey → connector-catalog SLUG (host vocabulary only — NO package
 * literal lives in this core file; true-IoC per the
 * core-extension-instance-coupling-ban gate, same pattern as
 * `connector-instance-write-authority`'s kind→slug map). The package id is
 * DERIVED below through the single sanctioned connector-catalog registry
 * (`getConnectorDescriptorBySlug`). `externalMcp` is host vocabulary
 * (external MCP servers are host rows, not marketplace packages) and maps to
 * the sentinel the use-gate special-cases, so it has no catalog slug.
 */
const HOST_CONNECTOR_KEY_TO_CATALOG_SLUG: Readonly<Record<string, string>> = Object.freeze({
  a2aServer: "a2a-server-connector",
  apify: "apify-connector",
  apollo: "apollo-connector",
  claude: "anthropic-connector",
  drupal: "drupal-mcp-connector",
  gemini: "gemini-connector",
  github: "github-connector",
  gmail: "gmail-connector",
  googleCalendar: "google-calendar-connector",
  googleOAuth: "google-oauth-connector",
  linkedin: "linkedin-connector",
  openai: "openai-connector",
  tailscale: "tailscale-connector",
  tailscaleOauth: "tailscale-connector",
  wordpress: "wordpress-mcp-connector",
  youtube: "youtube-connector",
});

/**
 * connectorKey → owning connector package id, REGISTRY-DERIVED from the
 * slug map above (a slug the catalog does not cover simply drops out, so the
 * load-bearing lookup hard-fails on it — fail-closed). MUST stay a superset
 * of the W1 backfill's map
 * (`migrations/core/core__0014_nango-connection-identity-backfill.mjs`,
 * `CONNECTOR_KEY_TO_PACKAGE`) — pinned by a consistency test.
 */
export const HOST_CONNECTOR_KEY_TO_PACKAGE: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(HOST_CONNECTOR_KEY_TO_CATALOG_SLUG).flatMap(([key, slug]) => {
      const packageId = getConnectorDescriptorBySlug(slug)?.packageId;
      return packageId ? [[key, packageId] as const] : [];
    }),
  ),
  externalMcp: EXTERNAL_MCP_CONNECTOR_PACKAGE_SENTINEL,
});

export class ConnectionIdentityConflictError extends Error {}

/**
 * Idempotent save-seam insert + one-time owner-scoped grant seed.
 *
 * Call AFTER the underlying connection save succeeded, with the acting
 * user/org from the VALIDATED session (never request input). Safe to fire on
 * every save/reconnect:
 *   • existing row, same owner → returns the row (org-NULL legacy rows are
 *     tolerated for their owner and stay null-org/owner-only — never widened);
 *   • existing row, DIFFERENT owner (or a different non-null org) → HARD-FAIL
 *     (fail-closed; the global unique index means this save addressed someone
 *     else's connection identity);
 *   • the grant seed fires ONLY when no policy row exists — a reconnect never
 *     resets a previously widened policy back to owner-only.
 */
export async function registerSavedConnectionIdentity(input: {
  connectorKey: string;
  connectionId: string;
  ownerUserId: string;
  organizationId: string | null;
  /**
   * Seed policy for the ONE-time grant seed. Omitted = the connection kind's
   * OWNER_DEFAULT (never auto-shares — the rule for per-user connections).
   * The org-admin APP-scope flows (blob scope:"app" saves, external-MCP
   * instance-global rows) pass `"workspace"` — those connections are
   * org-shared BY CONSTRUCTION (the save route admin-gates them; pre-#950
   * semantics were org-global) and are minted by org-bound InternalWorker
   * principals that an owner-only grant would deny. Behavior-preserving, not
   * broadening — mirrors the core__0015 legacy seed.
   */
  seed?: "owner" | "workspace";
}): Promise<NangoConnectionIdentity> {
  const { connectorKey, connectionId, ownerUserId, organizationId } = input;
  const connectorPackageId = HOST_CONNECTOR_KEY_TO_PACKAGE[connectorKey];
  if (!connectorPackageId) {
    throw new ConnectionIdentityConflictError(
      `No connector package is known for connector key "${connectorKey}" — extend ` +
        `HOST_CONNECTOR_KEY_TO_CATALOG_SLUG (registry-derived) before connections of ` +
        `this kind can be registered.`,
    );
  }

  const row = await insertNangoConnection({
    organizationId,
    connectorPackageId,
    connectorKey,
    connectionId,
    ownerUserId,
  });

  // Conflict hard-fail (codex round-1 finding 2 of the pre-stage): the store
  // returns the EXISTING live row on conflict with no created flag — a
  // mismatch means this save addressed a foreign identity.
  if (row.ownerUserId !== ownerUserId) {
    throw new ConnectionIdentityConflictError(
      `The ${connectorKey} connection "${connectionId}" is already registered to a ` +
        `different user — it cannot be re-saved under this account. Disconnect the ` +
        `existing connection (its owner or an admin) first.`,
    );
  }
  if (
    row.organizationId != null &&
    organizationId != null &&
    row.organizationId !== organizationId
  ) {
    throw new ConnectionIdentityConflictError(
      `The ${connectorKey} connection "${connectionId}" is registered under a ` +
        `different organization — it cannot be re-saved from this workspace.`,
    );
  }

  // One-time grant seed. Seed-idempotency is ATOMIC (codex diff-round-2
  // finding 1): `seedExtensionAccessPolicyIfAbsent` inserts with ON CONFLICT
  // DO NOTHING, so a reconnect's seed can never clobber a concurrent
  // widen/narrow (round-2 finding 4: a reconnect must never reset a widened
  // policy). NULL-ORG NARROWING (codex diff-round finding 1): a null-org
  // identity row must NEVER gain a workspace grant — `workspace` has no
  // cross-org guard to contain it — so a null-org row is force-seeded
  // owner-only regardless of the requested seed.
  const effectiveSeed = row.organizationId === null ? "owner" : input.seed;
  const policy =
    effectiveSeed === "workspace"
      ? {
          runListVisibility: "workspace" as const,
          runDataVisibility: "workspace" as const,
          runExecuteVisibility: "workspace" as const,
          allowRunSharing: false,
        }
      : defaultAccessPolicyForKind("connection");
  await seedExtensionAccessPolicyIfAbsent("connection", row.id, policy, ownerUserId);
  return row;
}

/**
 * Central revocation helper (codex round-1 finding 7 of the pre-stage).
 * ORDER is the contract:
 *   1. soft-delete the identity row — every reader is live-rows-only, so the
 *      use-gate/resolver fail CLOSED immediately (revocation-next-use);
 *   2. delete the upstream Nango connection (the token itself);
 *   3. remove the blob pointer record.
 * A failure in (2)/(3) leaves a soft-deleted identity — an availability
 * residue, never a credential leak (the gate already denies).
 */
export async function revokeConnection(input: {
  connectorKey: string;
  connectionId: string;
  providerConfigKey: string;
  /** Skip the blob-record removal for connections that never had a pointer
   * record (external-MCP rows, key-less imports). */
  hasBlobRecord?: boolean;
}): Promise<void> {
  const { connectorKey, connectionId, providerConfigKey, hasBlobRecord = true } = input;
  const identity = await readNangoConnectionByNaturalKey(connectorKey, connectionId);
  if (identity) {
    await softDeleteNangoConnection(identity.id);
  }
  await deleteNangoConnection(providerConfigKey, connectionId);
  if (hasBlobRecord) {
    await removeNangoConnectionRecord(connectorKey as NangoConnectorKey, connectionId);
  }
}

import "server-only";

// ---------------------------------------------------------------------------
// Synchronous canonical connector-access resolver.
//
// enforceConnectorPolicy is synchronous (it is called from sync contexts such
// as the connectors-list Array.filter). The uniform polymorphic model lives in
// @cinatra-ai/extensions, but its async store wrappers are sync underneath
// (runPostgresQueriesSync). This module reads the canonical connector
// installed_extension row + its access policy + co-owners SYNCHRONOUSLY and
// feeds them into the PURE evaluateExtensionAccess, so enforceConnectorPolicy
// can delegate without changing its signature.
//
// Returns null when the org has no canonical connector install row — the
// caller then falls back to the legacy connector_access_policy read
// (absence-only fallback).
// ---------------------------------------------------------------------------

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
// Schema from the client-safe types module (zod only): a value import of the
// server auth-policy barrel would drag its enforcement graph in for what is
// only a scalar→array coercion on read.
import { AgentAuthPolicySchema, type AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";
import type { ExtensionOwnerContext } from "@cinatra-ai/extensions/enforce-extension-access";
// The `__platform__` sentinel the workspace-fallback arm keys on — read from the
// canonical types module (constants + types only, no runtime import graph, so it
// is safe in this sync render path) rather than re-spelled as a literal here.
import { PLATFORM_OWNER_SENTINEL } from "@cinatra-ai/extensions/canonical-types";
import {
  isResolvedConnectorAccessDeclaration,
  type ResolvedConnectorAccessDeclaration,
} from "@cinatra-ai/sdk-extensions/access-config";

export type CanonicalConnectorAccess = {
  resourceId: string;
  owner: ExtensionOwnerContext;
  policy: AgentAuthPolicy | null;
  coOwnerUserIds: string[];
  installedByUserId: string | null;
  /**
   * The W1-cached `cinatra/config.json` declaration on the registration row
   * (cinatra#955): `null` only for a row persisted before the reader ran.
   * A PRESENT-but-corrupt cached value fails the whole read CLOSED
   * (`{status:"error"}`) — it must never silently resolve to a default.
   */
  accessDeclaration: ResolvedConnectorAccessDeclaration | null;
};

/**
 * Discriminated result so the caller can distinguish:
 *   - "found": a migrated canonical connector install exists → evaluate it.
 *   - "absent": no canonical row → the caller applies the legacy fallback.
 *   - "error": a DB read failed → the caller FAILS CLOSED (deny), it does NOT
 *     fall back to the (possibly looser) legacy/catalog default.
 * This keeps the legacy fallback ABSENCE-only, never error-driven.
 */
export type ConnectorCanonicalResult =
  | { status: "found"; access: CanonicalConnectorAccess }
  | { status: "absent" }
  | { status: "error" };

/**
 * Resolve the canonical connector access inputs for (orgId, packageId)
 * synchronously — THE EFFECTIVE ROW (cinatra#2694 / S3 #2697, re-grounded by
 * S4 #2698 change 1). Never throws in the sync render path — DB failures surface
 * as `{status:"error"}` so the caller can fail closed.
 *
 * Resolution order (identical to the async resolver's, see
 * `resolveConnectorResource` in @cinatra-ai/extensions):
 *   1. the LIVE WORKSPACE-ANCHORED row `(organization_id IS NULL, owner_level
 *      'workspace', owner_id '__platform__')` — one row that serves EVERY
 *      organization, since it names no owning org to be fenced by. While it
 *      lives it SUPERSEDES the organization's own row (owner ruling 2026-08-16);
 *   2. otherwise the ORGANIZATION's own row `(organization_id = orgId,
 *      owner_level 'organization', owner_id = orgId)`;
 *   3. otherwise a non-live workspace row (unchanged from #2697 — status is not
 *      a filter here, only a preference).
 *
 * S3 preferred the organization row. The inversion matters because a workspace
 * install now archives the organization's row IN PLACE: an org-first order would
 * govern the connector by the SUPERSEDED row's access declaration. Where no live
 * workspace row exists the organization arm wins exactly as before.
 *
 * All arms are ONE query with a deterministic preference ordering rather than
 * sequential round trips: this runs inside a SYNCHRONOUS render/filter path,
 * where a second round trip would be paid on every miss. The `ORDER BY` ranks
 * the three cases and `LIMIT 1` yields exactly the winner.
 *
 * The org-LESS caller is unchanged (`absent`): S3's contract is that the
 * workspace row serves every ORGANIZATION.
 *
 * Status is still NOT a FILTER — a package whose only row is archived resolves
 * exactly as it did before. The row's lifecycle state is the caller's concern;
 * this resolver answers "which row's access governs this package for this org".
 */
export function resolveConnectorCanonicalAccessSync(
  orgId: string | undefined,
  packageId: string,
): ConnectorCanonicalResult {
  if (!orgId) return { status: "absent" };
  try {
    const connectionString = getPostgresConnectionString();
    const schemaQ = postgresSchema.replaceAll('"', '""');
    const [installed] = runPostgresQueriesSync({
      connectionString,
      queries: [
        {
          text: `SELECT id, owner_level, owner_id, organization_id, access_declaration
                 FROM "${schemaQ}"."installed_extension"
                 WHERE package_name = $2 AND kind = 'connector'
                   AND (
                     (organization_id = $1 AND owner_level = 'organization' AND owner_id = $1)
                     OR (organization_id IS NULL AND owner_level = 'workspace' AND owner_id = $3)
                   )
                 ORDER BY CASE
                     WHEN organization_id IS NULL
                       AND status IN ('active', 'locked') THEN 0
                     WHEN organization_id IS NOT NULL THEN 1
                     ELSE 2
                   END
                 LIMIT 1`,
          values: [orgId, packageId, PLATFORM_OWNER_SENTINEL],
        },
      ],
    });
    const row = installed?.rows?.[0] as
      | {
          id: string;
          owner_level: string;
          owner_id: string | null;
          organization_id: string | null;
          access_declaration: unknown;
        }
      | undefined;
    if (!row) return { status: "absent" };

    // Cached declaration (cinatra#955): null = pre-reader row (the caller may
    // use the shipped catalog default); a present but structurally INVALID
    // value is a corrupt cache -> fail the read CLOSED (same posture as the
    // connection use-gate corrupt-cache handling), never a looser fallback.
    let declarationRaw: unknown = row.access_declaration ?? null;
    if (typeof declarationRaw === "string") {
      try {
        declarationRaw = JSON.parse(declarationRaw);
      } catch {
        return { status: "error" };
      }
    }
    if (declarationRaw !== null && !isResolvedConnectorAccessDeclaration(declarationRaw)) {
      return { status: "error" };
    }
    const accessDeclaration = declarationRaw as ResolvedConnectorAccessDeclaration | null;

    const resourceId = row.id;
    const [policyRes, coOwnerRes] = runPostgresQueriesSync({
      connectionString,
      queries: [
        {
          text: `SELECT policy, installed_by_user_id
                 FROM "${schemaQ}"."extension_access_policy"
                 WHERE resource_kind = 'connector' AND resource_id = $1`,
          values: [resourceId],
        },
        {
          text: `SELECT user_id FROM "${schemaQ}"."extension_co_owners"
                 WHERE resource_kind = 'connector' AND resource_id = $1`,
          values: [resourceId],
        },
      ],
    });

    const policyRow = policyRes?.rows?.[0] as
      | { policy: AgentAuthPolicy | string | null; installed_by_user_id: string | null }
      | undefined;
    let policy: AgentAuthPolicy | null = null;
    if (policyRow?.policy != null) {
      const raw =
        typeof policyRow.policy === "string"
          ? (JSON.parse(policyRow.policy) as unknown)
          : policyRow.policy;
      // Multi-scope W1: coerce stored scalar visibility fields to non-empty
      // arrays on read via the canonical schema; a schema-invalid row fails
      // closed (policy stays null → caller applies the fail-closed default).
      const parsed = AgentAuthPolicySchema.safeParse(raw);
      policy = parsed.success ? parsed.data : null;
    }
    const coOwnerUserIds = ((coOwnerRes?.rows ?? []) as Array<{ user_id: string }>).map(
      (r) => r.user_id,
    );

    return {
      status: "found",
      access: {
        resourceId,
        owner: {
          ownerLevel: row.owner_level as ExtensionOwnerContext["ownerLevel"],
          ownerId: row.owner_id,
          organizationId: row.organization_id,
        },
        policy,
        coOwnerUserIds,
        installedByUserId: policyRow?.installed_by_user_id ?? null,
        accessDeclaration,
      },
    };
  } catch {
    // DB read failed → fail closed. The caller denies (does NOT fall back to
    // the possibly-looser legacy/catalog default) and never throws in a sync
    // render/filter path.
    return { status: "error" };
  }
}

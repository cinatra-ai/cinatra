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
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import type { ExtensionOwnerContext } from "@cinatra-ai/extensions/enforce-extension-access";
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
 * synchronously. Never throws in the sync render path — DB failures surface as
 * `{status:"error"}` so the caller can fail closed.
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
                 WHERE organization_id = $1 AND owner_level = 'organization'
                   AND owner_id = $1 AND package_name = $2 AND kind = 'connector'
                 LIMIT 1`,
          values: [orgId, packageId],
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
      policy =
        typeof policyRow.policy === "string"
          ? (JSON.parse(policyRow.policy) as AgentAuthPolicy)
          : policyRow.policy;
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

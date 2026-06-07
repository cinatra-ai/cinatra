import "server-only";

// Read/write helpers for the `connector_access_policy` table. Thin storage
// layer; per-mode enforcement lives in `src/lib/connector-policy.ts`.

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

export type ConnectorVisibility = "admin" | "workspace";

export type ConnectorAccessPolicyRow = {
  id: string;
  orgId: string;
  packageId: string;
  ownerUserId: string;
  visibility: ConnectorVisibility;
  sourceTag: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ConnectorPolicyUpsertInput = {
  orgId: string;
  packageId: string;
  ownerUserId: string;
  visibility: ConnectorVisibility;
  sourceTag?: string;
};

type Row = {
  id: string;
  org_id: string;
  package_id: string;
  owner_user_id: string;
  visibility: string;
  source_tag: string;
  created_at: string | Date;
  updated_at: string | Date;
};

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function mapRow(r: Row): ConnectorAccessPolicyRow {
  return {
    id: r.id,
    orgId: r.org_id,
    packageId: r.package_id,
    ownerUserId: r.owner_user_id,
    visibility: r.visibility as ConnectorVisibility,
    sourceTag: r.source_tag,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

export function readConnectorAccessPolicy(
  orgId: string,
  packageId: string,
): ConnectorAccessPolicyRow | undefined {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, org_id, package_id, owner_user_id, visibility, source_tag, created_at, updated_at
               FROM "${schema.replaceAll('"', '""')}"."connector_access_policy"
               WHERE org_id = $1 AND package_id = $2
               LIMIT 1`,
        values: [orgId, packageId],
      },
    ],
  });
  const row = (result?.rows ?? [])[0] as Row | undefined;
  return row ? mapRow(row) : undefined;
}

export function listConnectorAccessPoliciesForOrg(
  orgId: string,
): ConnectorAccessPolicyRow[] {
  const connectionString = getPostgresConnectionString();
  const schema = postgresSchema;
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT id, org_id, package_id, owner_user_id, visibility, source_tag, created_at, updated_at
               FROM "${schema.replaceAll('"', '""')}"."connector_access_policy"
               WHERE org_id = $1
               ORDER BY package_id ASC`,
        values: [orgId],
      },
    ],
  });
  return ((result?.rows ?? []) as Row[]).map(mapRow);
}

// ---------------------------------------------------------------------------
// NEW connector_access_policy WRITES ARE BLOCKED.
//
// Connector access now lives in the uniform polymorphic model
// (installed_extension + extension_access_policy). All access config goes
// through setExtensionInstallAccess (@cinatra-ai/extensions/install-access-contract)
// / saveExtensionAccessPolicy. The legacy table is retained READ-ONLY as the
// absence-only fallback shim (readConnectorAccessPolicy /
// listConnectorAccessPoliciesForOrg) until a removal migration after prod
// verification. These write functions fail loud so a stray new caller is caught
// immediately rather than silently writing to the deprecated authority. A
// static drift gate (scripts/audit/connector-access-policy-write-gate.mjs)
// blocks new write call sites at CI time.
// ---------------------------------------------------------------------------

const LEGACY_WRITE_BLOCKED =
  "connector_access_policy is deprecated — write connector access via " +
  "setExtensionInstallAccess / saveExtensionAccessPolicy (polymorphic model), not this table.";

export function upsertConnectorAccessPolicy(
  _input: ConnectorPolicyUpsertInput,
): void {
  throw new Error(LEGACY_WRITE_BLOCKED);
}

export function batchUpsertConnectorPoliciesForFixture(
  _rows: ConnectorPolicyUpsertInput[],
  _sourceTag: string,
): void {
  throw new Error(LEGACY_WRITE_BLOCKED);
}

export function deleteConnectorAccessPolicy(
  _orgId: string,
  _packageId: string,
): void {
  throw new Error(LEGACY_WRITE_BLOCKED);
}

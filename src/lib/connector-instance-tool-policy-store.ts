import "server-only";

// Persisted per-`(connectorKey, instanceId)` tool-policy store (cinatra#2017 S2
// slice K4 / design §2.6 / D4 / R2-B2 / R3-B2). The governed invoker reads a
// record at step 2 and the `tools_list` per-row `policyStatus` reflects it; the
// pure decision logic lives in `@cinatra-ai/mcp-server/instance-tool-policy`
// (`evaluateInstanceToolPolicy`). This module owns PERSISTENCE only.
//
// The "migrated instances are pinned OPEN" guarantee is delivered by THREE layers
// (R2-B2), never a single in-migration enumeration:
//   1. creation-default writer — wired into the host-side instance-creation hook
//      (register-host-connector-services), so a new instance has an explicit
//      `mode:"open"` row BEFORE any tool_call/tools_list (R3-B2, the PRIMARY
//      guarantee; a write failure fails the creation loudly);
//   2. deploy-gated reconcile — `reconcileConnectorInstanceToolPolicies` writes
//      an explicit `open` row for every enrolled instance under a SYSTEM actor,
//      idempotently, run at deploy/boot;
//   3. lazy first-touch backstop — the invoker's authorized path calls
//      `ensureDefaultOpenPolicy` on the first authorized touch, so a
//      never-reconciled instance converges to an explicit row the moment it is
//      used ("absent" is provably transient, never a steady state).
// An ABSENT read is a compatibility FALLBACK (open) only (M5 / §10-A3), never the
// normal migrated state.
//
// DB access mirrors extension-update-read-model-store: an INJECTED query fn
// (unit-testable without a DB) + a lazy pooled connection + a schema-qualified
// table. The backing table is the ADDITIVE bootstrap DDL in
// connector-instance-tool-policy-schema.ts (no numbered migration —
// migrations/README.md).

import { getPooledDb } from "@/lib/db/pooled";
import { logAuditEvent } from "@/lib/authz/audit";
import type {
  InstanceToolPolicyRecord,
  InstanceToolPolicyMode,
  ToolRef,
} from "@cinatra-ai/mcp-server/instance-tool-policy";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const TABLE = "connector_instance_tool_policy";

/** The system actor recorded on reconcile/backfill-written rows — attributable
 * and distinguishable from an operator edit (R2-B2). */
export const SYSTEM_POLICY_BACKFILL_ACTOR = "system:connector-instance-policy-backfill";
/** The system actor recorded when the creation hook writes the default row and
 * the creating human actor is not resolvable host-side. */
export const SYSTEM_POLICY_CREATION_ACTOR = "system:connector-instance-policy-creation";

export type PolicyStoreQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type PolicyStoreDeps = {
  /** Injected query fn (tests pass a mock). Default = the pooled connection. */
  query?: PolicyStoreQuery;
  /** Injected schema (tests may override). Default = SUPABASE_SCHEMA / "cinatra". */
  schema?: string;
  /** Injected audit sink (tests may spy). Default = the host audit log. */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "connector-instance-tool-policy" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

function resolveDeps(deps?: PolicyStoreDeps): {
  query: PolicyStoreQuery;
  table: string;
  audit: NonNullable<PolicyStoreDeps["audit"]>;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quote
  // defensively all the same (mirrors the store's `"schema"."table"` form).
  const table = `"${schema.replaceAll('"', '""')}"."${TABLE}"`;
  return {
    query: deps?.query ?? defaultQuery,
    table,
    audit: deps?.audit ?? ((event) => logAuditEvent(event)),
  };
}

type PolicyRow = {
  connector_key: string;
  instance_id: string;
  mode: string;
  allow_refs: unknown;
  deny_refs: unknown;
  updated_by: string;
  updated_at: string | Date;
};

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Normalise a jsonb array column. NULL jsonb (absent list) → `undefined` (a
 * valid "no list"). A PRESENT-but-MALFORMED value (non-array, e.g. a stray
 * `'{}'::jsonb`) is PASSED THROUGH raw (cast) so the pure evaluator's
 * `isValidInstanceToolPolicyRecord` REJECTS the whole record → fail-closed
 * deny-all (§10-A3). Never silently coerce malformed persisted data to "none"
 * (that would fail OPEN — codex R1 blocker). The evaluator re-validates each
 * entry, so this only shapes; it never trusts. */
function toRefArray(value: unknown): ToolRef[] | undefined {
  if (value === null || value === undefined) return undefined;
  return value as ToolRef[];
}

function rowToRecord(row: PolicyRow): InstanceToolPolicyRecord {
  return {
    connectorKey: row.connector_key,
    instanceId: row.instance_id,
    // Cast the stored string; a garbage mode is caught by the evaluator's
    // `isValidInstanceToolPolicyRecord` → fail-closed deny-all (§10-A3).
    mode: row.mode as InstanceToolPolicyMode,
    allow: toRefArray(row.allow_refs),
    deny: toRefArray(row.deny_refs),
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Read the persisted policy for `(connectorKey, instanceId)`, or `null` when no
 * row exists (the compatibility-fallback-open window — see §10-A3; the caller
 * warns-once and treats it as open). Point read on the primary key.
 */
export async function readInstanceToolPolicy(
  connectorKey: string,
  instanceId: string,
  deps?: PolicyStoreDeps,
): Promise<InstanceToolPolicyRecord | null> {
  const { query, table } = resolveDeps(deps);
  const rows = await query<PolicyRow>(
    `SELECT connector_key, instance_id, mode, allow_refs, deny_refs, updated_by, updated_at
       FROM ${table}
      WHERE connector_key = $1 AND instance_id = $2
      LIMIT 1`,
    [connectorKey, instanceId],
  );
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Ensure an explicit `mode:"open"` row exists for `(connectorKey, instanceId)` —
 * a create-if-absent default (INSERT … ON CONFLICT DO NOTHING). NEVER clobbers an
 * existing row (an operator edit / a prior open row survives). Returns
 * `{ created }`; emits an audit event only when a row is actually written.
 *
 * This is the SHARED core of all three write layers: the creation-hook writer,
 * the deploy-gated reconcile, and the lazy first-touch backstop each call it with
 * their own `updatedBy` attribution.
 */
export async function ensureDefaultOpenPolicy(
  input: { connectorKey: string; instanceId: string; updatedBy: string; reason: string },
  deps?: PolicyStoreDeps,
): Promise<{ created: boolean }> {
  const { query, table, audit } = resolveDeps(deps);
  const rows = await query<{ connector_key: string }>(
    `INSERT INTO ${table} (connector_key, instance_id, mode, allow_refs, deny_refs, updated_by, updated_at)
     VALUES ($1, $2, 'open', NULL, NULL, $3, now())
     ON CONFLICT (connector_key, instance_id) DO NOTHING
     RETURNING connector_key`,
    [input.connectorKey, input.instanceId, input.updatedBy],
  );
  const created = rows.length > 0;
  if (created) {
    await audit({
      resourceType: "connector_instance",
      resourceId: input.instanceId,
      actorPrincipalType: "system",
      authSource: "worker",
      operation: "policy_default_open",
      decision: "allowed",
      policyVersion: "connector-instance-tool-policy",
      metadata: {
        connectorKey: input.connectorKey,
        mode: "open",
        updatedBy: input.updatedBy,
        reason: input.reason,
      },
    });
  }
  return { created };
}

/**
 * Creation-hook writer (R3-B2, the PRIMARY guarantee): write the explicit
 * `mode:"open"` default at instance creation, BEFORE any tool_call/tools_list.
 * Wired into the host-side instance-creation hook; a write failure must fail the
 * creation loudly (this throws on a DB error rather than swallowing).
 */
export async function writeCreationDefaultPolicy(
  input: { connectorKey: string; instanceId: string; updatedBy?: string },
  deps?: PolicyStoreDeps,
): Promise<void> {
  await ensureDefaultOpenPolicy(
    {
      connectorKey: input.connectorKey,
      instanceId: input.instanceId,
      updatedBy: input.updatedBy ?? SYSTEM_POLICY_CREATION_ACTOR,
      reason: "instance_creation_hook",
    },
    deps,
  );
}

/**
 * Deploy-gated, idempotent reconcile (R2-B2): write an explicit `mode:"open"` row
 * for every enrolled instance under the SYSTEM backfill actor. Enumerates the
 * host-side reader's instance ids (passed in — the store never reaches into the
 * connector-config KV blob itself), so this is a data step run at deploy/boot,
 * NOT an in-DDL migration. Returns the number of rows newly written.
 */
export async function reconcileConnectorInstanceToolPolicies(
  input: { connectorKey: string; instanceIds: readonly string[] },
  deps?: PolicyStoreDeps,
): Promise<{ written: number; total: number }> {
  let written = 0;
  for (const instanceId of input.instanceIds) {
    if (!instanceId) continue;
    const { created } = await ensureDefaultOpenPolicy(
      {
        connectorKey: input.connectorKey,
        instanceId,
        updatedBy: SYSTEM_POLICY_BACKFILL_ACTOR,
        reason: "deploy_reconcile",
      },
      deps,
    );
    if (created) written += 1;
  }
  return { written, total: input.instanceIds.length };
}

/**
 * Mutation writer for an operator/system policy CHANGE (mode flip, allow/deny
 * edit). Upserts the full record (ON CONFLICT DO UPDATE) and emits an audit
 * event. Distinct from the create-if-absent default writers above, which never
 * clobber. `allow`/`deny` are written as jsonb arrays of `{serverId, name}`.
 */
export async function writeInstanceToolPolicy(
  record: {
    connectorKey: string;
    instanceId: string;
    mode: InstanceToolPolicyMode;
    allow?: ToolRef[];
    deny?: ToolRef[];
    updatedBy: string;
  },
  deps?: PolicyStoreDeps,
): Promise<void> {
  const { query, table, audit } = resolveDeps(deps);
  await query(
    `INSERT INTO ${table} (connector_key, instance_id, mode, allow_refs, deny_refs, updated_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
     ON CONFLICT (connector_key, instance_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       allow_refs = EXCLUDED.allow_refs,
       deny_refs = EXCLUDED.deny_refs,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
    [
      record.connectorKey,
      record.instanceId,
      record.mode,
      record.allow ? JSON.stringify(record.allow) : null,
      record.deny ? JSON.stringify(record.deny) : null,
      record.updatedBy,
    ],
  );
  await audit({
    resourceType: "connector_instance",
    resourceId: record.instanceId,
    actorPrincipalType: "human",
    ...(record.updatedBy ? { actorPrincipalId: record.updatedBy } : {}),
    authSource: "mcp",
    operation: "policy_update",
    decision: "allowed",
    policyVersion: "connector-instance-tool-policy",
    metadata: {
      connectorKey: record.connectorKey,
      mode: record.mode,
      allowCount: record.allow?.length ?? 0,
      denyCount: record.deny?.length ?? 0,
      updatedBy: record.updatedBy,
    },
  });
}

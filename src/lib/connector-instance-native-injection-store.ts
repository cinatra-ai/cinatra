import "server-only";

// Persisted per-`(connectorKey, instanceId)` trusted-site native-injection
// OPT-IN store (cinatra#2019 S4). This is the policy row the S4 injection
// builder reads before ANY native read-injection may be assembled for an
// instance: absent row = OFF (native injection never happens without an
// explicit, audited org-admin ceremony), and a `trusted_site` row is only
// honored while (a) its HOST-STAMPED consent stamps exactly match the
// currently shipped descriptor-set/disclosure constants
// (connector-instance-trusted-read-descriptors.ts) and (b) its `consented_org_id`
// equals the instance's CURRENT owning org — consent never survives an
// ownership change of the instance id.
//
// This module owns PERSISTENCE only. The org-admin authorization gate and the
// host-side consent stamping live in connector-instance-native-injection-consent.ts
// (the published members); the injection eligibility computation is a separate
// consumer. Nothing here evaluates trust — it records and reports it.
//
// FAIL-CLOSED READS: a malformed persisted row (unknown mode, or a
// `trusted_site` row missing a consent stamp underneath the DB CHECK) is
// reported as OFF and audited loudly — malformed governance state may only
// ever narrow behavior, never widen it (the S2 invalid-policy pattern).
//
// DB access mirrors connector-instance-tool-policy-store: an INJECTED query fn
// (unit-testable without a DB) + a lazy pooled connection + a schema-qualified
// table. The backing table is the ADDITIVE bootstrap DDL in
// connector-instance-native-injection-schema.ts (no numbered migration —
// migrations/README.md).

import { getPooledDb } from "@/lib/db/pooled";
import { logAuditEvent, logAuditEventStrict } from "@/lib/authz/audit";

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
const TABLE = "connector_instance_native_injection_policy";

/** The audit policyVersion every event from this concern carries. */
export const NATIVE_INJECTION_POLICY_VERSION = "connector-instance-native-injection";

export type NativeInjectionMode = "off" | "trusted_site";

/** The normalized, always-total read result. Absent and malformed rows both
 * read as `mode:"off"` with null fields — consumers never see raw row state. */
export type NativeInjectionPolicyView = {
  mode: NativeInjectionMode;
  /** HOST-STAMPED at enable/re-acknowledge; null while off/absent. */
  disclosureVersion: string | null;
  descriptorSetVersion: number | null;
  descriptorSetHash: string | null;
  /** The org whose admin performed the ceremony (consent is ORG-BOUND). */
  consentedOrgId: string | null;
  /** The org-admin who performed the last enable/re-acknowledge ceremony. */
  enabledBy: string | null;
  enabledAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type NativeInjectionStoreQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type NativeInjectionStoreDeps = {
  /** Injected query fn (tests pass a mock). Default = the pooled connection. */
  query?: NativeInjectionStoreQuery;
  /** Injected schema (tests may override). Default = SUPABASE_SCHEMA / "cinatra". */
  schema?: string;
  /** Injected BEST-EFFORT audit sink (tests may spy). Default = the host
   * audit log's fail-silent writer (never throws, never blocks). */
  audit?: (event: Parameters<typeof logAuditEvent>[0]) => Promise<void> | void;
  /** Injected STRICT audit sink for the privileged `trusted_site` direction.
   * Default = `logAuditEventStrict` — an insert failure PROPAGATES and the
   * enable is aborted before anything is written (no consent row may exist
   * without its authorization record). */
  auditStrict?: (event: Parameters<typeof logAuditEventStrict>[0]) => Promise<unknown>;
};

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPooledDb({ name: "connector-instance-native-injection" });
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

function resolveDeps(deps?: NativeInjectionStoreDeps): {
  query: NativeInjectionStoreQuery;
  table: string;
  audit: NonNullable<NativeInjectionStoreDeps["audit"]>;
  auditStrict: NonNullable<NativeInjectionStoreDeps["auditStrict"]>;
} {
  const schema = deps?.schema ?? schemaName;
  // schemaName / SUPABASE_SCHEMA is operator config, never user input; quote
  // defensively all the same (mirrors the store's `"schema"."table"` form).
  const table = `"${schema.replaceAll('"', '""')}"."${TABLE}"`;
  return {
    query: deps?.query ?? defaultQuery,
    table,
    audit: deps?.audit ?? ((event) => logAuditEvent(event)),
    auditStrict: deps?.auditStrict ?? ((event) => logAuditEventStrict(event)),
  };
}

type NativeInjectionRow = {
  connector_key: string;
  instance_id: string;
  mode: string;
  disclosure_version: string | null;
  descriptor_set_version: number | string | null;
  descriptor_set_hash: string | null;
  consented_org_id: string | null;
  enabled_by: string | null;
  enabled_at: string | Date | null;
  updated_by: string;
  updated_at: string | Date;
};

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** integer columns can surface as strings depending on driver/parser config;
 * normalize without ever inventing a number from garbage. */
function toIntOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && String(parsed) === value.trim() ? parsed : null;
}

const OFF_VIEW: Omit<NativeInjectionPolicyView, "updatedBy" | "updatedAt"> = {
  mode: "off",
  disclosureVersion: null,
  descriptorSetVersion: null,
  descriptorSetHash: null,
  consentedOrgId: null,
  enabledBy: null,
  enabledAt: null,
};

function offView(): NativeInjectionPolicyView {
  return { ...OFF_VIEW, updatedBy: null, updatedAt: null };
}

/**
 * Read the opt-in state for `(connectorKey, instanceId)` AS SEEN BY the
 * instance's CURRENT owning org (`ownerOrgId` — the caller resolves it from
 * the persisted instance row, never from user input; it is REQUIRED so no
 * consumer can skip the ownership check). Total and fail-closed:
 *   - no row                → `mode:"off"` (the default: never opted in);
 *   - unknown `mode` value  → `mode:"off"` + a loud `denied` audit;
 *   - `trusted_site` row missing any consent stamp, the org stamp or the
 *     enable attribution (unrepresentable under the DDL CHECK) →
 *     `mode:"off"` + a loud `denied` audit;
 *   - `trusted_site` row whose `consented_org_id` ≠ `ownerOrgId` (the
 *     instance changed owner after the ceremony) → `mode:"off"` + a loud
 *     `denied` audit — the NEW owner must run its own ceremony.
 * A malformed or stale-owner governance row can only ever NARROW behavior.
 */
export async function readNativeInjectionPolicy(
  connectorKey: string,
  instanceId: string,
  ownerOrgId: string,
  deps?: NativeInjectionStoreDeps,
): Promise<NativeInjectionPolicyView> {
  const { query, table, audit } = resolveDeps(deps);
  if (typeof ownerOrgId !== "string" || !ownerOrgId.trim()) {
    throw new Error("readNativeInjectionPolicy requires the instance's owning org id");
  }
  const rows = await query<NativeInjectionRow>(
    `SELECT connector_key, instance_id, mode, disclosure_version, descriptor_set_version,
            descriptor_set_hash, consented_org_id, enabled_by, enabled_at, updated_by, updated_at
       FROM ${table}
      WHERE connector_key = $1 AND instance_id = $2
      LIMIT 1`,
    [connectorKey, instanceId],
  );
  const row = rows[0];
  if (!row) return offView();

  const invalid = async (reason: string): Promise<NativeInjectionPolicyView> => {
    await audit({
      resourceType: "connector_instance",
      resourceId: instanceId,
      actorPrincipalType: "system",
      authSource: "worker",
      operation: "native_injection_policy_invalid",
      decision: "denied",
      policyVersion: NATIVE_INJECTION_POLICY_VERSION,
      metadata: { connectorKey, reason },
    });
    return offView();
  };

  if (row.mode !== "off" && row.mode !== "trusted_site") {
    return invalid("unknown_mode_read_as_off");
  }
  const descriptorSetVersion = toIntOrNull(row.descriptor_set_version);
  if (
    row.mode === "trusted_site" &&
    (typeof row.disclosure_version !== "string" ||
      descriptorSetVersion === null ||
      typeof row.descriptor_set_hash !== "string" ||
      typeof row.consented_org_id !== "string" ||
      typeof row.enabled_by !== "string" ||
      !row.enabled_at)
  ) {
    return invalid("trusted_site_missing_consent_stamps_read_as_off");
  }
  if (row.mode === "trusted_site" && row.consented_org_id !== ownerOrgId) {
    return invalid("consented_org_mismatch_read_as_off");
  }
  return {
    mode: row.mode,
    disclosureVersion: row.disclosure_version ?? null,
    descriptorSetVersion,
    descriptorSetHash: row.descriptor_set_hash ?? null,
    consentedOrgId: row.consented_org_id ?? null,
    enabledBy: row.enabled_by ?? null,
    enabledAt: toIsoOrNull(row.enabled_at),
    updatedBy: row.updated_by,
    updatedAt: toIsoOrNull(row.updated_at),
  };
}

export type SetNativeInjectionModeInput = {
  connectorKey: string;
  instanceId: string;
  mode: NativeInjectionMode;
  /** The authenticated org-admin the caller (the published member) resolved.
   * Recorded as `updated_by` (+ `enabled_by` on `trusted_site`). */
  actorUserId: string;
  /** The instance's OWNING org, resolved by the caller from the persisted
   * instance row (the same org the admin gate was evaluated against).
   * Recorded as `consented_org_id` on `trusted_site` (consent is ORG-BOUND);
   * always required so the prior-state read is owner-scoped too. */
  actorOrgId: string;
  /** HOST-STAMPED consent values — REQUIRED (all three) for `trusted_site`,
   * forced NULL for `off`. The published member supplies the shipped
   * constants; this writer refuses a partial acknowledgement outright. */
  disclosureVersion?: string;
  descriptorSetVersion?: number;
  descriptorSetHash?: string;
};

/**
 * Upsert the opt-in row + emit the `native_injection_mode_changed` audit
 * event (the authorization record for every transition, including
 * re-acknowledgements). `off` clears the consent stamps and the enabled-by
 * attribution — a later re-enable is a fresh ceremony with fresh stamps.
 *
 * AUDIT ORDERING IS ASYMMETRIC, fail-closed in BOTH directions:
 *   - `trusted_site` (the privileged direction): the audit record is written
 *     FIRST through the STRICT sink — an audit-insert failure aborts the
 *     enable with NOTHING written (a consent row may never exist without its
 *     authorization record; the `withPlatformAdminBypass` strict-audit
 *     doctrine). The residual failure mode is a stray record for an enable
 *     that then failed to persist — false-positive noise, never a silent
 *     enable. The row itself additionally carries `enabled_by`/`enabled_at`.
 *   - `off` (revocation): the row is written FIRST and the audit is
 *     best-effort — an audit outage must never keep native injection
 *     ENABLED.
 *
 * The `from` value in the audit metadata is a pre-read: a concurrent
 * ceremony racing this call can only misreport `from` (informational
 * attribution), never the persisted outcome — the upsert itself is atomic
 * and this store's contract is single-statement injected queries.
 *
 * Throws (nothing written) on a `trusted_site` write missing any consent
 * stamp or the acting user — the in-process twin of the DDL's
 * `trusted_site_stamps` CHECK.
 */
export async function setNativeInjectionMode(
  input: SetNativeInjectionModeInput,
  deps?: NativeInjectionStoreDeps,
): Promise<void> {
  const { query, table, audit, auditStrict } = resolveDeps(deps);
  if (!input.actorUserId) {
    throw new Error("setNativeInjectionMode requires the acting user id");
  }
  if (typeof input.actorOrgId !== "string" || !input.actorOrgId.trim()) {
    throw new Error("setNativeInjectionMode requires the instance's owning org id");
  }
  if (input.mode !== "off" && input.mode !== "trusted_site") {
    throw new Error(`setNativeInjectionMode: unknown mode ${JSON.stringify(input.mode)}`);
  }
  const trusted = input.mode === "trusted_site";
  if (
    trusted &&
    (typeof input.disclosureVersion !== "string" ||
      !Number.isInteger(input.descriptorSetVersion) ||
      typeof input.descriptorSetHash !== "string")
  ) {
    throw new Error(
      "setNativeInjectionMode: a trusted_site write requires all three host-stamped consent values",
    );
  }

  const prior = await readNativeInjectionPolicy(
    input.connectorKey,
    input.instanceId,
    input.actorOrgId,
    deps,
  );
  const auditEvent = {
    resourceType: "connector_instance",
    resourceId: input.instanceId,
    organizationId: input.actorOrgId,
    actorPrincipalType: "human",
    actorPrincipalId: input.actorUserId,
    authSource: "ui",
    operation: "native_injection_mode_changed",
    decision: "allowed",
    policyVersion: NATIVE_INJECTION_POLICY_VERSION,
    metadata: {
      connectorKey: input.connectorKey,
      from: prior.mode,
      to: input.mode,
      updatedBy: input.actorUserId,
      ...(trusted
        ? {
            disclosureVersion: input.disclosureVersion,
            descriptorSetVersion: input.descriptorSetVersion,
            descriptorSetHash: input.descriptorSetHash,
            consentedOrgId: input.actorOrgId,
          }
        : {}),
    },
  } as const;

  // Privileged direction: authorization record BEFORE the row flip; a strict
  // audit failure propagates and nothing is written.
  if (trusted) await auditStrict(auditEvent);

  await query(
    `INSERT INTO ${table} (connector_key, instance_id, mode, disclosure_version,
                           descriptor_set_version, descriptor_set_hash, consented_org_id,
                           enabled_by, enabled_at, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $3 = 'trusted_site' THEN now() END, $9, now())
     ON CONFLICT (connector_key, instance_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       disclosure_version = EXCLUDED.disclosure_version,
       descriptor_set_version = EXCLUDED.descriptor_set_version,
       descriptor_set_hash = EXCLUDED.descriptor_set_hash,
       consented_org_id = EXCLUDED.consented_org_id,
       enabled_by = EXCLUDED.enabled_by,
       enabled_at = EXCLUDED.enabled_at,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
    [
      input.connectorKey,
      input.instanceId,
      input.mode,
      trusted ? input.disclosureVersion : null,
      trusted ? input.descriptorSetVersion : null,
      trusted ? input.descriptorSetHash : null,
      trusted ? input.actorOrgId : null,
      trusted ? input.actorUserId : null,
      input.actorUserId,
    ],
  );

  // Revocation direction: the row flip above is the priority; the audit is
  // best-effort (the default sink never throws).
  if (!trusted) await audit(auditEvent);
}

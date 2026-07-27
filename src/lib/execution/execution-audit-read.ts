import "server-only";

// Org-admin READ path for execution-plane audit rows (exec-plane S1b
// activation, cinatra#2138 deliverable 3; epic #1705).
//
// The broker writes every command — executed, refused, terminated alike —
// through the EXISTING authz audit kernel (`audit_events`, the platform
// database, alongside the execution stores). No new table, no migration: the
// kernel already models exactly the fields the issue names (actor, org, run,
// operation, decision, metadata, timestamp) and already strips a sensitive-key
// blocklist on write.
//
// This module is the READ half the health surface renders. Deliberately light:
// it takes NO `@cinatra-ai/execution-plane` import, so the admin page never
// pulls the broker graph into its module scope.
//
// METADATA-ONLY GUARANTEE (issue deliverable 3): the projection below is an
// explicit ALLOWLIST. It can only ever surface event metadata — never prompt
// text, never the executed command, never credentials, never the full network
// destination list (only the tier + the byte total the broker's own
// `toAuthzAuditEventInput` mapper puts in `metadata`).

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

/** `resourceType` the broker's authz-kernel mapping stamps on every row. */
export const EXECUTION_AUDIT_RESOURCE_TYPE = "execution_sandbox";
/** `operation` the broker's authz-kernel mapping stamps on every row. */
export const EXECUTION_AUDIT_OPERATION = "sandbox_execute";

export type ExecutionAuditRow = {
  id: string;
  /** Job the command belonged to (the audit row's resourceId). */
  jobId: string;
  orgId: string | null;
  /** Attributable actor — the session's userId. */
  actorId: string | null;
  /** Minting surface: chat / agent_run / deterministic_task / skill_task. */
  surface: string | null;
  /** #1192 run binding, present exactly when the session carried a runId. */
  runId: string | null;
  decision: string | null;
  /** Refusal / termination class, e.g. run_removed, environment_untrusted. */
  reason: string | null;
  exitCode: number | null;
  termination: string | null;
  /** Environment identity — the resolved image digest that actually ran. */
  imageDigest: string | null;
  egressMode: string | null;
  egressTotalBytes: number | null;
  wallMs: number | null;
  createdAt: string;
};

function num(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function str(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

/**
 * Most-recent execution audit rows, newest first. `orgId` scopes the read to
 * the caller's organization (an org admin reads their org's rows); omitting it
 * is an instance-wide read reserved for the platform-admin health surface.
 * Never throws: an unavailable store resolves an empty list so the health
 * surface degrades instead of 500-ing.
 */
export function readExecutionAuditRows(input?: {
  orgId?: string | null;
  limit?: number;
}): ExecutionAuditRow[] {
  const limit = Math.min(Math.max(Math.floor(input?.limit ?? 25), 1), 200);
  const schema = postgresSchema.replaceAll('"', '""');
  const orgId = input?.orgId ?? null;
  const values: unknown[] = [EXECUTION_AUDIT_RESOURCE_TYPE, EXECUTION_AUDIT_OPERATION];
  let orgClause = "";
  if (orgId) {
    values.push(orgId);
    orgClause = ` AND organization_id = $${values.length}`;
  }
  values.push(limit);
  const text =
    `SELECT id, organization_id, actor_principal_id, resource_id, run_id, decision, ` +
    `metadata, created_at FROM "${schema}"."audit_events" ` +
    `WHERE resource_type = $1 AND operation = $2${orgClause} ` +
    `ORDER BY created_at DESC LIMIT $${values.length}`;
  let rows: Array<Record<string, unknown>>;
  try {
    ensurePostgresSchema();
    const result = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [{ text, values }],
    }) as Array<{ rows: Array<Record<string, unknown>> }>;
    rows = result[0]?.rows ?? [];
  } catch {
    return [];
  }
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const createdAt = row.created_at;
    return {
      id: String(row.id),
      jobId: String(row.resource_id ?? ""),
      orgId: str(row.organization_id),
      actorId: str(row.actor_principal_id),
      surface: str(meta.surface),
      runId: str(row.run_id),
      decision: str(row.decision),
      reason: str(meta.reason),
      exitCode: num(meta.exitCode),
      termination: str(meta.termination),
      imageDigest: str(meta.imageDigest),
      egressMode: str(meta.egressMode),
      egressTotalBytes: num(meta.egressTotalBytes),
      wallMs: num(meta.wallMs),
      createdAt:
        createdAt instanceof Date ? createdAt.toISOString() : String(createdAt ?? ""),
    };
  });
}

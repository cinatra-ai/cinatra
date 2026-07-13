// Per-claim activation gate (cinatra#1429, epic #1424).
//
// A claim over a typed object row cannot activate until registered-Zod
// validation for NEW writes of that type is ENFORCED, and the type's LEGACY
// rows have been audited — invalid rows QUARANTINED — so activation never
// binds an invalid row (AC-4). Two responsibilities:
//
//   - assertClaimActivatable — the pre-activation gate. Fail-closed: a type with
//     no registered validator cannot activate (NEW writes could not be
//     validated). Then audit every existing row of the type against the
//     validator and quarantine the invalid ones (idempotent). The lifecycle
//     calls this BEFORE the claim registry's activateArtifactTypeClaim.
//
//   - assertActivatedTypePayloadValid — the NEW-write enforcement. A save of an
//     invalid payload for a type that carries an active DEDICATED claim + a
//     registered validator is REJECTED at the write path (the objects_save /
//     objects_update handler resolves the Zod schema from the registry and
//     passes it here).
//
// Registry-agnostic: the caller injects a `validate(data) => boolean` (a
// registered Zod schema's safeParse success) so this module never imports the
// server/React-adjacent object-type registry. It writes ONLY the quarantine
// table + reads `objects` — never an `objects` mutation.

import "server-only";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/** A claim cannot activate: NEW writes of the claimed type cannot be validated
 * (no registered Zod schema). Fail-closed — the install surfaces this. */
export class ClaimNotActivatableError extends Error {
  constructor(public readonly objectTypeId: string) {
    super(
      `claim over '${objectTypeId}' cannot activate: no registered validation schema — NEW writes of this type could not be enforced`,
    );
    this.name = "ClaimNotActivatableError";
  }
}

/** A save of an invalid payload for an activated (claimed + validated) type. */
export class InvalidActivatedTypePayloadError extends Error {
  constructor(
    public readonly objectTypeId: string,
    public readonly detail?: string,
  ) {
    super(
      `invalid payload for activated type '${objectTypeId}': it does not satisfy the registered schema${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "InvalidActivatedTypePayloadError";
  }
}

function scopeOrgFilter(scope: string): string | null {
  return scope.startsWith("org:") ? scope.slice("org:".length) : null;
}

/** Insert a quarantine record (idempotent — one live record per (org, object)). */
export function quarantineObject(input: {
  orgId: string;
  objectId: string;
  objectTypeId: string;
  generation?: number | null;
  reason: string;
  detail?: unknown;
}): void {
  ensurePostgresSchema();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `INSERT INTO "${q()}"."object_binding_quarantine"
  (org_id, object_id, object_type_id, quarantined_generation, reason, detail)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (org_id, object_id) DO NOTHING`,
        values: [
          input.orgId,
          input.objectId,
          input.objectTypeId,
          input.generation ?? null,
          input.reason,
          input.detail === undefined ? null : JSON.stringify(input.detail),
        ],
      },
    ],
  });
}

/** True when (org, object) has a live quarantine record. */
export function isObjectQuarantined(orgId: string, objectId: string): boolean {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT 1 FROM "${q()}"."object_binding_quarantine" WHERE org_id = $1 AND object_id = $2 LIMIT 1`,
        values: [orgId, objectId],
      },
    ],
  });
  return (r?.[0]?.rows?.length ?? 0) > 0;
}

/** Whether a type carries a winner-eligible DEDICATED claim in the org's scope
 * chain — the axis the NEW-write enforcement gates on (only an activated,
 * dedicated-claimed type is validated). */
export function typeHasActiveDedicatedClaim(orgId: string, objectTypeId: string): boolean {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT 1 FROM "${q()}"."artifact_type_claims"
WHERE object_type_id = $2 AND claim_kind = 'dedicated'
  AND status IN ('active','retiring')
  AND (scope = 'platform' OR scope = 'org:' || $1)
LIMIT 1`,
        values: [orgId, objectTypeId],
      },
    ],
  });
  return (r?.[0]?.rows?.length ?? 0) > 0;
}

export interface ClaimActivationAuditResult {
  audited: number;
  quarantined: number;
}

/**
 * Pre-activation gate. Throws ClaimNotActivatableError when the type has no
 * registered validator (`validate == null`). Otherwise audits every existing
 * row of the type in the claim scope against the validator and quarantines the
 * invalid ones (idempotent). Returns the audit counts. The lifecycle runs this
 * before activating the claim so activation never binds an invalid row.
 */
export function assertClaimActivatable(input: {
  scope: string;
  objectTypeId: string;
  generation?: number | null;
  /** A registered validator (Zod safeParse success). `null` ⇒ not activatable. */
  validate: ((data: unknown) => boolean) | null;
  batchSize?: number;
}): ClaimActivationAuditResult {
  if (input.validate == null) {
    throw new ClaimNotActivatableError(input.objectTypeId);
  }
  ensurePostgresSchema();
  const validate = input.validate;
  const batchSize = input.batchSize ?? 500;
  const orgFilter = scopeOrgFilter(input.scope);
  let audited = 0;
  let quarantined = 0;
  let cursor: string | null = null;
  // Page the type's rows by id; validate each; quarantine failures.
  for (;;) {
    const page = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `SELECT o.id, o.org_id, o.data
FROM "${q()}"."objects" o
WHERE o.type = $1
  AND o.deleted_at IS NULL
  AND ($2::text IS NULL OR o.org_id = $2)
  AND ($3::text IS NULL OR o.id > $3)
ORDER BY o.id ASC
LIMIT $4`,
          values: [input.objectTypeId, orgFilter, cursor, batchSize],
        },
      ],
    });
    const rows = (page?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) break;
    for (const row of rows) {
      audited += 1;
      cursor = String(row.id);
      let ok = false;
      try {
        ok = validate(row.data);
      } catch {
        ok = false; // fail-closed: a validator throw ⇒ invalid ⇒ quarantine.
      }
      if (!ok) {
        quarantineObject({
          orgId: String(row.org_id),
          objectId: String(row.id),
          objectTypeId: input.objectTypeId,
          generation: input.generation ?? null,
          reason: "activation-audit:invalid-payload",
        });
        quarantined += 1;
      }
    }
    if (rows.length < batchSize) break;
  }
  return { audited, quarantined };
}

/**
 * NEW-write enforcement. When a type carries an active dedicated claim AND has a
 * registered validator, an invalid payload is REJECTED
 * (InvalidActivatedTypePayloadError). A type with no active claim, or no
 * registered validator, is not gated here (unclaimed/unvalidated types keep
 * substrate behavior). Pure — the caller supplies the DB-derived
 * `hasActiveClaim` and the registry-derived `validate`.
 */
export function assertActivatedTypePayloadValid(input: {
  objectTypeId: string;
  data: unknown;
  hasActiveClaim: boolean;
  validate: ((data: unknown) => boolean) | null;
  detail?: string;
}): void {
  if (!input.hasActiveClaim || input.validate == null) return;
  let ok = false;
  try {
    ok = input.validate(input.data);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new InvalidActivatedTypePayloadError(input.objectTypeId, input.detail);
  }
}

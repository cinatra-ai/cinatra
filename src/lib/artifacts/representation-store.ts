import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, ensurePostgresSchema, postgresSchema } from "@/lib/database";

// ---------------------------------------------------------------------------
// Representation binding (APPEND-ONLY).
//
// A `representation` binds a `resource` to an artifact at an immutable
// `revision`. One artifact ↔ many representations across time; one resource
// ↔ representations of many artifacts (multi-artifact attribution). Rows are
// physically append-only (a DB trigger forbids UPDATE/DELETE) — a change is a
// NEW revision row; the representation row id is the immutable replay pin.
// Revision is allocated under pg_advisory_xact_lock(hashtext(artifact_id))
// in the SAME tx as the insert to prevent unlocked MAX+1 races.
// ---------------------------------------------------------------------------

export type RepresentationForm = "file" | "connectorRef" | "dashboard";

export type RepresentationRecord = {
  id: string;
  orgId: string;
  artifactId: string;
  resourceId: string;
  revision: number;
  form: RepresentationForm;
  createdBy: string | null;
  createdByRunId: string | null;
  createdAt: string;
};

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

type Row = Record<string, unknown>;
const toRec = (r: Row): RepresentationRecord => ({
  id: String(r.id),
  orgId: String(r.org_id),
  artifactId: String(r.artifact_id),
  resourceId: String(r.resource_id),
  revision: Number(r.revision),
  form: r.form as RepresentationForm,
  createdBy: (r.created_by as string | null) ?? null,
  createdByRunId: (r.created_by_run_id as string | null) ?? null,
  createdAt: String(r.created_at),
});

/**
 * Append a new immutable representation revision. Revision = MAX+1 allocated
 * UNDER the per-artifact advisory lock in one tx (so concurrent appends
 * cannot collide on `(org,artifact,revision)` — the unique index is the
 * backstop, the lock prevents the lost-update/abort). Returns the pinned
 * record (its `id` is the replay pin).
 */
export function appendRepresentation(input: {
  orgId: string;
  artifactId: string;
  resourceId: string;
  form: RepresentationForm;
  createdBy?: string | null;
  createdByRunId?: string | null;
}): RepresentationRecord {
  ensurePostgresSchema();
  const id = randomUUID();
  const res = runPostgresQueriesSync({
    connectionString: conn(),
    transaction: true,
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
      {
        text: `INSERT INTO "${q()}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
SELECT $1,$2,$3,$4,
  COALESCE((SELECT MAX(revision) FROM "${q()}"."representation" WHERE org_id=$2 AND artifact_id=$3),0)+1,
  $5,$6,$7
RETURNING id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, created_at`,
        values: [
          id,
          input.orgId,
          input.artifactId,
          input.resourceId,
          input.form,
          input.createdBy ?? null,
          input.createdByRunId ?? null,
        ],
      },
    ],
  });
  const row = (res?.[1]?.rows?.[0] ?? {}) as Row;
  return toRec({
    id: row.id ?? id,
    org_id: row.org_id ?? input.orgId,
    artifact_id: row.artifact_id ?? input.artifactId,
    resource_id: row.resource_id ?? input.resourceId,
    revision: row.revision ?? 1,
    form: row.form ?? input.form,
    created_by: row.created_by ?? input.createdBy ?? null,
    created_by_run_id: row.created_by_run_id ?? input.createdByRunId ?? null,
    created_at: row.created_at ?? "",
  });
}

/** All representation revisions for an artifact, oldest→newest. */
export function listRepresentations(orgId: string, artifactId: string): RepresentationRecord[] {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, created_at
FROM "${q()}"."representation" WHERE org_id=$1 AND artifact_id=$2 ORDER BY revision ASC`,
        values: [orgId, artifactId],
      },
    ],
  });
  return ((r?.[0]?.rows ?? []) as Row[]).map(toRec);
}

/** Latest (highest-revision) representation, or null. */
export function getLatestRepresentation(orgId: string, artifactId: string): RepresentationRecord | null {
  const all = listRepresentations(orgId, artifactId);
  return all.length ? all[all.length - 1] : null;
}

/** Replay pin: a representation revision by id, regardless of how many newer revisions exist. */
export function getRepresentationByIdForReplay(orgId: string, id: string): RepresentationRecord | null {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, created_at
FROM "${q()}"."representation" WHERE org_id=$1 AND id=$2 LIMIT 1`,
        values: [orgId, id],
      },
    ],
  });
  const row = r?.[0]?.rows?.[0] as Row | undefined;
  return row ? toRec(row) : null;
}

/** Reverse query: every artifact a resource underlies (multi-artifact attribution). */
export function listArtifactsForResource(orgId: string, resourceId: string): string[] {
  ensurePostgresSchema();
  const r = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT DISTINCT artifact_id FROM "${q()}"."representation" WHERE org_id=$1 AND resource_id=$2`,
        values: [orgId, resourceId],
      },
    ],
  });
  return ((r?.[0]?.rows ?? []) as Row[]).map((x) => String(x.artifact_id));
}

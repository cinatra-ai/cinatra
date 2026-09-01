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

// ---------------------------------------------------------------------------
// THE COMPARE-AND-SET APPEND (cinatra#3030, epic #3023 W6; plan (C) item 0.30,
// technical notes §8.3).
//
//   §8.3: "the caller names the revision it read, and the append inserts the
//   next number under the unique index on organisation, artifact and revision
//   that the append-only `representation` table already carries — a save that
//   names a base another save has already built on fails on that index, which is
//   the compare-and-set; the append is one transaction with its ledger row and
//   produced event."
//
// So the primitive is NOT a new lock and NOT a new column: it is the existing
// `representation_artifact_rev_idx` (UNIQUE on org, artifact, revision) plus a
// revision that is DERIVED FROM THE NAMED BASE rather than from MAX+1.
// `appendRepresentation` above allocates MAX+1 under an advisory lock, which is
// the right primitive for a writer that has no base to name; a mid-run write
// DOES name one, and taking MAX+1 there would silently build on somebody else's
// revision — exactly the lost update the item forbids.
//
// TWO REFUSALS, TWO DISTINCT DATABASE ERRORS, no string sniffing of the happy
// path:
//   - the named base is not a revision of that artifact ⇒ the scalar subquery
//     yields NULL ⇒ `revision` (NOT NULL) is violated ⇒ 23502;
//   - the next revision is already taken ⇒ the unique index is violated ⇒ 23505.
// Both abort the transaction they ride in, so a refused append leaves no ledger
// row and no produced event behind.
//
// Returned as QUERIES rather than executed here: the append is "one transaction
// with its ledger row and produced event", and only the caller knows what else
// rides in it. `@/lib/artifacts/artifact-revision-append` composes them; W2's
// editor reuses this same builder rather than writing a second one.
// ---------------------------------------------------------------------------

/** The compare-and-set append, as queries for the caller's own transaction. */
export function buildRepresentationAppendWithBaseQueries(input: {
  /** The app schema, UNESCAPED (this builder quotes it). */
  schema: string;
  newRepresentationRevisionId: string;
  orgId: string;
  artifactId: string;
  resourceId: string;
  form: RepresentationForm;
  /** The revision the caller READ — the compare half of the compare-and-set. */
  baseRepresentationRevisionId: string;
  createdBy: string | null;
  createdByRunId: string | null;
}): Array<{ text: string; values: unknown[] }> {
  const s = input.schema.replaceAll('"', '""');
  return [
    {
      text: `INSERT INTO "${s}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
VALUES ($1::text, $2::text, $3::text, $4::text,
  (SELECT base.revision + 1 FROM "${s}"."representation" base
    WHERE base.id = $8::text AND base.org_id = $2::text AND base.artifact_id = $3::text),
  $5::text, $6::text, $7::text)`,
      values: [
        input.newRepresentationRevisionId,
        input.orgId,
        input.artifactId,
        input.resourceId,
        input.form,
        input.createdBy,
        input.createdByRunId,
        input.baseRepresentationRevisionId,
      ],
    },
  ];
}

function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** The named base is not a revision of that artifact in this organisation: the
 *  derived revision was NULL and the NOT NULL column refused it. */
export function isUnknownRepresentationBase(err: unknown): boolean {
  if (errorCode(err) === "23502") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes('null value in column "revision"');
}

/** Another save has already built on the named base: the next revision is taken
 *  and the unique index refused the append. THIS IS THE COMPARE-AND-SET. */
export function isStaleRepresentationBase(err: unknown): boolean {
  if (errorCode(err) === "23505") {
    const constraint = (err as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") {
      return constraint.includes("representation_artifact_rev_idx");
    }
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return message.includes("representation_artifact_rev_idx");
}

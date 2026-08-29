import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
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
// THE APPEND WITH AN EXPECTED BASE — the editor's and the mid-run revision's
// shared compare-and-set (enablers 0.20 and 0.30 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3026).
//
// THE PLAN, §8.3: "The editor's save and the mid-run revision (0.20, 0.30)
// share one rule: the caller NAMES THE REVISION IT READ, and the append inserts
// the next number under the unique index on organisation, artifact and revision
// that the append-only `representation` table already carries — a save that
// names a base another save has already built on FAILS ON THAT INDEX, WHICH IS
// THE COMPARE-AND-SET; the append is one transaction with its ledger row and
// produced event. THE STORE'S PRESENT ALLOCATION OF THE NEXT NUMBER WITHOUT A
// BASE IS NOT USED BY EITHER."
//
// So this is deliberately NOT `appendRepresentation` with an extra argument.
// That function allocates `MAX(revision) + 1` under the per-artifact advisory
// lock: it is a "put this next, whatever is there" write, which is exactly right
// for a producer that has just made something new and exactly wrong for an
// editor, which must never write over a revision it never saw. The two
// behaviours are two functions, and a caller picks the one whose promise it
// wants.
//
// THREE OUTCOMES, and no fourth:
//   `appended`    — the base was the artifact's latest; its number plus one was
//                   free; the row (and every op spliced with it) committed.
//   `stale`       — the base was not the latest, so the number after it was
//                   already taken. NOTHING is written: the transaction aborts
//                   whole, so a spliced ledger row can never survive the
//                   revision it describes.
//   `unknown-base`— no such revision on this artifact in this organization. The
//                   transaction aborts before any write, on the guard below.
//
// THE ADVISORY LOCK IS NOT THE COMPARE-AND-SET, and does not weaken it. The
// index alone is sufficient and is what makes the refusal true under any
// concurrency. The lock is taken first so that two saves on ONE artifact are
// DECIDED one after another rather than racing into a constraint violation on
// the hot path — the loser still loses, on its base, and still learns `stale`.
// (The host lock is one half of "saves in flight are serialised per editor"; the
// display's own queue is the other, and neither is sufficient alone: the queue
// cannot see another person's editor, and the lock cannot stop one editor from
// sending two change sets out of order.)
// ---------------------------------------------------------------------------

/** A transactional op to commit WITH the revision — the edit's ledger rows. */
export type RepresentationAppendOp = { text: string; values: unknown[] };

export type AppendWithExpectedBaseResult =
  | { kind: "appended"; record: RepresentationRecord }
  | { kind: "stale" }
  | { kind: "unknown-base" };

/** Postgres' own codes for the two refusals this function reads. */
const UNIQUE_VIOLATION = "23505";
const DIVISION_BY_ZERO = "22012";

/**
 * THE ONE INDEX THAT MEANS "STALE". The compare-and-set is that index and no
 * other: a unique violation raised by anything ELSE inside this transaction — a
 * spliced ledger row, a primary key — is a defect, and reading it as `stale`
 * would tell a person their document moved when it did not and send the editor
 * to reload a revision that never changed. Those are rethrown, and the save road
 * answers `failed`, which is the truth.
 */
const REVISION_UNIQUE_INDEX = "representation_artifact_rev_idx";

/** The constraint a unique violation names — from the driver, else its message. */
function violatedConstraint(error: unknown): string | null {
  if (error && typeof error === "object" && "constraint" in error) {
    const name = (error as { constraint?: unknown }).constraint;
    if (typeof name === "string" && name.length > 0) return name;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const named = /unique constraint "([^"]+)"/.exec(message);
  return named ? named[1] : null;
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  // The sync/async bridges re-throw with the message preserved; a driver that
  // loses the code must not turn a stale save into an unexplained failure.
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("duplicate key value")) return UNIQUE_VIOLATION;
  if (message.includes("division by zero")) return DIVISION_BY_ZERO;
  return null;
}

/**
 * Append the revision AFTER `baseRevisionId`, or refuse.
 *
 * ASYNCHRONOUS BY CHOICE: every caller (the save route, the materialize step)
 * has an `await` to give, so this runs on `@/lib/postgres-async` rather than
 * freezing the event loop on the synchronous bridge — the rule that module's
 * header states for every new call site.
 */
export async function appendRepresentationWithExpectedBase(input: {
  orgId: string;
  artifactId: string;
  /** The revision the caller READ — the expected base. */
  baseRevisionId: string;
  resourceId: string;
  form: RepresentationForm;
  createdBy?: string | null;
  createdByRunId?: string | null;
  /**
   * Ops to commit in the SAME transaction as the revision — the edit's ledger
   * rows. Called with the id of the revision about to be written, so a ledger
   * row can name it. They run AFTER the insert, so a refusal takes them with it.
   */
  additionalOps?: (representationRevisionId: string) => RepresentationAppendOp[];
}): Promise<AppendWithExpectedBaseResult> {
  ensurePostgresSchema();
  const id = randomUUID();
  const schema = q();

  try {
    const res = await runPostgresQueriesAsync({
      connectionString: conn(),
      transaction: true,
      queries: [
        // Decide one save at a time on this artifact (see the header — this is
        // ordering, not the compare-and-set).
        { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
        {
          // THE BASE MUST EXIST, on THIS artifact and in THIS organization, or
          // the whole transaction aborts here — before the insert and before any
          // spliced ledger row. `1 / COUNT(*)` is the guard: no such row makes
          // it a division by zero, which is an error Postgres raises and this
          // function reads as `unknown-base`. A caller-supplied base that names
          // another organization's revision therefore writes nothing and learns
          // nothing about that row's existence.
          text: `SELECT 1 / COUNT(*)::int AS base_present
FROM "${schema}"."representation"
WHERE org_id = $1 AND artifact_id = $2 AND id = $3`,
          values: [input.orgId, input.artifactId, input.baseRevisionId],
        },
        {
          // THE COMPARE-AND-SET. The number comes from the BASE ROW, never from
          // MAX(revision): if anything was appended after the base, this number
          // is already taken and the unique index refuses the insert — which is
          // precisely "a save that names a base another save has already built
          // on fails on that index".
          text: `INSERT INTO "${schema}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
SELECT $1, $2, $3, $4, base.revision + 1, $6, $7, $8
FROM "${schema}"."representation" base
WHERE base.org_id = $2 AND base.artifact_id = $3 AND base.id = $5
RETURNING id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, created_at`,
          values: [
            id,
            input.orgId,
            input.artifactId,
            input.resourceId,
            input.baseRevisionId,
            input.form,
            input.createdBy ?? null,
            input.createdByRunId ?? null,
          ],
        },
        ...(input.additionalOps?.(id) ?? []),
      ],
    });

    const row = (res?.[2]?.rows?.[0] ?? null) as Row | null;
    if (!row) {
      // Unreachable: the guard above already proved the base row exists, and the
      // table is append-only inside the transaction's snapshot. Refuse rather
      // than fabricate a record from the input.
      return { kind: "unknown-base" };
    }
    return { kind: "appended", record: toRec(row) };
  } catch (error) {
    const code = errorCode(error);
    if (code === UNIQUE_VIOLATION) {
      // A NAMED constraint that is not the revision index is not this function's
      // refusal to make. An UNNAMED one (a bridge that lost both the field and
      // the message) keeps the previous reading: the revision index is the only
      // unique index the insert above can violate.
      const constraint = violatedConstraint(error);
      if (constraint !== null && constraint !== REVISION_UNIQUE_INDEX) throw error;
      return { kind: "stale" };
    }
    if (code === DIVISION_BY_ZERO) return { kind: "unknown-base" };
    throw error;
  }
}

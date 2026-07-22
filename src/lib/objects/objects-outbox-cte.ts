import "server-only";

/**
 * The SHARED objects + graphiti_projection_outbox single-CTE builder
 * (cinatra#1894, epic #1883 §D7 / decomposition #1944 B1b — drift-control tier b).
 *
 * ONE place mints the `objects`-write → `graphiti_projection_outbox` CTE so the
 * cross-cutting substrate invariant is pinned in exactly one shape:
 *
 *   the outbox INSERT fires ONLY when the `objects` write actually happened.
 *
 * The outbox INSERT `SELECT … FROM upserted` reads the objects-write CTE's
 * RETURNING set, so a suppressed write (a cross-tenant collision on the plain
 * INSERT path, or a no-op ON-CONFLICT update whose change-gate WHERE evaluates
 * false) yields ZERO `upserted` rows ⇒ ZERO outbox rows — never a phantom
 * projector job.
 *
 * TWO consumers, ONE column set (`OBJECTS_WRITE_COLUMNS`):
 *   - `createSemanticArtifact` (src/lib/artifacts/artifact-creation.ts) — the
 *     artifact-creation path — uses mode `"insert"` (a fresh UUID, plain INSERT,
 *     `version` = 1). Behaviour is byte-for-byte the string this module inlines
 *     (extracted verbatim, pinned by the golden test).
 *   - the dashboards-artifact TWIN WRITER (src/lib/dashboards/…) — uses mode
 *     `"upsert"` so a dashboard mutation that already has a substrate row patches
 *     it in place (scope-axis + data), bumping `version`, and — per delta D3 —
 *     the graphiti outbox is emitted ONLY on a REAL objects-row change (a no-op
 *     update advances the twin's representation/audit but NOT the outbox).
 *
 * The `resource` / `representation` / `artifact_audit` writes are NOT part of
 * this builder — this is strictly the objects+outbox couple that both paths must
 * express identically. A parity/contract test (`objects-outbox-cte.test.ts`)
 * pins `OBJECTS_WRITE_COLUMNS` against the live objects-write column set so a
 * future canonical column-add the twin misses fails CI (drift-control tier c).
 *
 * PURE: builds and returns `{ text, values }`; it never executes. The
 * artifact path splices it into a `runPostgresQueriesSync({transaction:true})`
 * batch; the twin path splices it into the dashboards Drizzle tx via
 * `tx.execute(rawWithParams(text, values))`.
 */

/**
 * The ORDERED column set every objects write in the artifact/dashboard substrate
 * shares. Pinned by the parity/contract test against the live `objects` table so
 * a canonical column-add is a compile/CI signal, not a silent twin drift.
 */
export const OBJECTS_WRITE_COLUMNS = [
  "id",
  "type",
  "parent_id",
  "parent_type",
  "data",
  "created_by",
  "org_id",
  "source",
  "graphiti_sync_status",
  "version",
  "owner_level",
  "owner_id",
  "visibility",
  "project_id",
] as const;

/** Every column the `"upsert"` DO-UPDATE SET writes is compared by the change-gate
 *  (delta D3): a write that leaves ALL of these — AND does not resurrect a
 *  tombstoned row — unchanged is a no-op ⇒ no outbox. Covering the FULL set (not
 *  just the scope axis) is required so a change to ANY written column still emits
 *  the projection event (codex Q2: a partial gate could suppress a needed
 *  projection). `created_by`/`source`/`version`/`graphiti_sync_status`/`updated_at`
 *  are provenance/bookkeeping, not identity, and are intentionally NOT gated. */
export const OBJECTS_UPSERT_CHANGE_COLUMNS = [
  "data",
  "type",
  "parent_id",
  "parent_type",
  "org_id",
  "owner_level",
  "owner_id",
  "visibility",
  "project_id",
] as const;

export type ObjectsOutboxMode = "insert" | "upsert";

export interface ObjectsOutboxInput {
  /** `objects.id` — the artifact/dashboard id (also the outbox `object_id`). */
  readonly id: string;
  readonly type: string;
  readonly parentId?: string | null;
  readonly parentType?: string | null;
  /** PRE-SERIALIZED jsonb body — the caller passes `JSON.stringify(data)` so the
   *  bound value is a `text` the SQL casts `$n::jsonb`. */
  readonly dataJson: string;
  readonly createdBy: string | null;
  readonly orgId: string | null;
  /** Provenance tag: `'route'` on the artifact-creation path (byte-identical to
   *  the extracted string), the twin's own tag on the dashboards path. Inlined as
   *  a validated SQL literal (never a bound param) so the create-mode string is
   *  reproduced verbatim. */
  readonly source: string;
  readonly ownerLevel: string | null;
  readonly ownerId: string | null;
  readonly visibility: string | null;
  readonly projectId: string | null;
}

/** Inline a controlled provenance tag as a single-quoted SQL literal. The tag is
 *  a fixed internal constant (`'route'` / `'dashboards-twin'`); we still assert a
 *  conservative shape and escape embedded quotes so it can never be an injection
 *  vector even if a future caller passes an unexpected tag. */
function sourceLiteral(source: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(source)) {
    throw new Error(`objects-outbox-cte: invalid source tag "${source}"`);
  }
  return `'${source.replaceAll("'", "''")}'`;
}

/**
 * Build the objects-write + outbox single-CTE for one row.
 *
 * `"insert"` (artifact creation): plain `INSERT … RETURNING` — a PK collision
 * throws and rolls the caller's tx back (never a silent DO NOTHING that would
 * strand representation/audit rows). Reproduces the extracted create string
 * verbatim.
 *
 * `"upsert"` (twin): `INSERT … ON CONFLICT (id) DO UPDATE SET … WHERE <changed>
 * RETURNING` — a first mutation INSERTs (outbox fires), a scope/data change
 * UPDATEs (outbox fires), a no-op UPDATE is suppressed by the change-gate WHERE
 * (RETURNING empty ⇒ outbox suppressed, delta D3). A tombstoned row is
 * resurrected (`deleted_at → NULL`) and counts as a change.
 *
 * `$1..$11` bind: id, type, parent_id, parent_type, data(jsonb), created_by,
 * org_id, owner_level, owner_id, visibility, project_id. `source`,
 * `graphiti_sync_status`, `version` and the outbox `operation` are SQL literals.
 */
export function buildObjectsWithOutboxQuery(
  schemaName: string,
  mode: ObjectsOutboxMode,
  input: ObjectsOutboxInput,
): { text: string; values: unknown[] } {
  const schema = schemaName.replaceAll('"', '""');
  const src = sourceLiteral(input.source);

  const values: unknown[] = [
    input.id,
    input.type,
    input.parentId ?? null,
    input.parentType ?? null,
    input.dataJson,
    input.createdBy ?? null,
    input.orgId,
    input.ownerLevel,
    input.ownerId,
    input.visibility,
    input.projectId,
  ];

  if (mode === "insert") {
    // VERBATIM the extracted create string (cinatra#1894 tier-b extraction).
    // Byte-for-byte identical to the prior inline SQL — pinned by the golden
    // test — so the artifact-creation hot path is behaviour-preserving. The
    // ONLY interpolations are the escaped schema and the validated source
    // literal (which is `'route'` on this path).
    const text = `WITH upserted AS (
  INSERT INTO "${schema}"."objects"
    (id, type, parent_id, parent_type, data, created_by, org_id, source,
     graphiti_sync_status, version, owner_level, owner_id, visibility,
     project_id)
  VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text, $7::text, ${src},
          'pending', 1, $8::text, $9::text, $10::text,
          $11::text)
  RETURNING id, version, org_id
)
INSERT INTO "${schema}"."graphiti_projection_outbox"
  (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
SELECT gen_random_uuid()::text, upserted.id, upserted.version, upserted.org_id,
       'upsert', NULL, 'pending', 0
FROM upserted`;
    return { text, values };
  }

  // mode === "upsert" — the twin's gated create-or-patch.
  // Cross-tenant guard mirrors upsertObjectAndEnqueue (org match or either
  // NULL). The change-gate (delta D3) suppresses a no-op update so the outbox
  // fires ONLY on a real objects-row change; a tombstoned row is resurrected and
  // counts as a change. `version` bumps via the schema-qualified target-row
  // reference (the same reference form upsertObjectAndEnqueue uses).
  const text = `WITH upserted AS (
  INSERT INTO "${schema}"."objects"
    (id, type, parent_id, parent_type, data, created_by, org_id, source,
     graphiti_sync_status, version, owner_level, owner_id, visibility,
     project_id)
  VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text, $7::text, ${src},
          'pending', 1, $8::text, $9::text, $10::text,
          $11::text)
  ON CONFLICT (id) DO UPDATE SET
    type = EXCLUDED.type,
    parent_id = EXCLUDED.parent_id,
    parent_type = EXCLUDED.parent_type,
    data = EXCLUDED.data,
    created_by = COALESCE(EXCLUDED.created_by, "${schema}"."objects".created_by),
    org_id = EXCLUDED.org_id,
    source = EXCLUDED.source,
    graphiti_sync_status = 'pending',
    version = COALESCE("${schema}"."objects".version, 0) + 1,
    owner_level = EXCLUDED.owner_level,
    owner_id = EXCLUDED.owner_id,
    visibility = EXCLUDED.visibility,
    project_id = EXCLUDED.project_id,
    updated_at = now(),
    deleted_at = NULL
  WHERE ("${schema}"."objects".org_id = EXCLUDED.org_id
         OR "${schema}"."objects".org_id IS NULL
         OR EXCLUDED.org_id IS NULL)
    AND ("${schema}"."objects".data IS DISTINCT FROM EXCLUDED.data
         OR "${schema}"."objects".type IS DISTINCT FROM EXCLUDED.type
         OR "${schema}"."objects".parent_id IS DISTINCT FROM EXCLUDED.parent_id
         OR "${schema}"."objects".parent_type IS DISTINCT FROM EXCLUDED.parent_type
         OR "${schema}"."objects".org_id IS DISTINCT FROM EXCLUDED.org_id
         OR "${schema}"."objects".owner_level IS DISTINCT FROM EXCLUDED.owner_level
         OR "${schema}"."objects".owner_id IS DISTINCT FROM EXCLUDED.owner_id
         OR "${schema}"."objects".visibility IS DISTINCT FROM EXCLUDED.visibility
         OR "${schema}"."objects".project_id IS DISTINCT FROM EXCLUDED.project_id
         OR "${schema}"."objects".deleted_at IS NOT NULL)
  RETURNING id, version, org_id
)
INSERT INTO "${schema}"."graphiti_projection_outbox"
  (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
SELECT gen_random_uuid()::text, upserted.id, upserted.version, upserted.org_id,
       'upsert', NULL, 'pending', 0
FROM upserted`;
  return { text, values };
}

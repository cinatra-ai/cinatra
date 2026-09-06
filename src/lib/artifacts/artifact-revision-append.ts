import "server-only";

import { randomUUID } from "node:crypto";

import { getPostgresConnectionString, ensurePostgresSchema, postgresSchema } from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { buildArtifactWriterWitnessOp } from "./artifact-writer-witness";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import { deriveSubstanceKey } from "./resource-store";

// ---------------------------------------------------------------------------
// APPEND A NEW REVISION TO AN ARTIFACT THAT ALREADY EXISTS (cinatra#3080, fix
// leg 8).
//
// WHY THIS EXISTS. The `representation` table has always been append-only — "one
// artifact ↔ many representations across time … a change is a NEW revision row"
// — but the host had no writer that used it that way. Every producer reached for
// `createSemanticArtifact`, which mints a FRESH artifact id per write (the
// ref-swap contract the blog body materializer's own header records), so "a new
// revision of the work" and "a different piece of work" were the same call.
//
// That is the defect the ninth proof round photographed on the review floor.
// The ratified drawing (Agent run & review §VI): Regenerate "runs the same
// producing step again from the words in the note field, files a NEW REVISION OF
// THE SAME ARTIFACT, and settles this gate superseded beneath a successor over
// that same artifact". The round's rows read the opposite — gate `d6301eed`
// pinned artifact `90dbf854`, its successor `096296ae` pinned artifact
// `d8eca6bd`. Nothing joined the two, because nothing could say "the same
// artifact, one revision on".
//
// TWO DOORS, ONE WRITE.
//
//   `appendSemanticArtifactRevision` — new BYTES become the next revision of an
//   artifact the host already owns. The road a producer takes when it holds the
//   repaired content itself.
//
//   `refileRevisionOntoArtifact` — a revision that a producing RUN already wrote
//   under an artifact of its own is re-filed as the next revision of the
//   REVIEWED artifact. This is the road the real repair completion takes: a
//   generic producing step is dispatched, it writes its output the only way an
//   agent run can (a fresh artifact through the create road), and the completion
//   seam is where that output becomes the reviewed artifact's next revision
//   instead of a second, unrelated piece of work under a successor gate. It
//   binds the SAME `resource` row — the same substance, byte for byte, already
//   on disk — so nothing is copied and no second blob is written.
//
// THE BORDER THIS CROSSES, NAMED. The artifact-identity road is the HOST's (the
// core/extension border: the host owns the review floor, the gates, the change
// road and the display map). This writer is a host writer beside
// `createSemanticArtifact` and the two CMS capture writers, in the host's own
// `src/lib/artifacts` tree. It adds no package-name branch and knows nothing
// about which extension defines the type it appends to — it reads the type off
// the row it appends to and writes nothing about identity at all.
//
// WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT.
//
//   • It appends the `representation` row at MAX(revision)+1 under the
//     per-artifact advisory lock, moves the `objects.data` pointer onto the new
//     revision, and emits the artifact-writer provenance witness in the SAME
//     transaction — the same rows, in the same shapes, the CMS capture writer
//     already commits together (`buildCmsSnapshotCaptureQueries`). The bytes
//     door additionally upserts the org-scoped substance-keyed `resource` and
//     writes the `artifact_blobs` row when that resource is new.
//
//   • EVERY write is guarded on the target row's OWN LIVENESS (`deleted_at IS
//     NULL`), inside the transaction that holds the lock — not only on the read
//     before it. A tombstone that lands in the window leaves this call writing
//     nothing at all, and the refusal is raised from the empty result.
//
//   • It emits NO produced event. A revision filed by the change road is already
//     carried by that road: `submitRepairResponse` opens the successor gate
//     itself, over this exact revision. A produced event here would offer the
//     same revision to the review policy a second time, and "exactly two gates on
//     the lineage, no third gate" is a measured property of the round this leg
//     answers. Creation keeps its event; appending does not need one.
//
//   • It asserts NO semantic type. The artifact already carries its identity; a
//     revision does not re-declare what its artifact is.
//
//   • It never creates. An absent, cross-org or tombstoned artifact is refused
//     with the reason, and nothing is written — a caller that wanted a new
//     artifact must ask for one by name.
// ---------------------------------------------------------------------------

const APPEND_BLOB_MAX_DEFAULT_BYTES = 100 * 1024 * 1024; // the creation writer's own soft default

export type AppendArtifactRevisionInput = {
  orgId: string;
  /** The artifact to append to. It must already exist, in this org, un-tombstoned. */
  artifactId: string;
  /** The new bytes. */
  stream: AsyncIterable<Uint8Array>;
  /** The representation's IDENTITY mime (never the blob store's sniff). */
  declaredMime: string;
  /** Optional new title for the artifact envelope; absent leaves the title as it is. */
  title?: string;
  createdBy?: string | null;
  createdByRunId?: string | null;
  maxBytes?: number;
};

export type AppendArtifactRevisionResult = {
  /** THE SAME artifact id that was passed in — this writer never mints one. */
  artifactId: string;
  /** The new pin. */
  representationRevisionId: string;
  /** The append-only revision number this write allocated. */
  revision: number;
  sha256: string | null;
  sizeBytes: number;
  /** True when THIS SAME re-drive (the same producing run, the same substance)
   *  had already filed its revision onto this artifact and that revision was
   *  returned instead of a second one being appended. Byte-equal work from any
   *  OTHER run is a new revision, never a reuse — see the probe's own note. */
  reused: boolean;
};

export class ArtifactRevisionAppendRefusal extends Error {
  constructor(
    readonly code:
      | "artifact-absent"
      | "artifact-tombstoned"
      | "artifact-not-file-backed"
      | "source-absent"
      | "nothing-written",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRevisionAppendRefusal";
  }
}

type Row = Record<string, unknown>;

const schemaId = (): string => postgresSchema.replaceAll('"', '""');

/**
 * The target row, read before any blob I/O so a refusal costs nothing on disk.
 * Liveness is the row's OWN `deleted_at` column — `objects` soft-deletes, and
 * every reader is `WHERE deleted_at IS NULL`, so a tombstone check that read
 * only the JSON envelope would append a revision to a row nothing will serve.
 */
function readLiveArtifact(orgId: string, artifactId: string): void {
  const schema = schemaId();
  const existing = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, data, deleted_at FROM "${schema}"."objects" WHERE id=$1::text AND org_id=$2::text LIMIT 1`,
        values: [artifactId, orgId],
      },
    ],
  })?.[0]?.rows?.[0] as Row | undefined;
  if (!existing) {
    throw new ArtifactRevisionAppendRefusal(
      "artifact-absent",
      `artifact ${artifactId} is not an artifact of org ${orgId} — a revision is never appended to a row this org does not own`,
    );
  }
  if (existing.deleted_at) {
    throw new ArtifactRevisionAppendRefusal(
      "artifact-tombstoned",
      `artifact ${artifactId} is tombstoned — a repair against a dead target is refused`,
    );
  }
  const envelope = (typeof existing.data === "string"
    ? (JSON.parse(existing.data) as Record<string, unknown>)
    : ((existing.data as Record<string, unknown> | null) ?? {})) as Record<string, unknown>;
  if (envelope.artifactType !== undefined && envelope.artifactType !== "file") {
    throw new ArtifactRevisionAppendRefusal(
      "artifact-not-file-backed",
      `artifact ${artifactId} is "${String(envelope.artifactType)}"-backed — only a file-backed artifact takes an appended blob revision`,
    );
  }
}

/** The envelope patch every append writes onto the artifact's own row. */
function envelopePatch(input: {
  representationRevisionId: string;
  digest: string | null;
  mime: string;
  sizeBytes: number;
  title?: string;
}): string {
  return JSON.stringify({
    latestRepresentationRevisionId: input.representationRevisionId,
    ...(input.digest !== null ? { latestDigest: input.digest } : {}),
    mime: input.mime,
    size: input.sizeBytes,
    ...(input.title !== undefined ? { title: input.title } : {}),
  });
}

/**
 * Append a new immutable revision to an EXISTING artifact and move the
 * artifact's own pointer onto it. Returns the same artifact id and the fresh
 * revision pin — the pair a review gate is pinned on.
 */
export async function appendSemanticArtifactRevision(
  input: AppendArtifactRevisionInput,
): Promise<AppendArtifactRevisionResult> {
  ensurePostgresSchema();
  const schema = schemaId();
  const conn = getPostgresConnectionString();

  readLiveArtifact(input.orgId, input.artifactId);

  const representationRevisionId = randomUUID();
  const resourceId = randomUUID();

  const blobStore = createLocalDiskBlobStore();
  const blob = await blobStore.put({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId,
    stream: input.stream,
    declaredMime: input.declaredMime,
    maxBytes: input.maxBytes ?? APPEND_BLOB_MAX_DEFAULT_BYTES,
  });

  const substanceKey = deriveSubstanceKey({ kind: "blob", sha256: blob.sha256 });

  // ---------------------------------------------------------------------
  // ONE transaction: the advisory lock (the same lock the append-only
  // representation store takes, so a concurrent append cannot lose its MAX+1),
  // the resource/blob/representation write, the envelope pointer, and the
  // writer witness. EVERY statement is guarded on the target's liveness, so a
  // tombstone that lands in the window leaves nothing behind rather than half a
  // revision. The content-addressed blob file already on disk is the same orphan
  // class every pre-commit failure leaves, and the retention verifier is its
  // backstop.
  // ---------------------------------------------------------------------
  const live = `EXISTS (SELECT 1 FROM "${schema}"."objects" o WHERE o.id = $11::text AND o.org_id = $2::text AND o.deleted_at IS NULL)`;
  const results = runPostgresQueriesSync({
    connectionString: conn,
    transaction: true,
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.artifactId] },
      // THE TARGET ROW ITSELF, LOCKED (cinatra#3080, fix leg 8 — a convergence
      // finding). The transaction-scoped advisory lock above serialises
      // COOPERATING revision writers so a concurrent append cannot lose its
      // MAX(revision)+1; it does not serialise an ordinary tombstone, which
      // takes no such lock. Without this row lock a tombstone could commit
      // after the representation insert and before the guarded envelope update,
      // and the write would half-land: a representation and a witness on a row
      // nothing will ever serve, with the call returning success. `FOR UPDATE`
      // on the artifact's own row makes the tombstone WAIT behind this
      // transaction, so the liveness this statement reads holds for every
      // statement after it. An empty result IS the tombstone, and it is raised
      // as one below.
      {
        text: `SELECT id FROM "${schema}"."objects"
 WHERE id=$1::text AND org_id=$2::text AND deleted_at IS NULL
   FOR UPDATE`,
        values: [input.artifactId, input.orgId],
      },
      {
        text: `WITH resource_op AS (
  INSERT INTO "${schema}"."resource"
    (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
  SELECT $1::text, $2::text, 'blob', $3::text, $4::text, $5::bigint, $6::text,
         jsonb_build_object('storageKey', $7::text, 'blobId', $8::text)
  WHERE ${live}
  ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
  RETURNING id, (xmax = 0) AS is_new
),
blob_insert AS (
  INSERT INTO "${schema}"."artifact_blobs"
    (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
  SELECT $8::text, $2::text, 'local-disk', $7::text, $9::text, $5::bigint, $13::text, $6::text
  WHERE EXISTS (SELECT 1 FROM resource_op WHERE is_new)
  RETURNING id
),
rep_insert AS (
  INSERT INTO "${schema}"."representation"
    (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
  SELECT $10::text, $2::text, $11::text, (SELECT id FROM resource_op),
    COALESCE((SELECT MAX(revision) FROM "${schema}"."representation" WHERE org_id = $2 AND artifact_id = $11), 0) + 1,
    'file', $6::text, $12
  WHERE EXISTS (SELECT 1 FROM resource_op)
  RETURNING id, revision
)
SELECT (SELECT id FROM rep_insert) AS representation_revision_id,
       (SELECT revision FROM rep_insert) AS revision`,
        values: [
          resourceId, // $1
          input.orgId, // $2
          substanceKey, // $3
          // The representation's IDENTITY mime — the same rule the CMS capture
          // writer records: `resource.mime` is what every MIME-keyed consumer
          // reads, `artifact_blobs.mime_detected` ($13) is the provenance sniff.
          input.declaredMime, // $4
          blob.sizeBytes, // $5
          input.createdBy ?? null, // $6
          blob.storageKey, // $7
          blob.blobId, // $8
          blob.sha256, // $9
          representationRevisionId, // $10
          input.artifactId, // $11
          input.createdByRunId ?? null, // $12
          blob.mimeDetected, // $13
        ],
      },
      {
        text: `UPDATE "${schema}"."objects"
   SET data = data || $1::jsonb,
       version = COALESCE(version, 0) + 1,
       graphiti_sync_status = 'pending',
       updated_at = now()
 WHERE id = $2::text AND org_id = $3::text AND deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM "${schema}"."representation" r WHERE r.id = $4::text)`,
        values: [
          envelopePatch({
            representationRevisionId,
            digest: blob.sha256,
            mime: input.declaredMime,
            sizeBytes: blob.sizeBytes,
            title: input.title,
          }),
          input.artifactId,
          input.orgId,
          representationRevisionId,
        ],
      },
      projectionGuardedOnItsRepresentation(schema, {
        orgId: input.orgId,
        artifactId: input.artifactId,
        representationRevisionId,
      }),
      witnessGuardedOnItsRepresentation(schema, {
        orgId: input.orgId,
        artifactId: input.artifactId,
        representationRevisionId,
        actor: input.createdBy ?? null,
        detail: {
          mime: input.declaredMime,
          size: blob.sizeBytes,
          writer: "appendSemanticArtifactRevision",
        },
      }),
    ],
  });

  if (!(results?.[1]?.rows?.[0] as Row | undefined)?.id) {
    throw new ArtifactRevisionAppendRefusal(
      "artifact-tombstoned",
      `artifact ${input.artifactId} was tombstoned before its revision could be appended — nothing was written`,
    );
  }
  const row = (results?.[2]?.rows?.[0] ?? {}) as Row;
  if (!row.representation_revision_id) {
    throw new ArtifactRevisionAppendRefusal(
      "nothing-written",
      `artifact ${input.artifactId} stopped being live while its revision was being appended — nothing was written`,
    );
  }
  return {
    artifactId: input.artifactId,
    representationRevisionId: String(row.representation_revision_id),
    revision: Number(row.revision ?? 0),
    sha256: blob.sha256,
    sizeBytes: blob.sizeBytes,
    reused: false,
  };
}

export type RefileRevisionInput = {
  orgId: string;
  /** The artifact the review pinned — the one that gets the new revision. */
  targetArtifactId: string;
  /** The artifact the producing run wrote its answer under. */
  sourceArtifactId: string;
  /** The revision of that artifact carrying the answer. */
  sourceRepresentationRevisionId: string;
  createdBy?: string | null;
  createdByRunId?: string | null;
};

/**
 * Re-file a revision a producing run already wrote as the NEXT REVISION of the
 * artifact under review. Binds the SAME `resource` row — the same substance,
 * already on disk — so nothing is copied and no second blob is written; only the
 * append-only `representation` row and the artifact's own pointer are new.
 *
 * IDEMPOTENT ON THE RE-DRIVE, NOT ON THE SUBSTANCE. A re-drive of the SAME
 * producing run (a lost response, a re-queued drain) returns the revision it
 * already filed instead of a second one. Byte-identical work from a DIFFERENT
 * run is a new revision, because the drawing gives Regenerate a new revision
 * unconditionally and a deterministic producer that answers with the reviewed
 * bytes must still be able to settle its gate — see the probe's own note.
 */
export function refileRevisionOntoArtifact(
  input: RefileRevisionInput,
): AppendArtifactRevisionResult {
  ensurePostgresSchema();
  const schema = schemaId();
  const conn = getPostgresConnectionString();

  readLiveArtifact(input.orgId, input.targetArtifactId);

  // The source revision, and the substance it binds. Read under the org so a
  // revision of another tenant can never be re-filed onto this one's artifact.
  const source = runPostgresQueriesSync({
    connectionString: conn,
    queries: [
      {
        text: `SELECT r.id, r.resource_id, res.mime, res.size_bytes
  FROM "${schema}"."representation" r
  JOIN "${schema}"."resource" res ON res.id = r.resource_id AND res.org_id = r.org_id
 WHERE r.id = $1::text AND r.org_id = $2::text AND r.artifact_id = $3::text
 LIMIT 1`,
        values: [
          input.sourceRepresentationRevisionId,
          input.orgId,
          input.sourceArtifactId,
        ],
      },
    ],
  })?.[0]?.rows?.[0] as Row | undefined;
  if (!source) {
    throw new ArtifactRevisionAppendRefusal(
      "source-absent",
      `revision ${input.sourceRepresentationRevisionId} is not a revision of artifact ${input.sourceArtifactId} in org ${input.orgId} — nothing to re-file`,
    );
  }
  const resourceId = String(source.resource_id);
  const mime = String(source.mime);
  const sizeBytes = Number(source.size_bytes ?? 0);

  const representationRevisionId = randomUUID();
  const results = runPostgresQueriesSync({
    connectionString: conn,
    transaction: true,
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [input.targetArtifactId] },
      // THE TARGET ROW ITSELF, LOCKED (cinatra#3080, fix leg 8 — a convergence
      // finding). The transaction-scoped advisory lock above serialises
      // COOPERATING revision writers so a concurrent append cannot lose its
      // MAX(revision)+1; it does not serialise an ordinary tombstone, which
      // takes no such lock. Without this row lock a tombstone could commit
      // after the representation insert and before the guarded envelope update,
      // and the write would half-land: a representation and a witness on a row
      // nothing will ever serve, with the call returning success. `FOR UPDATE`
      // on the artifact's own row makes the tombstone WAIT behind this
      // transaction, so the liveness this statement reads holds for every
      // statement after it. An empty result IS the tombstone, and it is raised
      // as one below.
      {
        text: `SELECT id FROM "${schema}"."objects"
 WHERE id=$1::text AND org_id=$2::text AND deleted_at IS NULL
   FOR UPDATE`,
        values: [input.targetArtifactId, input.orgId],
      },
      // ALREADY FILED BY THIS SAME RE-DRIVE? (cinatra#3080, fix leg 8 — a
      // convergence finding, and the correction of this door's first shape.)
      //
      // The re-drive this idempotence exists for is ONE repair attempt driven
      // twice: a lost response, a re-queued drain. Its mark is the producing
      // RUN — `created_by_run_id` — not the substance.
      //
      // Keying it on the substance alone was wrong, and wrong in the one way
      // that matters most here. A regeneration is free to produce bytes
      // IDENTICAL to the revision under review — the same step, the same note,
      // a deterministic producer — and identical bytes resolve, through the
      // org-scoped substance key, to the very same `resource` row the reviewed
      // revision binds. A substance-keyed probe would then hand back THE BASE
      // REVISION ITSELF as the successor, `validateRepairLineage` would refuse
      // it `successor-equals-base`, and the repair would never complete: every
      // later drain re-files nothing and is refused again, for good. Byte-equal
      // work matching some OLDER revision is the same trap one step along — the
      // successor would pin a historical revision rather than a new one.
      //
      // The drawing is unconditional: Regenerate "files a NEW REVISION of the
      // same artifact". So a re-drive of the same run reuses; anything else
      // appends. A caller that names no run gets no dedup at all, because
      // nothing identifies its attempt.
      {
        text: `SELECT id, revision FROM "${schema}"."representation"
 WHERE org_id=$1::text AND artifact_id=$2::text AND resource_id=$3::text
   AND $4::text IS NOT NULL AND created_by_run_id = $4::text
 ORDER BY revision DESC LIMIT 1`,
        values: [input.orgId, input.targetArtifactId, resourceId, input.createdByRunId ?? null],
      },
      {
        text: `INSERT INTO "${schema}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
SELECT $1::text, $2::text, $3::text, $4::text,
  COALESCE((SELECT MAX(revision) FROM "${schema}"."representation" WHERE org_id=$2 AND artifact_id=$3), 0) + 1,
  'file', $5::text, $6
 WHERE EXISTS (SELECT 1 FROM "${schema}"."objects" o WHERE o.id=$3::text AND o.org_id=$2::text AND o.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "${schema}"."representation" r WHERE r.org_id=$2::text AND r.artifact_id=$3::text AND r.resource_id=$4::text AND $6::text IS NOT NULL AND r.created_by_run_id = $6::text)
RETURNING id, revision`,
        values: [
          representationRevisionId,
          input.orgId,
          input.targetArtifactId,
          resourceId,
          input.createdBy ?? null,
          input.createdByRunId ?? null,
        ],
      },
      {
        text: `UPDATE "${schema}"."objects"
   SET data = data || $1::jsonb,
       version = COALESCE(version, 0) + 1,
       graphiti_sync_status = 'pending',
       updated_at = now()
 WHERE id = $2::text AND org_id = $3::text AND deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM "${schema}"."representation" r WHERE r.id = $4::text)`,
        values: [
          envelopePatch({
            representationRevisionId,
            digest: null,
            mime,
            sizeBytes,
          }),
          input.targetArtifactId,
          input.orgId,
          representationRevisionId,
        ],
      },
      projectionGuardedOnItsRepresentation(schema, {
        orgId: input.orgId,
        artifactId: input.targetArtifactId,
        representationRevisionId,
      }),
      witnessGuardedOnItsRepresentation(schema, {
        orgId: input.orgId,
        artifactId: input.targetArtifactId,
        representationRevisionId,
        actor: input.createdBy ?? null,
        detail: {
          mime,
          size: sizeBytes,
          writer: "refileRevisionOntoArtifact",
          refiledFrom: input.sourceArtifactId,
        },
      }),
    ],
  });

  if (!(results?.[1]?.rows?.[0] as Row | undefined)?.id) {
    throw new ArtifactRevisionAppendRefusal(
      "artifact-tombstoned",
      `artifact ${input.targetArtifactId} was tombstoned before the producing run's revision could be re-filed onto it — nothing was written`,
    );
  }
  const already = (results?.[2]?.rows?.[0] ?? null) as Row | null;
  const inserted = (results?.[3]?.rows?.[0] ?? null) as Row | null;
  if (inserted?.id) {
    return {
      artifactId: input.targetArtifactId,
      representationRevisionId: String(inserted.id),
      revision: Number(inserted.revision ?? 0),
      sha256: null,
      sizeBytes,
      reused: false,
    };
  }
  if (already?.id) {
    return {
      artifactId: input.targetArtifactId,
      representationRevisionId: String(already.id),
      revision: Number(already.revision ?? 0),
      sha256: null,
      sizeBytes,
      reused: true,
    };
  }
  throw new ArtifactRevisionAppendRefusal(
    "nothing-written",
    `artifact ${input.targetArtifactId} stopped being live while the producing run's revision was being re-filed onto it — nothing was written`,
  );
}

/**
 * The shared writer witness, guarded on the representation it vouches for. The
 * witness is the one op in these lists that cannot be expressed as a guarded
 * SELECT by the shared builder (it takes its values from the caller), so it is
 * wrapped rather than re-implemented: the row lands only where the representation
 * it names actually landed, which is the invariant the builder's own header
 * states — "a witness that can commit without its representation (or vice versa)
 * is not a witness".
 */
/**
 * The PROJECTION ENQUEUE for the envelope this writer just patched — guarded on
 * the same representation the patch is guarded on, so it fires exactly when the
 * patch fired and never when the CTE above inserted nothing.
 *
 * The envelope patch beside it is a real change to an application-visible
 * `objects` row: the artifact now points at a new representation revision. A row
 * that changes without bumping `version` and without an outbox row is a row the
 * graph projection never hears about, so the projected view keeps serving the
 * SUPERSEDED revision while the table serves the new one — a drift no reader can
 * see and no test would catch. This keeps the writer in the same class as the
 * artifact stores beside it, artifact-creation.ts and its siblings: one
 * transaction that carries its own version bump and its own
 * `graphiti_projection_outbox` row, which is the condition the objects-writer
 * drift gate names for a writer that is not yet routed through the canonical
 * history-aware writer.
 */
function projectionGuardedOnItsRepresentation(
  schema: string,
  facts: { orgId: string; artifactId: string; representationRevisionId: string },
): { text: string; values: unknown[] } {
  return {
    text: `INSERT INTO "${schema}"."graphiti_projection_outbox"
  (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
SELECT gen_random_uuid()::text, o.id, o.version, o.org_id, 'upsert', NULL, 'pending', 0
  FROM "${schema}"."objects" o
 WHERE o.id = $1::text AND o.org_id = $2::text AND o.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM "${schema}"."representation" r WHERE r.id = $3::text)`,
    values: [facts.artifactId, facts.orgId, facts.representationRevisionId],
  };
}

function witnessGuardedOnItsRepresentation(
  schema: string,
  facts: Parameters<typeof buildArtifactWriterWitnessOp>[1],
): { text: string; values: unknown[] } {
  const op = buildArtifactWriterWitnessOp(schema, facts);
  const values = [...op.values];
  const guardParam = `$${values.length + 1}`;
  values.push(facts.representationRevisionId);
  const shape = /^INSERT INTO ([\s\S]*?)\n  \(([\s\S]*?)\)\nVALUES \(([\s\S]*)\)$/.exec(op.text);
  if (!shape) {
    // FAIL LOUD rather than fall back to the unguarded VALUES form: an
    // unguarded witness is exactly the row this wrapper exists to prevent.
    throw new Error(
      "[artifact-revision-append] the writer-witness op no longer has the shape this guard rewrites — update the wrapper rather than writing an unguarded witness",
    );
  }
  return {
    text: `INSERT INTO ${shape[1]}\n  (${shape[2]})\nSELECT ${shape[3]}\n WHERE EXISTS (SELECT 1 FROM "${schema}"."representation" r WHERE r.id = ${guardParam}::text)`,
    values,
  };
}

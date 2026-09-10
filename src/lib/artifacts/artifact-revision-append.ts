import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

// THE SAME-ARTIFACT REVISION (cinatra#3030, epic #3023 W6; plan (C) item 0.30,
// technical notes §8.1 and §8.3).
//
//   item 0.30: "Same-artifact revision through the materialize step: a mid-run
//   write may name an existing artifact and append its next revision instead of
//   creating a new one — a compare-and-set against the revision the caller read,
//   the same ledger row and produced event — so an agent can place its pictures
//   into a draft another agent wrote. The append's produced event carries the
//   live-generator origin, which the review policy maps to intermediate and
//   skips by default; because an organisation-required review or a per-run
//   elevation can still fire it, the caller's own declared gate is recorded as
//   the review of those revisions [...] a satisfaction rule keyed on the
//   artifact revision and the run."
//
//   §8.3: "the caller names the revision it read, and the append inserts the
//   next number under the unique index on organisation, artifact and revision
//   that the append-only `representation` table already carries — a save that
//   names a base another save has already built on fails on that index, which is
//   the compare-and-set; the append is one transaction with its ledger row and
//   produced event."
//
// THE COMPARE-AND-SET IS NOT RE-IMPLEMENTED HERE. W2 already shipped it, on the
// store, as `appendRepresentationWithExpectedBase` (cinatra#3028's editor save
// road): the revision number is derived from the NAMED BASE inside the insert,
// so the table's own unique index on (organisation, artifact, revision) IS the
// compare-and-set. A second mechanism beside it would be a second answer to
// "which write won", so this module CALLS it and splices everything else —
// the objects projection, the writer witness, the ledger finalize, the produced
// event and the satisfaction row — through its `additionalOps` seam. A lost
// compare-and-set aborts that whole transaction, so a refused append leaves no
// ledger row and no produced event behind.

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { maybeBuildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";

import { buildArtifactWriterWitnessOp } from "./artifact-writer-witness";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import {
  buildFinalizeMaterializationQuery,
  buildImageGenerationProvenanceQuery,
  claimMaterialization,
  type ImageGenerationProvenance,
} from "./materialization-ledger";
import { appendRepresentationWithExpectedBase } from "./representation-store";
import { deriveSubstanceKey } from "./resource-store";
import { mimeAcceptedByAccepts } from "./upload-artifact-type-map";

/** The creation path's soft default, mirrored: one revision is one artifact's
 *  worth of bytes. */
const APPEND_BLOB_MAX_BYTES = 100 * 1024 * 1024;

/** The table the satisfaction rule keys on — one revision names exactly one
 *  satisfying gate (item 0.30). */
export const REVISION_GATE_SATISFACTION_TABLE = "artifact_revision_review_satisfaction";

export type ArtifactRevisionAppendRefusal =
  | "artifact_not_found"
  | "unknown_base"
  | "stale_base"
  | "accepts_mismatch"
  | "type_mismatch"
  | "ledger_conflict";

/**
 * THE APPEND'S OWN LEDGER IDENTITY (convergence round, cinatra#3030).
 *
 * The materialization ledger's key is (run, output_id, extension, content_hash)
 * and EXCLUDES the path and the target artifact. The calling node's id alone —
 * what the create path uses — therefore makes "this node wrote these bytes"
 * the whole identity: one node appending the same bytes to two artifacts, or
 * appending bytes it earlier created an artifact from, would read the FIRST
 * write's refs back as a finalized hit and never revise the second artifact.
 * An append is identified by what it actually is: this node, appending onto
 * THAT base of THAT artifact.
 */
export function appendLedgerOutputId(input: {
  nodeId: string;
  artifactId: string;
  baseRepresentationRevisionId: string;
}): string {
  return `${input.nodeId}#append:${input.artifactId}@${input.baseRepresentationRevisionId}`;
}

export type ArtifactRevisionAppendResult =
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      revision: number;
      /** true when this exact node already appended these exact bytes. */
      deduped: boolean;
    }
  | { ok: false; reason: ArtifactRevisionAppendRefusal; error: string };

function schemaId(): string {
  return postgresSchema.replaceAll('"', '""');
}

async function sql(text: string, values: unknown[]): Promise<Record<string, unknown> | null> {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return (res?.rows?.[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Append the next revision of an existing artifact.
 *
 * `baseRepresentationRevisionId` is the revision the caller READ. Two mid-run
 * writes that both read revision N race on the unique index: the first lands
 * N+1, the second is refused with `stale_base` — the compare-and-set.
 */
export async function appendArtifactRevision(input: {
  orgId: string;
  runId: string;
  /** The calling node's id — the ledger identity, exactly as the materialize
   *  tool's create path uses it. */
  nodeId: string;
  artifactId: string;
  baseRepresentationRevisionId: string;
  /**
   * The revision's bytes.
   *
   * A `string` is the text road this module shipped with and is encoded UTF-8.
   * A `Uint8Array` is the road a PICTURE takes (plan (C) item 0.28,
   * cinatra#3032): image bytes are not text, and encoding them as UTF-8 would
   * not append the picture that was generated — it would append a mangling of
   * it. Both roads hash and stream the SAME bytes they write, so the ledger's
   * content hash still identifies exactly what landed.
   */
  content: string | Uint8Array;
  mime: string;
  createdBy: string | null;
  /** The extension the write is scoped to — the ledger row's own column. */
  extension: string;
  /**
   * The object type the CALLER's own authorization resolved for `extension`
   * (convergence round, cinatra#3030). The append is refused when the named
   * artifact is not of that type: without it a caller authorized to write one
   * extension could revise an artifact belonging to another.
   */
  expectedObjectTypeId?: string | null;
  extensionVersion?: string | null;
  /**
   * The review task id of the gate THIS RUN declared. Recorded as the review of
   * the appended revision, so the produced-output road resolves to that gate
   * instead of opening a second one (item 0.30).
   */
  declaredReviewTaskId?: string | null;
  /**
   * What produced THIS revision, when a picture produced it (item 0.28: "the
   * prompt, the provider and the model on the ledger row of that write"). It is
   * written into the SAME transaction as the ledger finalize, so a finalized
   * row can never be missing the provenance of the write that finalized it.
   */
  imageProvenance?: ImageGenerationProvenance | null;
}): Promise<ArtifactRevisionAppendResult> {
  ensurePostgresSchema();
  const schema = schemaId();

  // ------------------------------------------------------------------
  // The artifact, its declared type and the base revision — read BEFORE any
  // byte is written, so a refusal costs nothing.
  // ------------------------------------------------------------------
  const objectRow = await sql(
    `SELECT type FROM "${schema}"."objects" WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [input.artifactId, input.orgId],
  );
  if (!objectRow || typeof objectRow.type !== "string") {
    return {
      ok: false,
      reason: "artifact_not_found",
      error: `artifact ${input.artifactId} does not exist in this organisation`,
    };
  }
  const objectType = String(objectRow.type);
  if (
    typeof input.expectedObjectTypeId === "string" &&
    input.expectedObjectTypeId.length > 0 &&
    input.expectedObjectTypeId !== objectType
  ) {
    return {
      ok: false,
      reason: "type_mismatch",
      error:
        `artifact ${input.artifactId} is of type "${objectType}"; the call is authorized for ` +
        `"${input.expectedObjectTypeId}" — an append may not cross a declared type`,
    };
  }
  registerAllObjectTypes();
  const def = objectTypeRegistry.resolve(objectType);
  const accepts = def?.isArtifact?.accepts?.file?.mimeTypes;
  if (Array.isArray(accepts) && accepts.length > 0 && !mimeAcceptedByAccepts(accepts, input.mime)) {
    return {
      ok: false,
      reason: "accepts_mismatch",
      error:
        `object type "${objectType}" accepts [${accepts.join(", ")}]; the append declared ` +
        `"${input.mime}"`,
    };
  }
  const baseRow = await sql(
    `SELECT revision FROM "${schema}"."representation"
      WHERE id = $1 AND org_id = $2 AND artifact_id = $3 LIMIT 1`,
    [input.baseRepresentationRevisionId, input.orgId, input.artifactId],
  );
  if (!baseRow) {
    return {
      ok: false,
      reason: "unknown_base",
      error:
        `representation revision ${input.baseRepresentationRevisionId} is not a revision of ` +
        `artifact ${input.artifactId} in this organisation`,
    };
  }
  const baseRevision = Number(baseRow.revision);

  // ------------------------------------------------------------------
  // The ledger claim: the same idempotency ledger the create path uses, so a
  // re-drive of the same node with the same bytes returns the finalized refs
  // instead of appending a second revision.
  // ------------------------------------------------------------------
  // The bytes exactly as they will be written — text encoded UTF-8, a picture
  // untouched — so the ledger's content hash names what actually lands.
  const contentBytes =
    typeof input.content === "string"
      ? Buffer.from(input.content, "utf8")
      : Buffer.from(input.content);
  const contentHash = createHash("sha256").update(contentBytes).digest("hex");
  const ledgerOutputId = appendLedgerOutputId({
    nodeId: input.nodeId,
    artifactId: input.artifactId,
    baseRepresentationRevisionId: input.baseRepresentationRevisionId,
  });
  const claim = await claimMaterialization({
    orgId: input.orgId,
    runId: input.runId,
    outputId: ledgerOutputId,
    nodeId: input.nodeId,
    path: "materialize_tool",
    extension: input.extension,
    contentHash,
  });
  if (claim.kind === "finalized") {
    // The identity above is append-scoped, so a finalized hit is THIS append.
    // The two facts the key still does not carry — the row's path and the
    // artifact it produced — are verified rather than assumed: a foreign row is
    // a stated refusal, never someone else's refs handed back as success.
    if (claim.path !== "materialize_tool" || claim.artifactId !== input.artifactId) {
      return {
        ok: false,
        reason: "ledger_conflict",
        error:
          "the materialization ledger already carries a different write under this append's " +
          "identity — refusing to report another write's revision as this one's",
      };
    }
    const revRow = await sql(
      `SELECT revision FROM "${schema}"."representation" WHERE id = $1 AND org_id = $2`,
      [claim.representationRevisionId, input.orgId],
    );
    return {
      ok: true,
      artifactId: claim.artifactId,
      representationRevisionId: claim.representationRevisionId,
      revision: Number(revRow?.revision ?? 0),
      deduped: true,
    };
  }
  if (typeof claim.path === "string" && claim.path !== "materialize_tool") {
    // A RE-USED unfinalized row of a different path (cinatra#1893 Q3): the
    // 4-part key excludes `path`, so finalizing it would file this append under
    // another intent's row.
    return {
      ok: false,
      reason: "ledger_conflict",
      error:
        `the materialization ledger holds an unfinalized "${claim.path}" claim under this ` +
        "append's identity — refusing to finalize a foreign claim",
    };
  }

  // ------------------------------------------------------------------
  // The bytes, then the content-addressed resource — the store's own road.
  // ------------------------------------------------------------------
  const blobStore = createLocalDiskBlobStore();
  const newBlob = await blobStore.put({
    orgId: input.orgId,
    artifactId: input.artifactId,
    // Naming input for the store's legacy key scope only — a content-addressed
    // write keys off the digest, so this never becomes the row's identity.
    representationRevisionId: randomUUID(),
    stream: Readable.from([contentBytes]),
    declaredMime: input.mime,
    // The same soft default the creation path takes; an appended revision is not
    // a different class of bytes from a first one.
    maxBytes: APPEND_BLOB_MAX_BYTES,
  });
  const discardBlob = () =>
    blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => undefined);

  /**
   * A REFUSAL LEAVES NOTHING BEHIND — including the claim.
   *
   * The ledger claim is taken before the bytes are written, in its own
   * statement, so it cannot ride the append's transaction and roll back with
   * it. A refused append is final for THESE bytes on THAT base, so the
   * still-`claimed` row is released rather than left as a crashed-drive stub:
   * an unfinalized row that no drive will ever finish is a record of nothing.
   * Guarded on `phase = 'claimed'`, so a row a concurrent drive has already
   * finalized is never touched.
   */
  const releaseClaim = async () => {
    await sql(
      `DELETE FROM "${schema}"."artifact_materializations"
        WHERE id = $1 AND org_id = $2 AND phase = 'claimed'`,
      [claim.ledgerId, input.orgId],
    ).catch(() => null);
  };

  if (
    Array.isArray(accepts) &&
    accepts.length > 0 &&
    !mimeAcceptedByAccepts(accepts, newBlob.mimeDetected)
  ) {
    await discardBlob();
    await releaseClaim();
    return {
      ok: false,
      reason: "accepts_mismatch",
      error:
        `detected form "${newBlob.mimeDetected}" is not accepted by "${objectType}" ` +
        `(accepts [${accepts.join(", ")}])`,
    };
  }

  let resourceId: string;
  let resourceIsNew = false;
  try {
    const row = await sql(
      `WITH resource_op AS (
  INSERT INTO "${schema}"."resource"
    (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
  VALUES ($1::text, $2::text, 'blob', $3::text, $4::text, $5::bigint, $6::text,
          jsonb_build_object('storageKey', $8::text, 'blobId', $7::text))
  ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
  RETURNING id, metadata, (xmax = 0) AS is_new
),
blob_insert AS (
  INSERT INTO "${schema}"."artifact_blobs"
    (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
  SELECT $7::text, $2::text, 'local-disk', $8::text, $9::text, $5::bigint, $4::text, $6::text
  WHERE EXISTS (SELECT 1 FROM resource_op WHERE is_new)
  RETURNING id
)
SELECT r.id AS resource_id, r.is_new AS is_new, r.metadata->>'storageKey' AS storage_key
  FROM resource_op r`,
      [
        randomUUID(),
        input.orgId,
        deriveSubstanceKey({ kind: "blob", sha256: newBlob.sha256 }),
        newBlob.mimeDetected,
        newBlob.sizeBytes,
        input.createdBy ?? null,
        newBlob.blobId,
        newBlob.storageKey,
        newBlob.sha256,
      ],
    );
    if (!row || typeof row.storage_key !== "string" || row.storage_key.length === 0) {
      throw new Error(
        "the content-addressed resource has no storage binding — refusing to bind a new revision to it",
      );
    }
    resourceId = String(row.resource_id);
    resourceIsNew = row.is_new === true;
  } catch (err) {
    await discardBlob();
    throw err;
  }

  /**
   * A REFUSAL LEAVES NO BYTES AND NO ROWS (convergence round, cinatra#3030).
   *
   * The content-addressed resource and its blob row commit BEFORE the append's
   * transaction, so a refusal after them would leave a resource no
   * representation points at and bytes the reachability-guarded delete then
   * declines to remove. Only a resource THIS call created is reclaimed, and
   * only while nothing references it — both guards live inside the statements,
   * so a concurrent write that binds the same content is never disturbed.
   */
  const discardStaged = async () => {
    if (resourceIsNew) {
      await sql(
        `DELETE FROM "${schema}"."resource"
          WHERE id = $1 AND org_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM "${schema}"."representation"
               WHERE org_id = $2 AND resource_id = $1)`,
        [resourceId, input.orgId],
      ).catch(() => null);
      await sql(
        `DELETE FROM "${schema}"."artifact_blobs"
          WHERE id = $1 AND org_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM "${schema}"."resource"
               WHERE org_id = $2 AND metadata->>'blobId' = $1)`,
        [newBlob.blobId, input.orgId],
      ).catch(() => null);
    }
    await discardBlob();
  };

  // ------------------------------------------------------------------
  // ONE TRANSACTION, W2's compare-and-set at its head: the append, the objects
  // projection, the writer witness, the ledger finalize, the produced event and
  // the satisfaction row. A lost compare-and-set aborts all of it.
  // ------------------------------------------------------------------
  let result;
  try {
    result = await appendRepresentationWithExpectedBase({
      orgId: input.orgId,
      artifactId: input.artifactId,
      baseRevisionId: input.baseRepresentationRevisionId,
      resourceId,
      form: "file",
      createdBy: input.createdBy,
      createdByRunId: input.runId,
      additionalOps: (representationRevisionId) => {
        const producedEventOp = maybeBuildProducedEventInsertOp(schema, {
          orgId: input.orgId,
          artifactId: input.artifactId,
          representationRevisionId,
          emitter: "artifact_revision_append",
          // "The append's produced event carries the live-generator origin,
          // which the review policy maps to intermediate and skips by default."
          originKind: "live_generator",
          producerRunId: input.runId,
          producerAgentId: null,
        });
        return [
          {
            // The projection mirror follows the revision it points at. Only the
            // pointer fields move; nothing else about the row is rewritten.
            text: `UPDATE "${schema}"."objects"
                      SET data = data || jsonb_build_object(
                            'latestRepresentationRevisionId', $3::text,
                            'latestDigest', $4::text,
                            'mime', $5::text)
                    WHERE id = $1::text AND org_id = $2::text`,
            values: [
              input.artifactId,
              input.orgId,
              representationRevisionId,
              newBlob.sha256,
              newBlob.mimeDetected,
            ],
          },
          buildArtifactWriterWitnessOp(schema, {
            orgId: input.orgId,
            artifactId: input.artifactId,
            representationRevisionId,
            actor: input.createdBy ?? null,
            detail: {
              mime: newBlob.mimeDetected,
              size: newBlob.sizeBytes,
              originKind: "live_generator",
              appendedOver: input.baseRepresentationRevisionId,
            },
          }),
          buildFinalizeMaterializationQuery({
            ledgerId: claim.ledgerId,
            orgId: input.orgId,
            artifactId: input.artifactId,
            representationRevisionId,
          }),
          // The picture's own prompt, provider and model on the row this write
          // finalizes (item 0.28). Absent for every write that made no picture.
          ...(input.imageProvenance
            ? [
                buildImageGenerationProvenanceQuery({
                  schema,
                  ledgerId: claim.ledgerId,
                  orgId: input.orgId,
                  provenance: input.imageProvenance,
                }),
              ]
            : []),
          ...(producedEventOp ? [producedEventOp] : []),
          ...(typeof input.declaredReviewTaskId === "string" &&
          input.declaredReviewTaskId.length > 0
            ? [
                {
                  text: `INSERT INTO "${schema}"."${REVISION_GATE_SATISFACTION_TABLE}"
  (org_id, artifact_id, representation_revision_id, run_id, review_task_id)
VALUES ($1::text, $2::text, $3::text, $4::text, $5::text)
ON CONFLICT (org_id, artifact_id, representation_revision_id) DO NOTHING`,
                  values: [
                    input.orgId,
                    input.artifactId,
                    representationRevisionId,
                    input.runId,
                    input.declaredReviewTaskId,
                  ],
                },
              ]
            : []),
        ];
      },
    });
  } catch (err) {
    // The bytes are (probably) unreferenced now; the reachability-guarded delete
    // keeps anything a live row still points at.
    await discardBlob();
    throw err;
  }

  if (result.kind === "stale") {
    // A CONCURRENT RETRY OF THIS EXACT APPEND IS NOT A STALE BASE. Two drives
    // of the same operation share one claim; the loser of the compare-and-set
    // would report 409 for a write that DID land. The ledger row is the record
    // of what happened, so it is read before the refusal is stated.
    const finalized = await sql(
      `SELECT artifact_id, representation_revision_id FROM "${schema}"."artifact_materializations"
        WHERE id = $1 AND org_id = $2 AND phase = 'finalized'`,
      [claim.ledgerId, input.orgId],
    );
    if (
      finalized &&
      typeof finalized.representation_revision_id === "string" &&
      finalized.artifact_id === input.artifactId
    ) {
      await discardStaged();
      const revRow = await sql(
        `SELECT revision FROM "${schema}"."representation" WHERE id = $1 AND org_id = $2`,
        [finalized.representation_revision_id, input.orgId],
      );
      return {
        ok: true,
        artifactId: input.artifactId,
        representationRevisionId: String(finalized.representation_revision_id),
        revision: Number(revRow?.revision ?? 0),
        deduped: true,
      };
    }
    await discardStaged();
    await releaseClaim();
    return {
      ok: false,
      reason: "stale_base",
      error:
        `revision ${baseRevision} of artifact ${input.artifactId} has already been built on — ` +
        "read the current revision and append again",
    };
  }
  if (result.kind === "unknown-base") {
    await discardStaged();
    await releaseClaim();
    return {
      ok: false,
      reason: "unknown_base",
      error:
        `representation revision ${input.baseRepresentationRevisionId} is not a revision of ` +
        `artifact ${input.artifactId} in this organisation`,
    };
  }

  return {
    ok: true,
    artifactId: input.artifactId,
    representationRevisionId: result.record.id,
    revision: result.record.revision,
    deduped: false,
  };
}

export type RevisionGateSatisfaction = {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  runId: string;
  reviewTaskId: string;
};

/** The gate recorded as the review of one appended revision, or null. Read by
 *  the produced-output road, which resolves to that gate instead of opening a
 *  second (item 0.30). */
export async function readRevisionGateSatisfaction(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<RevisionGateSatisfaction | null> {
  ensurePostgresSchema();
  const schema = schemaId();
  const row = await sql(
    `SELECT run_id, review_task_id FROM "${schema}"."${REVISION_GATE_SATISFACTION_TABLE}"
      WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3 LIMIT 1`,
    [input.orgId, input.artifactId, input.representationRevisionId],
  );
  if (!row || typeof row.review_task_id !== "string") return null;
  return {
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.representationRevisionId,
    runId: String(row.run_id),
    reviewTaskId: String(row.review_task_id),
  };
}

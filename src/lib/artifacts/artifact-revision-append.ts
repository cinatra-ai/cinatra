import "server-only";
import { createHash, randomUUID } from "node:crypto";

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
//   the review of those revisions, and the produced-output road, when it fires,
//   resolves to that gate instead of opening a second — a satisfaction rule
//   keyed on the artifact revision and the run, new machinery this item names."
//
//   §8.3: "the caller names the revision it read, and the append inserts the
//   next number under the unique index on organisation, artifact and revision
//   that the append-only `representation` table already carries — a save that
//   names a base another save has already built on fails on that index, which is
//   the compare-and-set; the append is one transaction with its ledger row and
//   produced event."
//
// THE SHAPE. The bytes are streamed into the store and the content-addressed
// resource is recorded exactly as a creation records one — the same blob store,
// the same substance key, the same orphan guards. What differs is the second
// transaction: instead of minting an object and a first revision, it appends the
// NEXT revision against the base the caller read, and everything else in that
// transaction (the objects envelope, the writer witness, the materialization
// ledger's finalize, the produced event, the satisfaction row) rides with it.
// A compare-and-set loss aborts the whole transaction, so a refused append
// leaves no ledger row and no produced event behind.

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { maybeBuildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";

import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import { buildArtifactWriterWitnessOp } from "./artifact-writer-witness";
import { deriveSubstanceKey } from "./resource-store";
import { mimeAcceptedByAccepts } from "./upload-artifact-type-map";
import {
  buildRepresentationAppendWithBaseQueries,
  isStaleRepresentationBase,
  isUnknownRepresentationBase,
} from "./representation-store";
import {
  buildFinalizeMaterializationQuery,
  claimMaterialization,
} from "./materialization-ledger";

/** The creation path's soft default, mirrored: one revision is one artifact's
 *  worth of bytes. */
const APPEND_BLOB_MAX_BYTES = 100 * 1024 * 1024;

async function* asUtf8Stream(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

export type ArtifactRevisionAppendRefusal =
  | "artifact_not_found"
  | "unknown_base"
  | "stale_base"
  | "accepts_mismatch";

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
  content: string;
  mime: string;
  createdBy: string | null;
  /** The extension the write is scoped to — the ledger row's own column. */
  extension: string;
  extensionVersion?: string | null;
  /**
   * The review task id of the gate THIS RUN declared. Recorded as the review of
   * the appended revision, so the produced-output road resolves to that gate
   * instead of opening a second one (item 0.30).
   */
  declaredReviewTaskId?: string | null;
}): Promise<ArtifactRevisionAppendResult> {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const connectionString = getPostgresConnectionString();

  // ------------------------------------------------------------------
  // The artifact, its declared type and the base revision — read BEFORE any
  // byte is written, so a refusal costs nothing.
  // ------------------------------------------------------------------
  const [objectRes] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT type FROM "${schema}"."objects" WHERE id = $1 AND org_id = $2 LIMIT 1`,
        values: [input.artifactId, input.orgId],
      },
    ],
  });
  const objectRow = objectRes?.rows?.[0] as { type?: string } | undefined;
  if (!objectRow || typeof objectRow.type !== "string") {
    return {
      ok: false,
      reason: "artifact_not_found",
      error: `artifact ${input.artifactId} does not exist in this organisation`,
    };
  }
  registerAllObjectTypes();
  const def = objectTypeRegistry.resolve(objectRow.type);
  const accepts = def?.isArtifact?.accepts?.file?.mimeTypes;
  if (Array.isArray(accepts) && accepts.length > 0 && !mimeAcceptedByAccepts(accepts, input.mime)) {
    return {
      ok: false,
      reason: "accepts_mismatch",
      error:
        `object type "${objectRow.type}" accepts [${accepts.join(", ")}]; the append declared ` +
        `"${input.mime}"`,
    };
  }
  const [baseRes] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT revision FROM "${schema}"."representation"
                WHERE id = $1 AND org_id = $2 AND artifact_id = $3 LIMIT 1`,
        values: [input.baseRepresentationRevisionId, input.orgId, input.artifactId],
      },
    ],
  });
  const baseRow = baseRes?.rows?.[0] as { revision?: number | string } | undefined;
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
  const contentHash = createHash("sha256").update(input.content, "utf8").digest("hex");
  const claim = await claimMaterialization({
    orgId: input.orgId,
    runId: input.runId,
    outputId: input.nodeId,
    nodeId: input.nodeId,
    path: "materialize_tool",
    extension: input.extension,
    contentHash,
  });
  if (claim.kind === "finalized") {
    const [revRes] = runPostgresQueriesSync({
      connectionString,
      queries: [
        {
          text: `SELECT revision FROM "${schema}"."representation" WHERE id = $1 AND org_id = $2`,
          values: [claim.representationRevisionId, input.orgId],
        },
      ],
    });
    return {
      ok: true,
      artifactId: claim.artifactId,
      representationRevisionId: claim.representationRevisionId,
      revision: Number((revRes?.rows?.[0] as { revision?: number } | undefined)?.revision ?? 0),
      deduped: true,
    };
  }

  // ------------------------------------------------------------------
  // The bytes, then the content-addressed resource — the store's own road.
  // ------------------------------------------------------------------
  const representationRevisionId = randomUUID();
  const preallocatedResourceId = randomUUID();
  const blobStore = createLocalDiskBlobStore();
  const newBlob = await blobStore.put({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId,
    stream: asUtf8Stream(input.content),
    declaredMime: input.mime,
    // The same soft default the creation path takes; an appended revision is not
    // a different class of bytes from a first one.
    maxBytes: APPEND_BLOB_MAX_BYTES,
  });
  if (Array.isArray(accepts) && accepts.length > 0 && !mimeAcceptedByAccepts(accepts, newBlob.mimeDetected)) {
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
    return {
      ok: false,
      reason: "accepts_mismatch",
      error:
        `detected form "${newBlob.mimeDetected}" is not accepted by "${objectRow.type}" ` +
        `(accepts [${accepts.join(", ")}])`,
    };
  }

  const substanceKey = deriveSubstanceKey({ kind: "blob", sha256: newBlob.sha256 });
  let resourceId: string;
  try {
    const [resourceRes] = runPostgresQueriesSync({
      connectionString,
      transaction: true,
      queries: [
        {
          text: `WITH resource_op AS (
  INSERT INTO "${schema}"."resource"
    (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
  VALUES ($1::text, $2::text, 'blob', $3::text, $4::text, $5::bigint, $6::text,
          jsonb_build_object('storageKey', $8::text, 'blobId', $7::text))
  ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
  RETURNING id, mime, size_bytes, metadata, (xmax = 0) AS is_new
),
blob_insert AS (
  INSERT INTO "${schema}"."artifact_blobs"
    (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
  SELECT $7::text, $2::text, 'local-disk', $8::text, $9::text, $5::bigint, $4::text, $6::text
  WHERE EXISTS (SELECT 1 FROM resource_op WHERE is_new)
  RETURNING id
)
SELECT r.id AS resource_id, r.metadata->>'storageKey' AS storage_key
  FROM resource_op r`,
          values: [
            preallocatedResourceId,
            input.orgId,
            substanceKey,
            newBlob.mimeDetected,
            newBlob.sizeBytes,
            input.createdBy ?? null,
            newBlob.blobId,
            newBlob.storageKey,
            newBlob.sha256,
          ],
        },
      ],
    });
    const row = resourceRes?.rows?.[0] as
      | { resource_id: string; storage_key: string | null }
      | undefined;
    if (!row || typeof row.storage_key !== "string" || row.storage_key.length === 0) {
      throw new Error(
        "the content-addressed resource has no storage binding — refusing to bind a new revision to it",
      );
    }
    resourceId = String(row.resource_id);
  } catch (err) {
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
    throw err;
  }

  // ------------------------------------------------------------------
  // ONE TRANSACTION: the compare-and-set append, the objects envelope, the
  // writer witness, the ledger finalize, the produced event and the
  // satisfaction row. A lost compare-and-set aborts all of it.
  // ------------------------------------------------------------------
  const producedEventOp = maybeBuildProducedEventInsertOp(schema, {
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId,
    emitter: "artifact_revision_append",
    // "The append's produced event carries the live-generator origin, which the
    // review policy maps to intermediate and skips by default."
    originKind: "live_generator",
    producerRunId: input.runId,
    producerAgentId: null,
    producingExtension: input.extension,
    producingExtensionVersion: input.extensionVersion ?? null,
  });
  try {
    runPostgresQueriesSync({
      connectionString,
      transaction: true,
      queries: [
        ...buildRepresentationAppendWithBaseQueries({
          schema: postgresSchema,
          newRepresentationRevisionId: representationRevisionId,
          orgId: input.orgId,
          artifactId: input.artifactId,
          resourceId,
          form: "file",
          baseRepresentationRevisionId: input.baseRepresentationRevisionId,
          createdBy: input.createdBy ?? null,
          createdByRunId: input.runId,
        }),
        {
          // The projection mirror follows the revision it points at. Only the
          // pointer fields move; nothing else about the row is rewritten.
          text: `UPDATE "${schema}"."objects"
                    SET data = data || jsonb_build_object(
                          'latestRepresentationRevisionId', $3::text,
                          'latestDigest', $4::text,
                          'mime', $5::text,
                          'size', $6::bigint)
                  WHERE id = $1::text AND org_id = $2::text`,
          values: [
            input.artifactId,
            input.orgId,
            representationRevisionId,
            newBlob.sha256,
            newBlob.mimeDetected,
            newBlob.sizeBytes,
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
        ...(producedEventOp ? [producedEventOp] : []),
        ...(typeof input.declaredReviewTaskId === "string" && input.declaredReviewTaskId.length > 0
          ? [
              {
                text: `INSERT INTO "${schema}"."artifact_revision_review_satisfaction"
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
      ],
    });
  } catch (err) {
    // The bytes are (probably) unreferenced now; the reachability-guarded delete
    // keeps anything a live row still points at.
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
    if (isUnknownRepresentationBase(err)) {
      return {
        ok: false,
        reason: "unknown_base",
        error:
          `representation revision ${input.baseRepresentationRevisionId} is not a revision of ` +
          `artifact ${input.artifactId} in this organisation`,
      };
    }
    if (isStaleRepresentationBase(err)) {
      return {
        ok: false,
        reason: "stale_base",
        error:
          `revision ${baseRevision} of artifact ${input.artifactId} has already been built on — ` +
          `read the current revision and append again`,
      };
    }
    throw err;
  }

  return {
    ok: true,
    artifactId: input.artifactId,
    representationRevisionId,
    revision: baseRevision + 1,
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
export function readRevisionGateSatisfaction(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): RevisionGateSatisfaction | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT run_id, review_task_id FROM "${schema}"."artifact_revision_review_satisfaction"
                WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3 LIMIT 1`,
        values: [input.orgId, input.artifactId, input.representationRevisionId],
      },
    ],
  });
  const row = res?.rows?.[0] as { run_id?: string; review_task_id?: string } | undefined;
  if (!row || typeof row.review_task_id !== "string") return null;
  return {
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.representationRevisionId,
    runId: String(row.run_id),
    reviewTaskId: row.review_task_id,
  };
}

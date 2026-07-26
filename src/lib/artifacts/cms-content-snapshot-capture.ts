import "server-only";
import { randomUUID, createHash } from "node:crypto";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// Sync-leaf connection/schema primitives (the artifact write-path contract):
// never import `@/lib/database` from a sync store leaf - database.ts is an ASYNC
// module in Turbopack dev. Mirrors object-content-snapshot.ts.
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { buildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";
import type { ProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";
import { producedEventId } from "@/lib/lifecycle/lifecycle-produced-event";

import {
  buildConnectorRefSnapshotArtifact,
  type ConnectorRefPointer,
  type ConnectorRefResolvedContent,
} from "@cinatra-ai/objects/connector-ref";

import { deriveSubstanceKey } from "./resource-store";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";

// ---------------------------------------------------------------------------
// CMS content-snapshot CAPTURE writer (cinatra#2043, epic #2037 S5 - the CORE
// half). MIRRORS `object-content-snapshot.ts`: a raw
// `runPostgresQueriesSync({transaction:true})` writer that persists the fetched
// CMS content as a real artifact (a `resource` + `artifact_blobs` + append-only
// `representation`, the same substrate an uploaded file uses, so the existing
// serve / retention / GC machinery handles it with no special case) AND - in the
// SAME query list, one atomic transaction (the S0 same-tx ordering) - splices:
//
//   (a) the transactional `ArtifactProduced` event
//       (`buildProducedEventInsertOp`, emitter `object_cms_snapshot_capture`),
//       so a durable, idempotent event drives review in the SAME tx as the write;
//   (b) the `cms_snapshot_targets` row binding the snapshot to its apply context
//       (the connector instance, the resource type/id, the base remote revision
//       ref, the SCOPE MANIFEST the read-back verifier reads back, and the
//       idempotency `operation_id`).
//
// FENCE (the S5 grounding finding): `maybeBuildProducedEventInsertOp` returns
// null unless the GLOBAL env fence is on - which would drop the event even when
// the CALLER (the connector staged-write adapter, a follow-up lane) explicitly
// drives a lifecycle-active capture. So this writer takes an EXPLICIT
// `emitProducedEvent` flag and calls `buildProducedEventInsertOp` DIRECTLY,
// gating at the CALLER level exactly like the rest of the S-slices' caller-side
// gates (the review action reads `isLifecycleReviewOrchestrationActive()` and
// decides; this writer's caller does the same and passes the boolean). With the
// flag false the query list is the pure artifact write - no event row.
//
// PRODUCED-EVENT AXES: the physical origin of a captured CMS snapshot is
// `external_link` (`CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND`), which the lattice maps
// to `user_provided`; a captured CMS snapshot is a PROPOSED REMOTE APPLY, so its
// `destinationClass` is `external_publish` - the external-effect class that makes
// the review checkpoint FIRE (lifecycle-policy `coreDefault`) and the
// verification checkpoint fire on the read-back.
// ---------------------------------------------------------------------------

const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The physical origin kind of a captured CMS snapshot (mirrors
 * `CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND`; kept local so this leaf has no runtime
 * dependency on the objects package beyond the pure snapshot-shape builder). */
const CMS_SNAPSHOT_ORIGIN_KIND = "external_link" as const;

/** The enumerated emitter for the S0 closed emitter set. */
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture" as const;

/** The object TYPE a captured CMS snapshot is persisted as. A captured snapshot is
 * an independent record-class artifact (the `buildConnectorRefSnapshotArtifact`
 * shape); it is NOT the retired generic floor type, so it passes the objects
 * write guard, and the review-orchestration classifier reads it as the artifact
 * type for org-rule matching. */
export const CMS_SNAPSHOT_OBJECT_TYPE = "@cinatra-ai/objects:cms-content-snapshot";

export class CmsSnapshotTooLargeError extends Error {
  constructor(public readonly sizeBytes: number) {
    super(
      `[cms-content-snapshot-capture] resolved content is ${sizeBytes} bytes, exceeds the ${SNAPSHOT_MAX_BYTES}-byte cap`,
    );
    this.name = "CmsSnapshotTooLargeError";
  }
}

/** The closed set of field paths the review authorizes an apply to change. Stored
 * on `cms_snapshot_targets.scope_manifest` and read BACK by the verifier - the
 * apply can never widen what it was authorized to touch. */
export interface CmsScopeManifest {
  paths: string[];
}

async function* bytesOf(u8: Uint8Array): AsyncIterable<Uint8Array> {
  yield u8;
}

/** The resolved blob + identity facts a capture query list is composed from. Split
 * out so the query-list composition is a PURE, unit-provable function (event op
 * present iff active, target row present, ONE transaction) with no DB / blob I/O. */
export interface CmsSnapshotCaptureFacts {
  orgId: string;
  /** The minted artifact id the snapshot representation belongs to (fresh per
   * capture - the snapshot IS an independent, self-contained record). */
  artifactId: string;
  /** The minted representation revision id - the review/verification pin. */
  representationRevisionId: string;
  resourceId: string;
  blobId: string;
  snapshotTargetId: string;
  substanceKey: string;
  storageKey: string;
  sha256: string;
  mimeDetected: string;
  sizeBytes: number;
  createdBy: string | null;
  producerRunId: string | null;
  producerAgentId: string | null;
  /** CMS apply binding. */
  connectorInstance: string;
  resourceType: string;
  cmsResourceId: string | null;
  baseRemoteRevisionRef: string | null;
  operationId: string;
  scopeManifest: CmsScopeManifest;
  /** Correlation/display metadata for the snapshot's `objects` row (NEVER the
   * body — that lives on the blob). Serialized to jsonb. */
  objectData: Record<string, unknown>;
  /** CALLER-level fence: when true the produced-event INSERT is spliced (via
   * `buildProducedEventInsertOp` DIRECTLY); when false it is omitted. */
  emitProducedEvent: boolean;
}

/**
 * PURE composition of the capture transaction's query list (no DB, no blob I/O).
 * `schema` is the already-escaped postgres schema identifier. The returned array
 * is ONE atomic transaction's op list, in order:
 *   [0] resource + artifact_blobs + representation write (the CMS content).
 *   [1..] the produced-event INSERT (ONLY when `emitProducedEvent`), then the
 *         `cms_snapshot_targets` INSERT - spliced into the SAME list so the event
 *         + the apply binding commit/roll-back atomically with the content write.
 */
export function buildCmsSnapshotCaptureQueries(
  schema: string,
  f: CmsSnapshotCaptureFacts,
): ProducedEventInsertOp[] {
  // The snapshot's `objects` row — the artifact identity the review gate pins and
  // the S1 orchestration classifies (a produced event whose artifact has no
  // `objects` row is left UNGATED, `resolveReviewContext` -> "objects row not
  // found"). The body is NOT here (it lives on the blob); only correlation/display
  // metadata. `run_id` links the snapshot to the producing run so the run-embedded
  // review surface can weave it in.
  const objectInsert: ProducedEventInsertOp = {
    text: `INSERT INTO "${schema}"."objects"
  (id, type, data, org_id, run_id, created_by, owner_level, owner_id, visibility, version, graphiti_sync_status)
VALUES ($1::text, $2::text, $3::jsonb, $4::text, $5::text, $6::text,
        'organization', $4::text, 'organization', 1, 'synced')`,
    values: [
      f.artifactId,
      CMS_SNAPSHOT_OBJECT_TYPE,
      JSON.stringify(f.objectData ?? {}),
      f.orgId,
      f.producerRunId,
      f.createdBy,
    ],
  };

  const contentWrite: ProducedEventInsertOp = {
    text: `WITH resource_op AS (
  INSERT INTO "${schema}"."resource"
    (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
  VALUES ($1::text, $2::text, 'blob', $3::text, $4::text, $5::bigint, $6::text,
          jsonb_build_object('storageKey', $7::text, 'blobId', $8::text))
  ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
  RETURNING id, (xmax = 0) AS is_new
),
blob_insert AS (
  INSERT INTO "${schema}"."artifact_blobs"
    (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
  SELECT $8::text, $2::text, 'local-disk', $7::text, $9::text, $5::bigint, $4::text, $6::text
  WHERE EXISTS (SELECT 1 FROM resource_op WHERE is_new)
  RETURNING id
),
rep_insert AS (
  INSERT INTO "${schema}"."representation"
    (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id)
  SELECT $10::text, $2::text, $11::text, (SELECT id FROM resource_op),
    COALESCE((SELECT MAX(revision) FROM "${schema}"."representation" WHERE org_id = $2 AND artifact_id = $11), 0) + 1,
    'file', $6::text, $12
  RETURNING id, resource_id
)
SELECT (SELECT id FROM rep_insert) AS representation_revision_id,
       (SELECT resource_id FROM rep_insert) AS resource_id`,
    values: [
      f.resourceId, // $1
      f.orgId, // $2
      f.substanceKey, // $3
      f.mimeDetected, // $4
      f.sizeBytes, // $5
      f.createdBy, // $6
      f.storageKey, // $7
      f.blobId, // $8
      f.sha256, // $9
      f.representationRevisionId, // $10
      f.artifactId, // $11
      f.producerRunId, // $12
    ],
  };

  const producedEventOp = f.emitProducedEvent
    ? buildProducedEventInsertOp(schema, {
        orgId: f.orgId,
        artifactId: f.artifactId,
        representationRevisionId: f.representationRevisionId,
        emitter: CMS_SNAPSHOT_EMITTER,
        originKind: CMS_SNAPSHOT_ORIGIN_KIND,
        // A captured CMS snapshot is a PROPOSED REMOTE APPLY - the external-effect
        // class that fires the review (and, on read-back, the verification) checkpoint.
        destinationClass: "external_publish",
        producerRunId: f.producerRunId,
        producerAgentId: f.producerAgentId,
      })
    : null;

  const targetInsert: ProducedEventInsertOp = {
    // PLAIN insert (NO `ON CONFLICT DO NOTHING`): a duplicate `operation_id` must
    // RAISE the unique-violation and ROLL BACK the whole atomic set - never
    // silently drop only the binding row while committing a fresh artifact +
    // produced event with no apply binding (a codex convergence finding). True
    // operation-idempotency is the pre-read fast path in `captureCmsContentSnapshot`
    // (returns the existing binding without minting anything); a concurrent racer
    // that slips past the pre-read rolls back cleanly here and re-reads the winner.
    text: `INSERT INTO "${schema}"."cms_snapshot_targets"
  (id, artifact_id, snapshot_revision_id, scope_manifest, connector_instance,
   resource_type, resource_id, base_remote_revision_ref, operation_id)
VALUES ($1::text, $2::text, $3::text, $4::jsonb, $5::text,
        $6::text, $7::text, $8::text, $9::text)`,
    values: [
      f.snapshotTargetId,
      f.artifactId,
      f.representationRevisionId,
      JSON.stringify(f.scopeManifest ?? { paths: [] }),
      f.connectorInstance,
      f.resourceType,
      f.cmsResourceId,
      f.baseRemoteRevisionRef,
      f.operationId,
    ],
  };

  return [objectInsert, contentWrite, ...(producedEventOp ? [producedEventOp] : []), targetInsert];
}

/** The stored apply-binding facts needed to return an idempotent capture result
 * without re-minting: the binding row + its representation's resource. */
interface ExistingCmsCapture {
  snapshotTargetId: string;
  artifactId: string;
  snapshotRevisionId: string;
  resourceId: string;
}

/** Read an EXISTING capture for `operationId` (the idempotency key). Joins the
 * apply-binding row to its snapshot representation for the resource id. Null when
 * no capture exists yet. Sync leaf (mirrors the module's other reads). */
function readExistingCmsCapture(
  schema: string,
  operationId: string,
): ExistingCmsCapture | null {
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT t.id, t.artifact_id, t.snapshot_revision_id, rep.resource_id
FROM "${schema}"."cms_snapshot_targets" t
JOIN "${schema}"."representation" rep ON rep.id = t.snapshot_revision_id
WHERE t.operation_id = $1
LIMIT 1`,
        values: [operationId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | { id: string; artifact_id: string; snapshot_revision_id: string; resource_id: string }
    | undefined;
  if (!row) return null;
  return {
    snapshotTargetId: String(row.id),
    artifactId: String(row.artifact_id),
    snapshotRevisionId: String(row.snapshot_revision_id),
    resourceId: String(row.resource_id),
  };
}

/** Postgres unique-violation on the operation-uniq index (a duplicate
 * `operation_id` racer). Matches the SQLSTATE and, defensively, the constraint
 * name in the message (runPostgresQueriesSync may surface either). */
function isOperationUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("cms_snapshot_targets_operation_uniq") || msg.includes("duplicate key value");
}

export interface CaptureCmsContentSnapshotInput {
  orgId: string;
  /** The connector pointer for the fetched target (the objects `connector-ref`
   * shape) - reused so the snapshot-input shape matches the pointer-snapshot
   * precedent (`buildConnectorRefSnapshotArtifact`). */
  pointer: ConnectorRefPointer;
  /** The content the connector resolved for the pointer (exactly one of
   * text / bytesBase64). */
  resolved: ConnectorRefResolvedContent;
  /** ISO capture timestamp (audit/correlation only). */
  capturedAt: string;
  /** The closed set of authorized apply paths (stored, read back by the verifier). */
  scopeManifest: CmsScopeManifest;
  /** CMS apply binding. */
  connectorInstance: string;
  resourceType: string;
  cmsResourceId?: string | null;
  baseRemoteRevisionRef?: string | null;
  /** Idempotency key on `cms_snapshot_targets` (unique) - a re-drive of the same
   * staged write reuses the same target row. */
  operationId: string;
  producerRunId?: string | null;
  producerAgentId?: string | null;
  createdBy?: string | null;
  /** CALLER-level fence: the connector adapter (or the live-proof harness) passes
   * `isLifecycleReviewOrchestrationActive()`. True => the produced-event INSERT is
   * spliced into the capture tx; false => the pure artifact write. */
  emitProducedEvent: boolean;
  title?: string;
}

export interface CaptureCmsContentSnapshotResult {
  artifactId: string;
  /** The snapshot representation revision - the review/verification pin. */
  snapshotRevisionId: string;
  resourceId: string;
  snapshotTargetId: string;
  sizeBytes: number;
  contentDigest: string;
  /** The deterministic produced-event id, when the fence was active (else null). */
  producedEventId: string | null;
}

/**
 * Capture the fetched CMS content as an immutable snapshot artifact + its apply
 * binding, atomically. The caller (the connector staged-write adapter) supplies
 * the fetched content + the scope manifest + the connector identity; this writer
 * shapes the snapshot via the pure `buildConnectorRefSnapshotArtifact`, writes the
 * bytes to the blob store, and runs the ONE capture transaction.
 */
export async function captureCmsContentSnapshot(
  input: CaptureCmsContentSnapshotInput,
): Promise<CaptureCmsContentSnapshotResult> {
  ensurePostgresSchema();
  const schema = q();

  // Shape the snapshot exactly like the pointer-snapshot precedent (pure; enforces
  // exactly-one-of text/bytes and self-containment).
  const spec = buildConnectorRefSnapshotArtifact({
    pointer: input.pointer,
    resolved: input.resolved,
    capturedAt: input.capturedAt,
    ...(input.title !== undefined ? { title: input.title } : {}),
  });

  const bytes =
    spec.bodyText !== undefined
      ? new TextEncoder().encode(spec.bodyText)
      : Uint8Array.from(Buffer.from(spec.bytesBase64 ?? "", "base64"));
  const sizeBytes = bytes.byteLength;
  if (sizeBytes > SNAPSHOT_MAX_BYTES) throw new CmsSnapshotTooLargeError(sizeBytes);
  const contentDigest = sha256(
    spec.bodyText !== undefined ? spec.bodyText : (spec.bytesBase64 ?? ""),
  );

  // Operation-idempotency FAST PATH (codex convergence finding): a re-drive of the
  // same staged write returns the EXISTING binding without minting a second
  // artifact / produced event. The capture is keyed by `operationId` (unique on
  // cms_snapshot_targets); the tx below rolls back a duplicate rather than
  // orphaning a fresh artifact, and this pre-read short-circuits the common retry.
  const existing = readExistingCmsCapture(schema, input.operationId);
  if (existing) {
    return {
      artifactId: existing.artifactId,
      snapshotRevisionId: existing.snapshotRevisionId,
      resourceId: existing.resourceId,
      snapshotTargetId: existing.snapshotTargetId,
      sizeBytes,
      contentDigest,
      producedEventId: input.emitProducedEvent
        ? producedEventId(existing.artifactId, existing.snapshotRevisionId)
        : null,
    };
  }

  const artifactId = randomUUID();
  const representationRevisionId = randomUUID();
  const resourceId = randomUUID();
  const snapshotTargetId = randomUUID();

  const blobStore = createLocalDiskBlobStore();
  const newBlob = await blobStore.put({
    orgId: input.orgId,
    artifactId,
    representationRevisionId,
    stream: bytesOf(bytes),
    declaredMime: spec.mime,
    maxBytes: SNAPSHOT_MAX_BYTES,
  });

  const substanceKey = deriveSubstanceKey({ kind: "blob", sha256: newBlob.sha256 });

  const facts: CmsSnapshotCaptureFacts = {
    orgId: input.orgId,
    artifactId,
    representationRevisionId,
    resourceId,
    blobId: newBlob.blobId,
    snapshotTargetId,
    substanceKey,
    storageKey: newBlob.storageKey,
    sha256: newBlob.sha256,
    mimeDetected: newBlob.mimeDetected,
    sizeBytes,
    createdBy: input.createdBy ?? null,
    producerRunId: input.producerRunId ?? null,
    producerAgentId: input.producerAgentId ?? null,
    connectorInstance: input.connectorInstance,
    resourceType: input.resourceType,
    cmsResourceId: input.cmsResourceId ?? null,
    baseRemoteRevisionRef: input.baseRemoteRevisionRef ?? null,
    operationId: input.operationId,
    scopeManifest: input.scopeManifest ?? { paths: [] },
    // Correlation/display metadata for the objects row (never the body).
    objectData: {
      title: spec.title,
      mime: spec.mime,
      connectorId: input.pointer.connectorId,
      externalId: input.pointer.externalId,
      connectorInstance: input.connectorInstance,
      resourceType: input.resourceType,
      cmsResourceId: input.cmsResourceId ?? null,
      sourceUrl: spec.correlation.sourceUrl,
      capturedAt: input.capturedAt,
      capturedFromState: spec.correlation.capturedFromState,
      snapshotOf: "cms-content",
    },
    emitProducedEvent: input.emitProducedEvent,
  };

  const queries = buildCmsSnapshotCaptureQueries(schema, facts);

  let capRes: { rows?: Array<Record<string, unknown>> } | undefined;
  try {
    const results = runPostgresQueriesSync({
      connectionString: conn(),
      transaction: true,
      queries,
    });
    // results[0] = objects insert; results[1] = the content-write CTE's SELECT.
    capRes = results[1] as typeof capRes;
  } catch (err) {
    // The content write failed AFTER the (content-addressed, reachability-guarded)
    // blob landed. Best-effort delete of the just-written bytes - a same-substance
    // future capture re-dedupes safely; a residual disk orphan is reclaimed by the
    // artifact-blob-verifier sweep (the object-content-snapshot residual class).
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
    // RACE LOSER: a concurrent capture for the same operationId won between the
    // pre-read and this tx. The unique-violation rolled the WHOLE set back (no
    // orphan artifact / event), so re-read the winner's binding and return it -
    // the caller sees one canonical capture per operation.
    if (isOperationUniqueViolation(err)) {
      const winner = readExistingCmsCapture(schema, input.operationId);
      if (winner) {
        return {
          artifactId: winner.artifactId,
          snapshotRevisionId: winner.snapshotRevisionId,
          resourceId: winner.resourceId,
          snapshotTargetId: winner.snapshotTargetId,
          sizeBytes,
          contentDigest,
          producedEventId: input.emitProducedEvent
            ? producedEventId(winner.artifactId, winner.snapshotRevisionId)
            : null,
        };
      }
    }
    throw err;
  }

  const out = capRes?.rows?.[0] as
    | { representation_revision_id: string | null; resource_id: string | null }
    | undefined;
  if (!out?.representation_revision_id || !out?.resource_id) {
    throw new Error(
      "[cms-content-snapshot-capture] capture returned no representation despite a successful transaction",
    );
  }

  return {
    artifactId,
    snapshotRevisionId: String(out.representation_revision_id),
    resourceId: String(out.resource_id),
    snapshotTargetId,
    sizeBytes,
    contentDigest,
    producedEventId: facts.emitProducedEvent
      ? producedEventId(artifactId, representationRevisionId)
      : null,
  };
}

/**
 * Read back the PROPOSED CMS field map a capture persisted, by its snapshot
 * representation revision id. The snapshot bytes are the connector's canonical
 * CMS-fields serialization (`application/vnd.cinatra.cms-fields+json` — a flat
 * `{path: value}` JSON of the reviewed post state), so the read-back verifier can
 * project the REVIEWED (base) fields for the apply-verification diff WITHOUT the
 * connector ever re-sending them (the connector hands the host only the
 * post-apply re-read; the approved proposal is the durable base, read here).
 *
 * Resolves the representation → its content-addressed blob (via the resource
 * row's `metadata.storageKey`) and parses the JSON object to a string→string
 * field map. Returns `null` when the revision, its resource, its storage key, or
 * the blob content cannot be resolved / parsed (the caller fails closed — an
 * unreadable base authorizes NO change, so every post-apply field reads as
 * out-of-scope drift). Server-only; the blob read is async.
 */
export async function readCmsSnapshotProposedFields(
  orgId: string,
  snapshotRevisionId: string,
): Promise<Record<string, string> | null> {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT r.metadata->>'storageKey' AS storage_key
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r ON r.id = rep.resource_id
WHERE rep.org_id = $1 AND rep.id = $2
LIMIT 1`,
        values: [orgId, snapshotRevisionId],
      },
    ],
  });
  const storageKey = (res?.rows?.[0] as { storage_key?: string | null } | undefined)?.storage_key;
  if (!storageKey) return null;

  let text: string;
  try {
    const handle = await createLocalDiskBlobStore().openByStorageKey({ orgId, storageKey });
    const chunks: Uint8Array[] = [];
    for await (const chunk of handle.stream) chunks.push(chunk);
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

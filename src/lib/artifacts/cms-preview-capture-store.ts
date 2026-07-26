import "server-only";
import { randomUUID, createHash } from "node:crypto";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
// Sync-leaf connection/schema primitives (the artifact write-path contract):
// never import `@/lib/database` from a sync store leaf. Mirrors
// `cms-content-snapshot-capture.ts`.
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";

import { deriveSubstanceKey } from "./resource-store";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";

// ---------------------------------------------------------------------------
// PINNED preview-capture store (cinatra#2044 S6, sub-lane L-B).
//
// A capture is written ONCE, at gate creation, and never again — #2044's
// immutability rule: "re-viewing an old gate shows the ORIGINAL capture even
// after the site theme changes". So a capture is stored the same way every other
// immutable artifact is (an `objects` row + `resource` + `artifact_blobs` + an
// append-only `representation`), which means the existing serve / authz /
// retention / GC machinery handles it with NO special case — in particular the
// host's version-pinned preview byte route already serves `image/png` under full
// session/actor/tenant/tombstone gating, so the review surface needs no new
// byte-serving path and no new authorization surface.
//
// NO MIGRATION. The binding from a capture to the gate it belongs to rides the
// capture object's own `data` jsonb (`boundArtifactId` + `boundSnapshotRevisionId`
// — the exact pair a gate PINS at creation), read back through the existing
// `objects_org_type_idx` (org_id, type) index. A dedicated table would have
// bought a unique constraint and nothing else; the DETERMINISTIC capture id below
// buys the same guarantee off the `objects` primary key.
//
// IDEMPOTENT + RACE-SAFE WITHOUT DDL: the capture artifact id is
// sha256(boundArtifactId, boundSnapshotRevisionId, role) — the same
// deterministic-id device the produced-event outbox uses. A re-drive of the same
// capture therefore collides on the objects PRIMARY KEY and rolls the whole
// transaction back (never an orphan blob row + a second capture), and the race
// loser re-reads the winner. One capture per (pinned target, role), enforced by
// the database.
//
// DEGRADED captures are stored too, deliberately: a failed capture writes the
// SAME record shape with `status:"degraded"` and a named reason and NO
// representation. #2044's honest-fallback rule is that the gap is stated on the
// gate, not that the capture silently vanishes — so the review surface can say
// exactly why there is no picture.
// ---------------------------------------------------------------------------

/** The object TYPE a pinned capture is persisted as. Distinct from the CMS
 * snapshot type: a capture is CONTEXT for the decision, never the decided
 * target. */
export const CMS_PREVIEW_CAPTURE_OBJECT_TYPE = "@cinatra-ai/objects:cms-preview-capture";

/** The before/after pair #2044 asks for. `current` is the staged proposal's
 * render (what the reviewer decides against); `before` is the published page as
 * it stood at gate creation. */
export type CmsPreviewCaptureRole = "current" | "before";

/** A capture either produced a picture, or explains why it could not. */
export type CmsPreviewCaptureStatus = "captured" | "degraded";

/** One adapter-supplied region anchor's geometry, in CSS pixels relative to the
 * full-page screenshot. Anchors come EXCLUSIVELY from the adapter (#2044 forbids
 * reviewer-side CSS guessing), so this is transport, never inference. */
export interface CmsPreviewRegionBox {
  region: string;
  postId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CmsPreviewCaptureGeometry {
  regions: CmsPreviewRegionBox[];
  contentHeight: number;
  viewport: { width: number; height: number };
}

/** Everything a capture record carries besides the picture itself. */
export interface CmsPreviewCaptureRecordData {
  role: CmsPreviewCaptureRole;
  status: CmsPreviewCaptureStatus;
  /** Named degrade reason (null when captured) — surfaced verbatim on the gate. */
  degradedReason: string | null;
  /** The gate's pinned target this capture is context for. */
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  /** The connect-REGISTERED origin the capture was taken from (never adapter
   * input; see `cms-preview-capture-policy.ts`). */
  sourceOrigin: string | null;
  postId: number | null;
  capturedAt: string;
  geometry: CmsPreviewCaptureGeometry | null;
  /** What the inertness sanitizer removed before the page was rendered/stored. */
  sanitization: Record<string, number> | null;
  /** Subresource policy outcome from the isolated renderer. */
  network: { blockedRequests: number; allowedRequests: number } | null;
  /** sha256 of the SANITIZED page markup — the capture's provenance hash, which
   * the gate records as context provenance. */
  captureDigest: string | null;
  title: string;
}

const CAPTURE_MAX_BYTES = 24 * 1024 * 1024;
const CAPTURE_MIME = "image/png";

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/**
 * The DETERMINISTIC capture artifact id. Formatted as a uuid-shaped string so it
 * is indistinguishable from every other artifact id at every consuming surface,
 * derived from sha256 so the same (target, role) can only ever produce one row.
 */
export function previewCaptureArtifactId(
  boundArtifactId: string,
  boundSnapshotRevisionId: string,
  role: CmsPreviewCaptureRole,
): string {
  const h = createHash("sha256")
    .update(`${boundArtifactId}\u0000${boundSnapshotRevisionId}\u0000${role}`)
    .digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join(
    "-",
  );
}

interface QueryOp {
  text: string;
  values?: unknown[];
}

export interface PreviewCaptureWriteFacts {
  orgId: string;
  captureArtifactId: string;
  createdBy: string | null;
  producerRunId: string | null;
  data: CmsPreviewCaptureRecordData;
  /** Present ONLY for a `captured` record — the stored PNG. */
  image: {
    representationRevisionId: string;
    resourceId: string;
    blobId: string;
    substanceKey: string;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
  } | null;
}

/**
 * PURE composition of the capture transaction's query list (no DB, no blob I/O),
 * mirroring `buildCmsSnapshotCaptureQueries`:
 *   [0] the capture `objects` row (deterministic PK — a duplicate rolls back).
 *   [1] the PNG content write, ONLY for a captured record.
 * A degraded record is the objects row alone: the gate states the gap, and there
 * are no bytes to pretend otherwise.
 */
export function buildPreviewCaptureQueries(
  schema: string,
  f: PreviewCaptureWriteFacts,
): QueryOp[] {
  const objectInsert: QueryOp = {
    text: `INSERT INTO "${schema}"."objects"
  (id, type, data, org_id, run_id, created_by, owner_level, owner_id, visibility, version, graphiti_sync_status)
VALUES ($1::text, $2::text, $3::jsonb, $4::text, $5::text, $6::text,
        'organization', $4::text, 'organization', 1, 'synced')`,
    values: [
      f.captureArtifactId,
      CMS_PREVIEW_CAPTURE_OBJECT_TYPE,
      JSON.stringify(f.data),
      f.orgId,
      f.producerRunId,
      f.createdBy,
    ],
  };
  if (!f.image) return [objectInsert];

  const img = f.image;
  const contentWrite: QueryOp = {
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
  SELECT $10::text, $2::text, $11::text, (SELECT id FROM resource_op), 1, 'file', $6::text, $12
  RETURNING id, resource_id
)
SELECT (SELECT id FROM rep_insert) AS representation_revision_id,
       (SELECT resource_id FROM rep_insert) AS resource_id`,
    values: [
      img.resourceId, // $1
      f.orgId, // $2
      img.substanceKey, // $3
      CAPTURE_MIME, // $4
      img.sizeBytes, // $5
      f.createdBy, // $6
      img.storageKey, // $7
      img.blobId, // $8
      img.sha256, // $9
      img.representationRevisionId, // $10
      f.captureArtifactId, // $11
      f.producerRunId, // $12
    ],
  };
  return [objectInsert, contentWrite];
}

/** A stored capture, as the view path reads it back. */
export interface StoredPreviewCapture {
  captureArtifactId: string;
  /** The PNG revision to serve — null for a degraded capture. */
  representationRevisionId: string | null;
  data: CmsPreviewCaptureRecordData;
}

function rowToStored(row: Record<string, unknown>): StoredPreviewCapture {
  const raw = row.data;
  const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as CmsPreviewCaptureRecordData;
  const rev = row.representation_revision_id;
  return {
    captureArtifactId: String(row.id),
    representationRevisionId: typeof rev === "string" && rev.length > 0 ? rev : null,
    data,
  };
}

/**
 * READ the pinned captures for a gate's pinned target. Pure store read — one
 * SELECT, no blob read, and (the L-B contract) NO network of any kind: the view
 * path serves what was pinned at gate creation and never re-fetches the site.
 */
export function readPinnedPreviewCaptures(input: {
  orgId: string;
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
}): StoredPreviewCapture[] {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.id, o.data, rep.id AS representation_revision_id
FROM "${schema}"."objects" o
LEFT JOIN "${schema}"."representation" rep
  ON rep.artifact_id = o.id AND rep.org_id = o.org_id
WHERE o.org_id = $1
  AND o.type = $2
  AND o.data->>'boundArtifactId' = $3
  AND o.data->>'boundSnapshotRevisionId' = $4
ORDER BY o.created_at ASC, o.id ASC`,
        values: [
          input.orgId,
          CMS_PREVIEW_CAPTURE_OBJECT_TYPE,
          input.boundArtifactId,
          input.boundSnapshotRevisionId,
        ],
      },
    ],
  });
  const rows = (res?.rows ?? []) as Array<Record<string, unknown>>;
  return rows.map(rowToStored);
}

/** Read one already-written capture (the idempotency fast path / race re-read). */
export function readPinnedPreviewCapture(
  orgId: string,
  captureArtifactId: string,
): StoredPreviewCapture | null {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT o.id, o.data, rep.id AS representation_revision_id
FROM "${schema}"."objects" o
LEFT JOIN "${schema}"."representation" rep
  ON rep.artifact_id = o.id AND rep.org_id = o.org_id
WHERE o.org_id = $1 AND o.id = $2 AND o.type = $3
LIMIT 1`,
        values: [orgId, captureArtifactId, CMS_PREVIEW_CAPTURE_OBJECT_TYPE],
      },
    ],
  });
  const row = (res?.rows ?? [])[0] as Record<string, unknown> | undefined;
  return row ? rowToStored(row) : null;
}

function isDuplicateKey(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: string }).code === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("duplicate key value");
}

export interface WritePinnedPreviewCaptureInput {
  orgId: string;
  createdBy?: string | null;
  producerRunId?: string | null;
  data: CmsPreviewCaptureRecordData;
  /** The PNG bytes — omitted for a degraded record. */
  screenshot?: Uint8Array | null;
}

/**
 * Write ONE pinned capture record. Returns the stored capture (freshly written,
 * or the already-pinned one when this target+role was captured before — a
 * capture is never overwritten, which is exactly what makes an old gate still
 * show its ORIGINAL picture).
 */
export async function writePinnedPreviewCapture(
  input: WritePinnedPreviewCaptureInput,
): Promise<StoredPreviewCapture> {
  ensurePostgresSchema();
  const schema = q();
  const captureArtifactId = previewCaptureArtifactId(
    input.data.boundArtifactId,
    input.data.boundSnapshotRevisionId,
    input.data.role,
  );

  // Already pinned → return it untouched (immutability, and the common retry).
  const existing = readPinnedPreviewCapture(input.orgId, captureArtifactId);
  if (existing) return existing;

  let image: PreviewCaptureWriteFacts["image"] = null;
  const blobStore = createLocalDiskBlobStore();
  if (input.screenshot && input.screenshot.byteLength > 0) {
    if (input.screenshot.byteLength > CAPTURE_MAX_BYTES) {
      throw new Error(
        `[cms-preview-capture-store] screenshot is ${input.screenshot.byteLength} bytes, exceeds the ${CAPTURE_MAX_BYTES}-byte cap`,
      );
    }
    const representationRevisionId = randomUUID();
    const bytes = input.screenshot;
    const put = await blobStore.put({
      orgId: input.orgId,
      artifactId: captureArtifactId,
      representationRevisionId,
      stream: (async function* () {
        yield bytes;
      })(),
      declaredMime: CAPTURE_MIME,
      maxBytes: CAPTURE_MAX_BYTES,
    });
    image = {
      representationRevisionId,
      resourceId: randomUUID(),
      blobId: put.blobId,
      substanceKey: deriveSubstanceKey({ kind: "blob", sha256: put.sha256 }),
      storageKey: put.storageKey,
      sha256: put.sha256,
      sizeBytes: bytes.byteLength,
    };
  }

  const facts: PreviewCaptureWriteFacts = {
    orgId: input.orgId,
    captureArtifactId,
    createdBy: input.createdBy ?? null,
    producerRunId: input.producerRunId ?? null,
    data: input.data,
    image,
  };

  try {
    runPostgresQueriesSync({
      connectionString: conn(),
      transaction: true,
      queries: buildPreviewCaptureQueries(schema, facts),
    });
  } catch (err) {
    if (image) {
      // The write failed AFTER the content-addressed blob landed. Best-effort
      // delete (the object-content-snapshot residual class): a same-substance
      // future capture re-dedupes, and a disk orphan is reclaimed by the
      // artifact-blob-verifier sweep.
      await blobStore
        .deleteByStorageKey({ orgId: input.orgId, storageKey: image.storageKey })
        .catch(() => {});
    }
    if (isDuplicateKey(err)) {
      // A concurrent capture for the same (target, role) won between the
      // pre-read and this transaction. The deterministic PK rolled the WHOLE set
      // back — no orphan — so return the winner: one pinned capture, always.
      const winner = readPinnedPreviewCapture(input.orgId, captureArtifactId);
      if (winner) return winner;
    }
    throw err;
  }

  return {
    captureArtifactId,
    representationRevisionId: image?.representationRevisionId ?? null,
    data: input.data,
  };
}

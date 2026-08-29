import "server-only";

// ---------------------------------------------------------------------------
// THE EDITOR SAVE ROAD'S REAL PORTS (enabler 0.20, cinatra#3026).
//
// The road beside this file (`artifact-edit-save.ts`) decides; this module is
// the only place those decisions touch anything. Keeping them apart is what
// lets the decisions be proved without a database and lets this wiring stay
// small enough to read in one sitting.
//
// EVERY PORT IS TENANT-SCOPED. The organization comes from the caller's session,
// never from the request body, and every statement below carries it.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { ARTIFACT_CONTENT_CHANNEL_CAPS } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import type { ActorContext } from "@/lib/authz/actor-context";
import { requireAccess } from "@/lib/authz/require-access";
import { AuthzError } from "@/lib/authz/errors";

import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import { deriveSubstanceKey } from "./resource-store";
import { truncateToUtf8Bytes } from "./artifact-content-channel";
import { appendRepresentationWithExpectedBase } from "./representation-store";
import { buildArtifactEditAuditOp, buildArtifactEditWitnessOp } from "./artifact-edit-audit";
import type { ArtifactEditLatest, ArtifactEditSavePorts } from "./artifact-edit-save";

const schemaId = (): string => postgresSchema.replaceAll('"', '""');

/**
 * THE WRITE-RIGHTS CHECK, on the EXISTING artifact permission road.
 *
 * `artifact` + `update` is already the registry's `artifact.update` permission
 * (`src/lib/authz/registry.ts`) — the enabler's "editing needs write rights on
 * the artifact" needs no new authorization surface, and this lane adds none.
 * `requireAccess` throws `AuthzError` on deny and audits either way; the road
 * wants a boolean, so the throw is turned into one HERE and nowhere else.
 */
export function artifactEditMayWrite(input: {
  actor: ActorContext;
  orgId: string;
  artifactId: string;
}): () => Promise<boolean> {
  return async () => {
    try {
      await requireAccess(
        input.actor,
        {
          resourceType: "artifact",
          resourceId: input.artifactId,
          organizationId: input.orgId,
        },
        "update",
        { primitiveName: "artifact_edit_save" },
      );
      return true;
    } catch (error) {
      if (error instanceof AuthzError) return false;
      throw error;
    }
  };
}

/** The artifact's latest revision, with the form and mime the substrate holds. */
async function readLatest(input: {
  orgId: string;
  artifactId: string;
}): Promise<ArtifactEditLatest | null> {
  ensurePostgresSchema();
  const schema = schemaId();
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT rep.id, rep.revision, rep.resource_id, rep.form, r.mime
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r ON r.id = rep.resource_id AND r.org_id = rep.org_id
JOIN "${schema}"."objects" o ON o.id = rep.artifact_id AND o.org_id = rep.org_id
WHERE rep.org_id = $1 AND rep.artifact_id = $2 AND o.deleted_at IS NULL
ORDER BY rep.revision DESC
LIMIT 1`,
        values: [input.orgId, input.artifactId],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | { id: string; revision: number | string; resource_id: string; form: string; mime: string }
    | undefined;
  if (!row) return null;
  return {
    revisionId: String(row.id),
    revision: Number(row.revision),
    resourceId: String(row.resource_id),
    mime: String(row.mime),
    form: row.form as ArtifactEditLatest["form"],
  };
}

/**
 * ONE REVISION'S TEXT, read the way the content channel reads it — the same
 * cap and the same code-point-safe cut — so what the editor was HANDED and what
 * a save is compared AGAINST can never differ by a byte.
 */
async function readText(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<{ text: string; truncated: boolean } | null> {
  ensurePostgresSchema();
  const schema = schemaId();
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT b.storage_key, r.size_bytes
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r ON r.id = rep.resource_id AND r.org_id = rep.org_id
LEFT JOIN "${schema}"."artifact_blobs" b
  ON b.id = r.metadata->>'blobId' AND b.org_id = r.org_id
WHERE rep.org_id = $1 AND rep.artifact_id = $2 AND rep.id = $3
LIMIT 1`,
        values: [input.orgId, input.artifactId, input.representationRevisionId],
      },
    ],
  });
  const row = res?.rows?.[0] as { storage_key: string | null } | undefined;
  if (!row?.storage_key) return null;

  const store = createLocalDiskBlobStore();
  try {
    const handle = await store.openByStorageKey({
      orgId: input.orgId,
      storageKey: String(row.storage_key),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of handle.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const whole = Buffer.concat(chunks).toString("utf8");
    const cap = ARTIFACT_CONTENT_CHANNEL_CAPS.text;
    const truncated = Buffer.byteLength(whole, "utf8") > cap;
    return { text: truncated ? truncateToUtf8Bytes(whole, cap) : whole, truncated };
  } catch {
    return null;
  }
}

/**
 * Stream the change set into the store and return the resource that holds it.
 *
 * THE SAME THREE STAGES THE ARTIFACT WRITER USES, minus the ones an append does
 * not need: bytes first (orphan-safe, content-addressed), then the resource row
 * under the substance key, so identical text written twice is one resource. An
 * orphan resource is harmless by the store's own design — the next write of the
 * same bytes finds it again through the conflict clause — which is why this can
 * sit outside the append's transaction.
 */
async function writeBytes(input: {
  orgId: string;
  artifactId: string;
  text: string;
  mime: string;
  actor: string | null;
}): Promise<{ resourceId: string }> {
  ensurePostgresSchema();
  const schema = schemaId();
  const blobStore = createLocalDiskBlobStore();
  const blob = await blobStore.put({
    orgId: input.orgId,
    artifactId: input.artifactId,
    // Naming input for the store's legacy key scope only — a content-addressed
    // write keys off the digest, so this never becomes the row's identity.
    representationRevisionId: randomUUID(),
    stream: Readable.from([Buffer.from(input.text, "utf8")]),
    declaredMime: input.mime,
    maxBytes: ARTIFACT_CONTENT_CHANNEL_CAPS.text,
  });

  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      {
        text: `WITH resource_op AS (
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
SELECT r.id AS resource_id, r.metadata->>'storageKey' AS storage_key FROM resource_op r`,
        values: [
          randomUUID(),
          input.orgId,
          deriveSubstanceKey({ kind: "blob", sha256: blob.sha256 }),
          blob.mimeDetected,
          blob.sizeBytes,
          input.actor,
          blob.blobId,
          blob.storageKey,
          blob.sha256,
        ],
      },
    ],
  });
  const row = res?.rows?.[0] as { resource_id?: string; storage_key?: string | null } | undefined;
  if (!row?.resource_id || !row.storage_key) {
    throw new Error("artifact edit: resource upsert did not return a stored row");
  }
  return { resourceId: String(row.resource_id) };
}

/**
 * THE APPEND, with the edit's ledger rows in its own transaction.
 *
 * Both rows are spliced: the `edit` operation carrying the base and the new
 * revision, and the writer-provenance `create` witness every claimed-row read
 * gate tests for. A refusal takes both with it — the transaction aborts whole.
 */
function appendWithBase(): ArtifactEditSavePorts["appendWithBase"] {
  return async (input) => {
    const schema = schemaId();
    const result = await appendRepresentationWithExpectedBase({
      orgId: input.orgId,
      artifactId: input.artifactId,
      baseRevisionId: input.baseRevisionId,
      resourceId: input.resourceId,
      form: "file",
      createdBy: input.actor,
      additionalOps: (representationRevisionId) => [
        buildArtifactEditAuditOp(schema, {
          orgId: input.orgId,
          artifactId: input.artifactId,
          representationRevisionId,
          baseRepresentationRevisionId: input.baseRevisionId,
          baseRevision: input.baseRevision,
          revision: input.baseRevision + 1,
          actor: input.actor,
        }),
        buildArtifactEditWitnessOp(schema, {
          orgId: input.orgId,
          artifactId: input.artifactId,
          representationRevisionId,
          actor: input.actor,
        }),
      ],
    });
    if (result.kind === "appended") {
      return {
        kind: "appended",
        revisionId: result.record.id,
        revision: result.record.revision,
      };
    }
    return result;
  };
}

/** The real ports, for one actor's save on one artifact. */
export function artifactEditSavePorts(input: {
  actor: ActorContext;
  orgId: string;
  artifactId: string;
}): ArtifactEditSavePorts {
  return {
    mayWrite: artifactEditMayWrite(input),
    readLatest,
    readText,
    writeBytes,
    appendWithBase: appendWithBase(),
  };
}

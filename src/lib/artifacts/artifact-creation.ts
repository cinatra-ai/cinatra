import "server-only";
import { randomUUID } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { readChatThreadForClassifier } from "@/lib/database";
import type {
  ArtifactObjectData,
  ArtifactOriginKind,
  ArtifactRef,
} from "@cinatra-ai/artifacts";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";
import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import { deriveSubstanceKey } from "./resource-store";
import {
  type OwnerLevel,
  normalizeOwnerLevel,
} from "@/lib/authz/resource-ref";
// Artifact rows are objects rows. Artifact creation writes the objects row directly (not via
// upsertObjectAndEnqueue) so this writer must read the same project frame
// and apply the same substrate-exclusion rule. SEMANTIC_ARTIFACT_OBJECT_TYPE
// is NEVER substrate, so the helper will always propagate when a frame
// is active.
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { resolveProjectInheritanceForType } from "@/lib/project-inheritance";
// Sync archive gate. Reject artifact creation when the resolved projectId points at an archived row.
import { assertProjectWritableSync } from "@/lib/project-writable";
// Leaf-subpath import. NOT the heavy `@cinatra-ai/objects` barrel
// (which pulls mcp/registries surface).
import {
  composeAndValidateClassifierSignals,
  type ClassifierSignals,
} from "@cinatra-ai/objects/classifier-signals";
// The semantic FLOOR type id comes from the generated manifest data (the
// single "artifact-default-floor" role claimant) via the PURE-DATA
// @cinatra-ai/objects/artifact-floor subpath — no server-heavy objects
// barrel in the unit-test graph (the old inline-mirror rationale holds;
// the mirror itself is retired, cinatra#151 Stage 6).
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";
// Deterministic producer assertions resolve and org-validate BEFORE Tx2,
// then splice into Tx2 before the floor rebalance.
// `buildAssertSemanticTypeQueries` is the tx-composable builder
// (no self-lock / no floor rebalance / no outbox; Tx2 owns those).
import { resolveProducerAssertionPlan } from "./producer-assertions";
import {
  buildAssertSemanticTypeQueries,
  type AssertSemanticTypeResult,
} from "./semantic-assertion-store";

// Atomic creation on the semantic data model. The single artifact write path:
// blob → resource (dedupe) →
// objects+outbox (held lock) → representation (revision=1) → audit (write-
// here = create-provenance) → floor-rebalance
// asserts the default-artifact extension eligible (universal at creation).
//
// Two transactions:
//   Tx 1 — resource handling. Resource is an org-scoped substance-keyed
//   dedupe layer; an orphan resource (no representation pointing at it)
//   is harmless because the next upload of the same bytes finds it again
//   via ON CONFLICT. So this tx is OUTSIDE the per-artifact lock. The
//   single CTE chain captures the {fresh,dedupe} branch in SQL — no JS
//   branches inside the fixed query list.
//
//   Tx 2 — artifact creation. Held `pg_advisory_xact_lock(hashtext(
//   artifactId))` ensures the floor-rebalance INSERT is correct against
//   the live (post-objects-insert, post-representation-insert) state. A
//   2-tx read-decide-write can release the lock between reads and writes,
//   creating a stale floor decision that could commit default+Y both eligible.
//   Single held-lock-tx with SQL-recomputed decision is the correct pattern.
//
// Dedupe-loser blob bytes are post-tx-deleted via `deleteByStorageKey`
// best-effort. The byte-level orphan GC is `artifact_versions`-driven and
// does not reclaim semantic dedupe-loser files; the retention rebuild is
// the proper backstop.

const ARTIFACT_BLOB_MAX_DEFAULT_BYTES = 100 * 1024 * 1024; // soft default

export type CreateSemanticArtifactInput = {
  orgId: string;
  createdBy: string | null;
  // Ownership is REQUIRED. The service layer derives `organization`/orgId
  // for the upload route's public path.
  ownerLevel: OwnerLevel;
  ownerId: string;
  visibility?: string;
  title?: string;
  declaredMime?: string;
  originKind?: ArtifactOriginKind;
  parentId?: string;
  parentType?: string;
  stream: AsyncIterable<Uint8Array>;
  maxBytes?: number;
  createdByRunId?: string | null;
  // Opt-in HANDLE for the classifier-signal intake path. The service resolves
  // the handle via the tenant-safe reader (`readChatThreadForClassifier`) and
  // composes the persisted `ClassifierSignals` blob server-side. Callers do
  // NOT pass a pre-built signals blob because that would be a smuggling
  // vector. Resolution failure (legacy/denied/cross-tenant) silently OMITS
  // chatContext from signals; the upload still succeeds (best-effort intake).
  chatContextSource?: { threadId: string };
  /**
   * Defer matchers during the authoring transaction.
   *
   * When true, skip the post-tx2 `ARTIFACT_MATCH_RUN` enqueue. Set by
   * callers that have ALREADY typed the artifact deterministically (the
   * template and chat-authoring paths) — the matcher would be a no-op anyway
   * (precedence-blocked by the producer assertion) and skipping it avoids:
   *
   *   (a) a wasted BullMQ job + worker turn + LLM scoring call;
   *   (b) a race between artifact-creation Tx2 commit and the
   *       caller's follow-up `assertSemanticType` call (the matcher
   *       can otherwise observe the artifact before the typed
   *       assertion is written and write a precedence-doomed draft).
   *
   * NEVER set by the upload route — uploads MUST run the matcher.
   * Default false to preserve existing behavior.
   */
  skipFallbackClassification?: boolean;
  /**
   * Optional authoring-ledger step id. When the caller is wrapping a
   * `recordAuthoringInvocation` step around its create, supplying the
   * step id here threads a linkage row into `authoring_step_artifacts`
   * inside Tx 2 — atomic with the artifact + representation create. If the
   * linkage INSERT fails (e.g., FK to a deleted step), the entire Tx 2
   * rolls back and the artifact does NOT commit. This is the canonical
   * source for the workflow artifact-binding traversal: the engine walks
   * the ledger downward from the agent_task's root step to find emitted
   * artifacts.
   */
  authoringStepId?: string | null;
};

export type CreateSemanticArtifactResult = {
  /** @deprecated alias for back-compat — equals `artifactId`. */
  objectId: string;
  artifactId: string;
  resourceId: string;
  representationRevisionId: string;
  representationRevision: number;
  ref: ArtifactRef;
};

export class ResourceOrphanedError extends Error {
  readonly code = "RESOURCE_ORPHANED_NO_STORAGE_BINDING";
  constructor(message: string) {
    super(message);
    this.name = "ResourceOrphanedError";
  }
}

export async function createSemanticArtifact(
  input: CreateSemanticArtifactInput,
): Promise<CreateSemanticArtifactResult> {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  const artifactId = randomUUID();
  const representationRevisionId = randomUUID();
  const preallocatedResourceId = randomUUID();

  const ownerLevelNorm = normalizeOwnerLevel(input.ownerLevel);
  const visibility =
    input.visibility ?? defaultVisibilityFor(ownerLevelNorm, input.ownerId);
  const originKind: ArtifactOriginKind = input.originKind ?? "upload";
  const maxBytes = input.maxBytes ?? ARTIFACT_BLOB_MAX_DEFAULT_BYTES;

  // -------------------------------------------------------------------
  // Pre-tx: write blob bytes to disk (orphan-safe). The scope used is
  // the just-allocated (artifactId, representationRevisionId) — even if
  // dedupe later wins, the path is unique and easy to garbage-collect.
  // -------------------------------------------------------------------
  const blobStore = createLocalDiskBlobStore();
  const newBlob = await blobStore.put({
    orgId: input.orgId,
    artifactId,
    representationRevisionId,
    stream: input.stream,
    declaredMime: input.declaredMime,
    maxBytes,
  });

  const substanceKey = deriveSubstanceKey({
    kind: "blob",
    sha256: newBlob.sha256,
  });

  let authoritative: {
    resourceId: string;
    mime: string;
    sizeBytes: number;
    storageKey: string;
    blobId: string;
    isDedupe: boolean;
  };

  try {
    // ---------------------------------------------------------------
    // Tx 1 — resource handling. ONE CTE chain expresses the
    // fresh-vs-dedupe branch entirely in SQL (no JS conditional
    // inside the fixed query list).
    // ---------------------------------------------------------------
    // PostgreSQL data-modifying CTEs share one snapshot, so a follow-on
    // UPDATE cannot see the row INSERT from the same statement. Bake the
    // storage_key/blobId into the INSERT VALUES so metadata lands on the
    // FRESH row in one statement. ON CONFLICT preserves the existing row's
    // metadata (DO UPDATE SET org_id = EXCLUDED.org_id is a no-op touch that
    // does NOT overwrite metadata; substance identity is immutable, and a
    // changed metadata would be a different substance with a different key).
    const [resourceRes] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [
        {
          // The artifact_blobs presence check lives outside this CTE. PG
          // data-modifying CTEs share one snapshot, so under
          // concurrent same-substance uploads Tx B's EXISTS could not
          // see Tx A's just-committed blob row → spurious orphan
          // false-positive. The check now happens in a SEPARATE
          // statement AFTER this transaction commits, where the
          // snapshot is fresh.
          text: `WITH resource_op AS (
  INSERT INTO "${schema}"."resource"
    (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
  VALUES ($1::text, $2::text, 'blob', $3::text, $4::text, $5::bigint, $6::text,
          jsonb_build_object('storageKey', $8::text, 'blobId', $7::text))
  ON CONFLICT (org_id, kind, substance_key) DO UPDATE SET org_id = EXCLUDED.org_id
  RETURNING id, org_id, mime, size_bytes, metadata, (xmax = 0) AS is_new
),
blob_insert AS (
  -- Explicit ::text / ::bigint casts on every parameter in the SELECT-list.
  -- Without them, PostgreSQL cannot deduce the type of $4 / $5 / $6 / $9 in
  -- this SELECT context (the INSERT…SELECT column-coercion happens AFTER
  -- the SELECT list is typed, so bare \`$4\` is "unknown" at parse time and
  -- pg rejects with \`could not determine data type of parameter $4\`).
  -- Without the cast set, every \`artifact_authoring_emit\` call from chat
  -- fails with this error.
  INSERT INTO "${schema}"."artifact_blobs"
    (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
  SELECT $7::text, $2::text, 'local-disk', $8::text, $9::text, $5::bigint, $4::text, $6::text
  WHERE EXISTS (SELECT 1 FROM resource_op WHERE is_new)
  RETURNING id
)
SELECT
  r.id                          AS resource_id,
  r.mime                        AS mime,
  r.size_bytes                  AS size_bytes,
  r.metadata->>'storageKey'     AS storage_key,
  r.metadata->>'blobId'         AS blob_id,
  r.is_new                      AS is_new
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
      | {
          resource_id: string;
          mime: string;
          size_bytes: string | number;
          storage_key: string | null;
          blob_id: string | null;
          is_new: boolean;
        }
      | undefined;
    if (!row) {
      throw new Error(
        "resource upsert did not return a row (cross-tenant collision or DB anomaly)",
      );
    }
    // The storage_key / blob_id columns are nullable (an existing row with
    // `metadata = '{}'` returns null
    // for `metadata->>'storageKey'`). `String(null) === "null"`, which
    // is a non-empty truthy value — that masked the orphan guard. Check
    // raw nullness BEFORE any String() coercion so the guard actually
    // fires on a `{}`-metadata legacy row.
    const rawStorageKey =
      typeof row.storage_key === "string" && row.storage_key.length > 0
        ? row.storage_key
        : null;
    const rawBlobId =
      typeof row.blob_id === "string" && row.blob_id.length > 0
        ? row.blob_id
        : null;
    if (row.is_new && (rawStorageKey === null || rawBlobId === null)) {
      // Should never happen on a fresh insert (the INSERT VALUES bake
      // the metadata) but if a future schema migration breaks the
      // invariant, fail loud rather than create an unservable artifact.
      throw new ResourceOrphanedError(
        `freshly minted resource ${row.resource_id} has empty metadata — DB invariant broken`,
      );
    }
    if (!row.is_new && (rawStorageKey === null || rawBlobId === null)) {
      // Existing resource row with no storage binding. Refuse to bind a new
      // representation to an orphaned resource; an operator must either fix
      // the metadata or delete the resource row first.
      throw new ResourceOrphanedError(
        `existing resource ${row.resource_id} has no storage_key/blobId metadata — refusing to bind a new representation`,
      );
    }
    authoritative = {
      resourceId: String(row.resource_id),
      mime: String(row.mime),
      sizeBytes:
        typeof row.size_bytes === "number"
          ? row.size_bytes
          : Number(row.size_bytes),
      // Safe non-null coercion — the orphan guard above already rejected
      // the null branches.
      storageKey: rawStorageKey as string,
      blobId: rawBlobId as string,
      isDedupe: !row.is_new,
    };
    // Validate that the artifact_blobs row referenced by
    // resource.metadata.blobId actually exists, in a SEPARATE statement
    // (fresh snapshot). The Tx1 CTE-internal EXISTS would suffer from PG's
    // shared-statement snapshot: a concurrent same-substance upload could be
    // ON CONFLICT-resolved through us before its blob row was visible to our
    // snapshot, producing a spurious orphan false-positive. Doing the read
    // after the resource UPSERT commits eliminates that race.
    //
    // Only required on DEDUPE: a fresh INSERT just wrote artifact_blobs
    // in the same tx via `blob_insert`, so the row is committed by the
    // time we get here (the same connection's prior tx already
    // returned). On DEDUPE the row was written long ago by whichever
    // process minted the existing resource; we re-verify.
    if (authoritative.isDedupe) {
      const [blobRes] = runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `SELECT 1 FROM "${schema}"."artifact_blobs"
WHERE org_id = $1 AND id = $2 LIMIT 1`,
            values: [input.orgId, authoritative.blobId],
          },
        ],
      });
      if (!(blobRes?.rows && blobRes.rows.length > 0)) {
        throw new ResourceOrphanedError(
          `resource ${authoritative.resourceId} metadata.blobId=${authoritative.blobId} points at a missing artifact_blobs row — refusing to bind a new representation`,
        );
      }
    }
  } catch (err) {
    // Pre-tx-2 failure → the new blob bytes are unreferenced. Best-effort
    // delete; if it fails the retention rebuild will reclaim it.
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
    throw err;
  }

  // -------------------------------------------------------------------
  // `objects.data` (the projection mirror — Graphiti + UI listing read
  // this). latestRepresentationRevisionId is the current representation
  // pointer. MIME + size come from the AUTHORITATIVE resource row; on
  // dedupe, ref.mime MUST equal resource.mime or the attachment resolver
  // mime-equality check fails.
  // -------------------------------------------------------------------

  // Server-side composition of `ClassifierSignals` BEFORE the
  // artifact-creation tx commits, so the signals row goes in atomically
  // with the representation row. The composition pipeline:
  //   1) resolve `chatContextSource.threadId` via the tenant-safe
  //      reader (deny-by-default; null on legacy/cross-user/wrong-org);
  //   2) compose with the upload-side metadata already in `input`;
  //   3) run `composeAndValidateClassifierSignals` (strict-schema parse
  //      → dedupe → byte cap).
  // Resolution failure is BEST-EFFORT: chatContext is dropped from the
  // signals payload; the upload still succeeds. The actor identifier
  // for the chat read is `input.createdBy` (the authoritative actor of
  // the artifact-creation tx).
  let composedClassifierSignals: ReturnType<typeof composeAndValidateClassifierSignals> | null = null;
  try {
    // Build the upload-side signals from authoritative values (NOT raw
    // request headers). `parentId`/`parentType` flow from the caller;
    // `filename`/`declaredMime`/`originKind`/`sizeBytes` from the
    // resolved blob + caller's typed input.
    const uploadSignals: ClassifierSignals["upload"] = {
      filename: input.title,
      declaredMime: input.declaredMime,
      originKind,
      parentId: input.parentId,
      parentType: input.parentType,
      sizeBytes: authoritative.sizeBytes,
    };
    let chatContext: ClassifierSignals["chatContext"] | undefined;
    if (input.chatContextSource?.threadId && input.createdBy) {
      // Static import (cinatra#104): this module ALREADY has database.ts in
      // its static import graph, and database.ts is an ASYNC module under
      // Turbopack dev — a runtime `require("@/lib/database")` returns the
      // module's Promise (all exports `undefined`), which made this block
      // silently drop chatContext on every upload (TypeError swallowed by
      // the fail-soft catch below).
      const resolved = readChatThreadForClassifier({
        threadId: input.chatContextSource.threadId,
        actorUserId: input.createdBy,
        activeOrgId: input.orgId,
      });
      if (resolved && resolved.messages.length > 0) {
        chatContext = {
          threadId: resolved.threadId,
          messages: resolved.messages,
        };
      }
    }
    const candidateSignals: ClassifierSignals = {
      chatContext,
      upload: uploadSignals,
    };
    composedClassifierSignals = composeAndValidateClassifierSignals(
      candidateSignals,
    );
  } catch {
    // composer threw (malformed input) — fail-soft: persist NULL so the
    // upload still succeeds. The matcher tolerates absent signals.
    composedClassifierSignals = null;
  }

  // Resolve + ORG-VALIDATE the deterministic producer-assertion plan BEFORE
  // Tx2. A missing or
  // cross-org `createdByRunId` yields `validatedRunId: null` (we then
  // persist NULL into representation.created_by_run_id — never a
  // cross-tenant run id) and an empty `produces`. Never throws;
  // failure degrades to no producer assertions (the LLM matcher is
  // the fallback).
  const producerPlan = await resolveProducerAssertionPlan({
    createdByRunId: input.createdByRunId,
    orgId: input.orgId,
  });
  // The run id actually persisted into the representation row — the
  // validated one (or NULL when the run was missing / cross-org).
  const persistedRunId = producerPlan.validatedRunId;
  // Build the tx-composable producer assertion ops (assertedBy:"agent"
  // — the highest-confidence deterministic source). One archive +
  // insert-RETURNING pair per produced extension. The default-floor
  // type was already filtered out in resolveProducerAssertionPlan so
  // `buildAssertSemanticTypeQueries` cannot throw here.
  const producerSplice = producerPlan.produces.map((extension) =>
    buildAssertSemanticTypeQueries({
      orgId: input.orgId,
      artifactId,
      extension,
      assertedBy: "agent",
    }),
  );

  const objectData: ArtifactObjectData = {
    artifactType: "file",
    latestRepresentationRevisionId: representationRevisionId,
    latestDigest: newBlob.sha256,
    mime: authoritative.mime,
    size: authoritative.sizeBytes,
    originKind,
    viewerHint: "mime",
    title: input.title,
  };

  // Archive gate. Resolved projectId is non-NULL iff the frame is active
  // AND the type is not on the substrate exclusion list (semantic artifacts
  // are NEVER substrate, so when a frame is set this fires). When
  // projectIdForRow is set and the target project is archived, reject before
  // opening the held-lock tx.
  {
    const projectIdForRow = resolveProjectInheritanceForType(
      mcpRequestContextStorage.getStore()?.projectContext?.projectId,
      SEMANTIC_ARTIFACT_OBJECT_TYPE,
    );
    if (projectIdForRow !== null) {
      assertProjectWritableSync(projectIdForRow);
    }
  }
  // The producer assertion ops (archive + insert-RETURNING per produced
  // extension) are spliced AFTER the artifact_audit INSERT and BEFORE the
  // floor-rebalance INSERT so the floor's `WHERE NOT EXISTS (... eligibility=
  // 'eligible' AND extension <> default)` sees the producer's agent-asserted
  // eligible row and correctly SKIPS the default. They run inside the SAME
  // held-lock Tx2 so producer assertion + creation commit atomically.
  const producerOps = producerSplice.flatMap((p) => p.queries);
  // Fixed leading-query count before the producer ops: lock(1) +
  // objects/outbox(1) + representation(1) + audit(1) = 4. Each
  // `buildAssertSemanticTypeQueries` contributes exactly 2 ops
  // (archive, insert-RETURNING) — parseResult locates its
  // insert-RETURNING relative to the spliced offset.
  const PRODUCER_OPS_OFFSET = 4;
  // `tx2Results` is hoisted OUT of the try so producer-outcome parsing
  // happens POST-COMMIT in a best-effort block. A parse/offset throw must
  // NOT be conflated with a Tx2 failure, which would create a false
  // failed-upload and duplicate on retry.
  let tx2Results:
    | ReturnType<typeof runPostgresQueriesSync>
    | undefined;

  try {
    // ---------------------------------------------------------------
    // Tx 2 — held-lock artifact creation. The advisory lock on
    // hashtext(artifactId) keeps the floor-rebalance correct against
    // the live state, mirroring the canonical pattern in
    // `semantic-assertion-store.ts:runOneLockedTx`.
    // ---------------------------------------------------------------
    tx2Results = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [
        {
          text: `SELECT pg_advisory_xact_lock(hashtext($1))`,
          values: [artifactId],
        },
        // objects + outbox via the single-CTE pattern (objects-store.ts
        // invariant — outbox INSERT only fires when the upsert actually
        // wrote, so a cross-tenant collision NEVER spawns a phantom
        // projector job).
        //
        // Plain INSERT (no ON CONFLICT). The artifactId is a freshly minted
        // UUID, so a primary-key collision is essentially impossible — but
        // if it ever did happen, silent DO NOTHING would commit
        // representation/audit/assertion rows pointing at an artifactId that
        // did NOT actually get an objects row. Letting the duplicate-key
        // error throw rolls back the entire Tx2 (held-lock tx) cleanly.
        {
          text: `WITH upserted AS (
  INSERT INTO "${schema}"."objects"
    (id, type, parent_id, parent_type, data, created_by, org_id, source,
     graphiti_sync_status, version, owner_level, owner_id, visibility,
     project_id)
  VALUES ($1::text, $2::text, $3::text, $4::text, $5::jsonb, $6::text, $7::text, 'route',
          'pending', 1, $8::text, $9::text, $10::text,
          $11::text)
  RETURNING id, version, org_id
)
INSERT INTO "${schema}"."graphiti_projection_outbox"
  (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
SELECT gen_random_uuid()::text, upserted.id, upserted.version, upserted.org_id,
       'upsert', NULL, 'pending', 0
FROM upserted`,
          values: [
            artifactId,
            SEMANTIC_ARTIFACT_OBJECT_TYPE,
            input.parentId ?? null,
            input.parentType ?? null,
            JSON.stringify(objectData),
            input.createdBy ?? null,
            input.orgId,
            ownerLevelNorm,
            input.ownerId,
            visibility,
            // Artifact inherits projectId from the active
            // mcpRequestContextStorage frame. The SEMANTIC_ARTIFACT_OBJECT_TYPE
            // is never on the substrate exclusion list, so the helper returns
            // the frame projectId verbatim (or null when no frame is active).
            resolveProjectInheritanceForType(
              mcpRequestContextStorage.getStore()?.projectContext?.projectId,
              SEMANTIC_ARTIFACT_OBJECT_TYPE,
            ),
          ],
        },
        // Representation (revision=1 at creation — the append-only table is
        // empty for this artifactId). `classifier_signals` carries the
        // server-composed intake signals for the matcher to consume; NULL
        // when no chatContext handle was supplied (back-compat invariant).
        {
          text: `INSERT INTO "${schema}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, classifier_signals)
VALUES ($1::text, $2::text, $3::text, $4::text, 1, 'file', $5::text, $6::text, $7::jsonb)`,
          values: [
            representationRevisionId,
            input.orgId,
            artifactId,
            authoritative.resourceId,
            input.createdBy ?? null,
            // The ORG-VALIDATED run id (NULL when the run was missing /
            // cross-org). NEVER the raw caller-supplied `input.createdByRunId`;
            // that would persist an unvalidated / cross-tenant provenance
            // pointer.
            persistedRunId,
            composedClassifierSignals
              ? JSON.stringify(composedClassifierSignals)
              : null,
          ],
        },
        // Audit row — representation_revision_id is the representation pin.
        {
          text: `INSERT INTO "${schema}"."artifact_audit"
  (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
VALUES (gen_random_uuid()::text, $1::text, $2::text, $3::text, 'create', $4::text, $5::jsonb)`,
          values: [
            input.orgId,
            artifactId,
            representationRevisionId,
            input.createdBy ?? null,
            JSON.stringify({
              mime: authoritative.mime,
              size: authoritative.sizeBytes,
              originKind,
              dedupe: authoritative.isDedupe,
            }),
          ],
        },
        // Producer assertion ops spliced HERE (after audit, before floor
        // rebalance). Empty when there is no trusted producer.
        ...producerOps,
        // Floor-rebalance INSERT: at creation, NO non-default eligible
        // AND NO active default, so this universally inserts the
        // default-artifact eligible assertion. (The complementary
        // UPDATE-archive-default branch is a no-op at creation but
        // still cheap; we include it for shape parity with the
        // canonical floor-rebalance in semantic-assertion-store.)
        {
          text: `INSERT INTO "${schema}"."semantic_assertion"
  (id, org_id, artifact_id, extension, asserted_by, eligibility)
SELECT $1::text, $2::text, $3::text, $4::text, 'agent', 'eligible'
WHERE NOT EXISTS (
  SELECT 1 FROM "${schema}"."semantic_assertion"
   WHERE org_id=$2::text AND artifact_id=$3::text AND eligibility='eligible' AND extension <> $4::text)
AND NOT EXISTS (
  SELECT 1 FROM "${schema}"."semantic_assertion"
   WHERE org_id=$2::text AND artifact_id=$3::text AND extension=$4::text AND eligibility <> 'archived')`,
          values: [
            randomUUID(),
            input.orgId,
            artifactId,
            DEFAULT_ARTIFACT_EXTENSION,
          ],
        },
        {
          text: `UPDATE "${schema}"."semantic_assertion" SET eligibility='archived', archived_at=now()
WHERE org_id=$1 AND artifact_id=$2 AND extension=$3 AND eligibility <> 'archived'
AND EXISTS (
  SELECT 1 FROM "${schema}"."semantic_assertion"
   WHERE org_id=$1 AND artifact_id=$2 AND eligibility='eligible' AND extension <> $3)`,
          values: [input.orgId, artifactId, DEFAULT_ARTIFACT_EXTENSION],
        },
        // Optional authoring-ledger linkage. When the caller supplies an
        // `authoringStepId`, INSERT a row tying the just-created
        // (artifactId, representationRevisionId) to the ledger step. The
        // FK enforces step existence; a failure rolls back Tx 2 with the
        // artifact + representation + assertion rows, returning a
        // structured Postgres error to the caller.
        ...(input.authoringStepId
          ? [
              {
                text: `INSERT INTO "${schema}"."authoring_step_artifacts"
  (authoring_step_id, org_id, artifact_id, representation_revision_id)
VALUES ($1::text, $2::text, $3::text, $4::text)`,
                values: [
                  input.authoringStepId,
                  input.orgId,
                  artifactId,
                  representationRevisionId,
                ],
              },
            ]
          : []),
      ],
    });
  } catch (err) {
    // Tx2 failed AFTER Tx1 committed.
    //  - DEDUPE hit (isDedupe=true): the new blob bytes on disk were
    //    NEVER bound to any DB row (no artifact_blobs INSERT happened;
    //    the existing resource still owns the canonical bytes). The new
    //    bytes are an unreferenced duplicate — delete.
    //  - FRESH Tx1 (isDedupe=false): the new resource row AND the new
    //    artifact_blobs row are committed and point at this storage_key.
    //    Deleting the bytes would poison future dedupe hits (a same-
    //    substance upload would dedupe to a resource whose canonical
    //    bytes were deleted). DO NOT delete — the artifact_blobs row
    //    owns the bytes for future dedupes; only the artifact rollup
    //    (objects + representation + audit) failed and is rolled back.
    if (authoritative.isDedupe) {
      await blobStore
        .deleteByStorageKey({
          orgId: input.orgId,
          storageKey: newBlob.storageKey,
        })
        .catch(() => {});
    }
    throw err;
  }

  // -------------------------------------------------------------------
  // Post-tx: if dedupe won, the new blob bytes on disk are an
  // unreferenced duplicate. Best-effort delete. The retention rebuild is the
  // proper backstop for any residual disk leak; byte-level orphan GC is
  // `artifact_versions`-driven and does not see semantic dedupe-loser files.
  // -------------------------------------------------------------------
  if (authoritative.isDedupe) {
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
  }

  // POST-COMMIT producer-outcome parsing/logging. Tx2 has already committed
  // atomically; this is observability ONLY. A parse throw here (e.g. a future
  // splice-offset regression) MUST NOT fail the already-successful creation;
  // `interpretInsertResult`'s loud throw still surfaces in dev/CI via the
  // source-shape + unit tests, but production never converts it into a
  // duplicate-artifact retry.
  if (tx2Results && producerSplice.length > 0) {
    try {
      producerSplice.forEach((p, i) => {
        const outcome: AssertSemanticTypeResult = p.parseResult(
          tx2Results as ReturnType<typeof runPostgresQueriesSync>,
          PRODUCER_OPS_OFFSET + i * 2,
        );
        const ext = producerPlan.produces[i];
        console.info(
          outcome.inserted
            ? `[producer-assertions] asserted ${ext} (agent) on artifact ${artifactId}`
            : `[producer-assertions] ${ext} (agent) blocked by precedence on artifact ${artifactId} — skipped`,
        );
      });
    } catch (parseErr) {
      console.error(
        `[producer-assertions] post-commit outcome parse failed for artifact ${artifactId} (creation already committed; observability-only):`,
        parseErr instanceof Error ? parseErr.message : parseErr,
      );
    }
  }

  // POST-COMMIT enqueue of the async LLM artifact matcher. Tx2 has
  // committed, so a separate worker connection sees the row. The matcher is
  // a best-effort classification FALLBACK; agent-produced artifacts were
  // already typed deterministically by the producer splice above, and the
  // matcher's `matcher`-draft is precedence-blocked for those (expected
  // no-op). Enqueue failure logs and continues: the artifact is persisted,
  // and the artifact stays at its default-floor type until a future
  // re-trigger. attempts:3 + exponential backoff cover transient queue
  // infrastructure failures only; the matcher worker itself swallows every
  // error (best-effort / default-floor contract), so a classification failure
  // does NOT fail the job or trigger a retry.
  //
  // `skipFallbackClassification` lets the authoring paths skip the matcher
  // entirely. Those paths type the artifact via their own typed
  // `assertSemanticType` call AFTER createSemanticArtifact returns, so the
  // matcher would (a) waste a job and (b) race with the typed assertion.
  // Upload route NEVER sets this flag.
  if (input.skipFallbackClassification) {
    // Explicit caller opt-out. The producer assertion in the caller is the
    // authoritative type; the matcher's draft would be precedence-blocked
    // anyway. Skip the job entirely.
  } else {
    try {
    const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } = await import(
      "@/lib/background-jobs"
    );
    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.ARTIFACT_MATCH_RUN,
      {
        orgId: input.orgId,
        artifactId,
        representationRevisionId,
        createdByRunId: persistedRunId,
      },
      {
        // Stable jobId — BullMQ dedups a duplicate enqueue for the
        // same (org, artifact, representation) so a retry of the
        // creating request cannot fan out two matcher runs.
        jobId: `artifact-match:${input.orgId}:${artifactId}:${representationRevisionId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        // System-scope enqueue from the creation path — opt out of
        // the HumanUser auto-attribution cascade (the matcher builds
        // its own org-anchored System actor).
        inheritActorContext: false,
      },
    );
    } catch (enqueueErr) {
      console.warn(
        `[artifact-matcher] enqueue failed for artifact ${artifactId} (creation committed; classification deferred):`,
        enqueueErr instanceof Error ? enqueueErr.message : enqueueErr,
      );
    }
  }

  const ref: ArtifactRef = {
    artifactId,
    representationRevisionId,
    digest: newBlob.sha256,
    mime: authoritative.mime,
    originKind,
  };
  return {
    objectId: artifactId, // deprecated alias
    artifactId,
    resourceId: authoritative.resourceId,
    representationRevisionId,
    representationRevision: 1,
    ref,
  };
}

// `buildOwnershipFilter()` matches team-owned rows on visibility =
// `team:<teamId>` (NOT bare `"team"`). Same goes for user-owned rows
// (`user:<userId>`). The bare-string defaults silently hid team/user-owned
// artifacts from their owners.
function defaultVisibilityFor(ownerLevel: OwnerLevel, ownerId: string): string {
  switch (ownerLevel) {
    case "user":
      return `user:${ownerId}`;
    case "team":
      return `team:${ownerId}`;
    case "organization":
      return "org";
    case "workspace":
      return "workspace";
  }
}

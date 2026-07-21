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
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isArtifactExtensionWriteAllowed } from "./artifact-extension-access";
import { mimeAcceptedByAccepts } from "./upload-artifact-type-map";

/** The registry definition shape (or null) — a local alias so this module needs
 *  no type-only barrel import (avoids the heavy objects barrel graph). */
type ResolvedObjectTypeDef = ReturnType<typeof objectTypeRegistry.resolve>;
import { createLocalDiskBlobStore } from "./local-disk-blob-store";
import { deriveSubstanceKey } from "./resource-store";
import {
  type OwnerLevel,
  normalizeOwnerLevel,
} from "@/lib/authz/resource-ref";
import {
  type CanonicalVisibility,
  isCanonicalVisibility,
} from "@/lib/derived-store-ownership";
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
// Deterministic producer assertions resolve and org-validate BEFORE Tx2,
// then splice into Tx2 before the floor rebalance.
// `buildAssertSemanticTypeQueries` is the tx-composable builder
// (no self-lock / no floor rebalance / no outbox; Tx2 owns those).
import { resolveProducerAssertionPlan } from "./producer-assertions";
import {
  buildAssertSemanticTypeQueries,
  type AssertSemanticTypeResult,
} from "./semantic-assertion-store";
// Canonical binding reconcile, composed INTO Tx2 (cinatra#1868). Artifact
// creation writes the objects row DIRECTLY (see the module header), so it never
// rides the `binding_reconcile_enqueue` CTE the ordinary `upsertObjectAndEnqueue`
// path carries — without this splice a run-materialized CLAIM-BACKED row is
// minted with no binding assertion at all, and every claimed-row reader gate
// (context-resolver `is_claimed`, `validateTripleCoherence`'s binding branch,
// `finalizeContextSelectionPin`) keys off exactly that assertion. See the Tx2
// splice site below.
import { buildBindingReconcileQueries } from "@/lib/objects/binding-write-path";

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
// best-effort — but ONLY when the loser key differs from the winner key.
// With content-addressed keys (cinatra#926) a same-org semantic dedupe
// lands on the SAME final file (nothing to remove; removing would unlink
// the winner's bytes), and any content-addressed removal is reachability-
// guarded inside the store. The verifier reports residual orphans; the
// retention rebuild is the proper backstop.

const ARTIFACT_BLOB_MAX_DEFAULT_BYTES = 100 * 1024 * 1024; // soft default

export type CreateSemanticArtifactInput = {
  orgId: string;
  /**
   * REQUIRED exact declared object type (epic #1785, wave A3). The generic
   * `@cinatra-ai/artifact:object` catch-all is retired: every artifact row is
   * written under its concrete installed artifact type, validated BEFORE any
   * blob IO (`assertWritableArtifactType`): not a generic literal, defined by an
   * installed `kind:"artifact"` extension (`def.isArtifact` present), that
   * extension is write-eligible for this org, and the object payload satisfies
   * the type's declared schema. An unregistered / ungoverned / generic type is
   * REFUSED via the `OBJECTS_TYPE_NOT_REGISTERED` contract before the writer
   * touches the blob store. Deterministic callers pass their exact declared type
   * (`resolveBoundArtifactTarget`); the upload route + URL import map their MIME
   * to the exactly-one system-base pack (`resolveUploadArtifactType`) or refuse.
   */
  objectType: string;
  createdBy: string | null;
  // Ownership is REQUIRED. The service layer derives `organization`/orgId
  // for the upload route's public path.
  ownerLevel: OwnerLevel;
  ownerId: string;
  /**
   * Canonical visibility ONLY ('private' | 'team' | 'organization' |
   * 'public'). The composite-string vocabulary ('org', 'workspace',
   * 'team:<id>', ...) is retired (cinatra#1428, one-shot cutover via
   * core__0033); a non-canonical value throws at the entry boundary.
   * Omitted ⇒ the owner level's canonical default.
   */
  visibility?: CanonicalVisibility;
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
  /**
   * Restrict the deterministic producer assertion to ONE declared extension
   * (cinatra#923). The legacy behavior splices the run package's ENTIRE
   * `produces` list onto every created artifact — correct for a
   * single-output emit, wrong for a multi-produce agent (each output would
   * get every declared type). When set, the plan asserts ONLY this
   * extension, still validated through `resolveProducerAssertionPlan`
   * (run-org validation + manifest `produces` membership + the CG-4
   * install-active write gate); when the extension does not survive that
   * validation the write degrades to NO producer assertion — exactly
   * today's fail-soft. Unset ⇒ existing whole-`produces` behavior.
   */
  producerAssertionExtension?: string;
  /**
   * The declared type's accepted file MIME forms, when the caller already
   * resolved them (epic #1785, wave A3). The writer enforces the persisted
   * (dedupe-authoritative) MIME against the type's declared accepts. A
   * SELF-registered artifact type carries its accepts on the registered
   * definition (`isArtifact.accepts`), so this is redundant for those; a
   * CLAIM-BACKED HOST type (e.g. `@cinatra-ai/email:body`) carries NO accepts on
   * its registered definition, so the deterministic caller passes the accepts it
   * resolved via `resolveBoundArtifactTarget` here to keep the MIME enforcement
   * as defense-in-depth. Absent ⇒ enforcement uses the registered definition's
   * accepts (or is skipped when neither is known).
   */
  expectedAcceptMimes?: readonly string[];
  /**
   * Tx-composable follow-on queries appended at the END of Tx 2
   * (cinatra#923 — the materialization-ledger finalize op). Called AFTER
   * the artifact/representation ids are allocated but BEFORE Tx 2 opens;
   * the returned queries commit atomically with the artifact write (a
   * failure rolls back the whole creation). Results of these queries are
   * NOT parsed — keep them write-only.
   */
  additionalTx2Queries?: (ids: {
    artifactId: string;
    representationRevisionId: string;
  }) => Array<{ text: string; values: unknown[] }>;
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

/**
 * Fail-closed write-boundary refusal (epic #1785, wave A3). Carries the stable
 * `OBJECTS_TYPE_NOT_REGISTERED` code (the same contract the MCP `objects_save`
 * handler surfaces) so a route / caller can map a refused write to a client
 * error, never a transient 500. A refused write is a client/authoring error —
 * retrying the identical save fails identically.
 */
export class ObjectsTypeNotRegisteredError extends Error {
  readonly code = "OBJECTS_TYPE_NOT_REGISTERED" as const;
  readonly retryable = false;
  /**
   * For an UPLOAD refusal (createUploadedArtifact), the structured reason the
   * MIME could not be typed — `no_mime` | `no_type` | `ambiguous` (cinatra#1890,
   * A2). The upload route's refusal-advisory channel branches on this instead of
   * parsing the message: only `no_type` (a real MIME no installed type accepts)
   * earns the "install a type that accepts this" marketplace deep-link advisory.
   * Absent for non-upload type refusals (a direct createSemanticArtifact write).
   */
  readonly uploadRefusal?: { kind: "no_mime" | "no_type" | "ambiguous"; normalizedMime: string };
  constructor(
    readonly attemptedType: string | null,
    message: string,
    readonly suggestedExtension?: string,
    uploadRefusal?: { kind: "no_mime" | "no_type" | "ambiguous"; normalizedMime: string },
  ) {
    super(message);
    this.name = "ObjectsTypeNotRegisteredError";
    this.uploadRefusal = uploadRefusal;
  }
}

// The retired generic host object types. Under the dependency model no save may
// ever land under either again (kept as literals so the guard rejects them by id
// without importing register-types). Mirrors the MCP handler's GENERIC guard.
const GENERIC_ARTIFACT_TYPE_IDS: ReadonlySet<string> = new Set([
  "@cinatra-ai/artifact:object",
  "@cinatra-ai/objects:object",
]);

/** The defining extension package of a namespaced object-type id
 *  (`@scope/pkg:local` → `@scope/pkg`). Null for a non-namespaced id. */
function definerPackageOf(typeId: string): string | null {
  if (!typeId.startsWith("@")) return null;
  const colon = typeId.lastIndexOf(":");
  return colon > 0 ? typeId.slice(0, colon) : null;
}

/**
 * Whether a registered type is an ARTIFACT write target. Two shapes qualify:
 *  - a SELF-REGISTERED artifact type (the descriptor bridge sets `isArtifact`);
 *  - a CLAIM-BACKED HOST type whose registration declares an `artifact-safe`
 *    projection disposition (e.g. `@cinatra-ai/email:body`, registered host-side
 *    with `dispositions.projection: "artifact-safe"` and NO `isArtifact` — the
 *    pack CLAIM adds the disposition, not a second registrar). A plain data type
 *    (no `isArtifact`, no artifact-safe disposition) is NOT a write target.
 */
function isArtifactWritableType(def: NonNullable<ResolvedObjectTypeDef>): boolean {
  return def.isArtifact != null || def.dispositions?.projection === "artifact-safe";
}

/**
 * Validate a REQUIRED object type at the write boundary BEFORE any blob IO
 * (epic #1785, wave A3). Refuses via {@link ObjectsTypeNotRegisteredError} when
 * the type is a retired generic literal, has no installed `kind:"artifact"`
 * definer (`resolve` null or `def.isArtifact` absent), is not namespaced under a
 * defining extension, or that extension is not write-eligible for the org
 * (archived / ungoverned-denied). Returns the resolved definition so the caller
 * reuses it for the payload-schema check. Async because the write-eligibility
 * gate reads the canonical install store.
 */
async function assertWritableArtifactType(
  objectType: string,
  orgId: string,
): Promise<NonNullable<ResolvedObjectTypeDef>> {
  if (GENERIC_ARTIFACT_TYPE_IDS.has(objectType)) {
    throw new ObjectsTypeNotRegisteredError(
      objectType,
      `the generic host object type "${objectType}" is retired (epic #1785) — a save must name an installed artifact extension's declared type`,
    );
  }
  const def = objectTypeRegistry.resolve(objectType);
  if (!def || !isArtifactWritableType(def)) {
    const definer = definerPackageOf(objectType);
    const suggest =
      definer && objectTypeRegistry.getTypesForPackage(definer).length === 0
        ? definer
        : undefined;
    throw new ObjectsTypeNotRegisteredError(
      objectType,
      suggest
        ? `no installed artifact extension defines "${objectType}"; install ${suggest}`
        : `no installed artifact extension defines "${objectType}"`,
      suggest,
    );
  }
  const definer = definerPackageOf(objectType);
  if (!definer) {
    throw new ObjectsTypeNotRegisteredError(
      objectType,
      `object type "${objectType}" is not namespaced under a defining extension`,
    );
  }
  if (!(await isArtifactExtensionWriteAllowed(definer, orgId))) {
    throw new ObjectsTypeNotRegisteredError(
      objectType,
      `artifact extension "${definer}" is not write-allowed for this org (archived / ungoverned-denied install state)`,
    );
  }
  return def;
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
  // Fail-closed vocabulary boundary (cinatra#1428): only canonical visibility
  // values may reach the objects row. TS enforces this for typed callers; the
  // runtime check catches untyped JS/boundary callers that would otherwise
  // re-introduce the retired composite-string vocabulary.
  if (input.visibility !== undefined && !isCanonicalVisibility(input.visibility)) {
    throw new Error(
      `[artifact-creation] non-canonical visibility ${JSON.stringify(
        input.visibility,
      )} — expected 'private' | 'team' | 'organization' | 'public' (cinatra#1428 one-shot cutover)`,
    );
  }
  const visibility =
    input.visibility ?? defaultVisibilityFor(ownerLevelNorm);
  const originKind: ArtifactOriginKind = input.originKind ?? "upload";
  const maxBytes = input.maxBytes ?? ARTIFACT_BLOB_MAX_DEFAULT_BYTES;

  // -------------------------------------------------------------------
  // Write-boundary type validation (epic #1785, wave A3) — BEFORE any blob IO.
  // Refuses a generic / unregistered / ungoverned type via
  // OBJECTS_TYPE_NOT_REGISTERED so an unwritable save never touches the blob
  // store. (The type is re-resolved post-stream for the MIME/schema envelope
  // check, so the definition itself is not captured here.)
  // -------------------------------------------------------------------
  await assertWritableArtifactType(input.objectType, input.orgId);

  // -------------------------------------------------------------------
  // Pre-tx: write blob bytes to disk (orphan-safe). New writes land on the
  // org-scoped CONTENT-ADDRESSED key (cinatra#926) — a semantic dedupe
  // (same org + same substance/sha) therefore yields the SAME storage key
  // as the winner, so the dedupe-loser cleanups below only fire when the
  // keys actually differ (legacy-keyed winner), and any content-addressed
  // removal is reachability-guarded inside deleteByStorageKey.
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

  // -------------------------------------------------------------------
  // Post-stream write-boundary validation (epic #1785, wave A3), BEFORE Tx1.
  // Now the DETECTED MIME + size are known: (a) re-resolve the type (guards an
  // uninstall mid-stream); (b) reject a detected MIME the declared type does not
  // accept — accepts come from the SELF-registered definition (`isArtifact`) or,
  // for a claim-backed HOST type that carries none, the caller-supplied
  // `expectedAcceptMimes` (defense-in-depth against smuggling a MIME under a
  // type); (c) enforce the type's payload schema on the envelope. Running BEFORE
  // Tx1 means a refusal has written NO resource/artifact_blobs rows — only the
  // content-addressed blob file, which (like the existing pre-Tx1 failure path)
  // is best-effort deleted and otherwise reachability-backstopped by the
  // retention verifier. Nothing leaks a representation-less resource row.
  // (The dedupe case, where the persisted MIME is an existing resource's, gets a
  // second accepts check AFTER Tx1 resolves `authoritative.mime`.)
  // -------------------------------------------------------------------
  try {
    const preDef = objectTypeRegistry.resolve(input.objectType);
    if (!preDef || !isArtifactWritableType(preDef)) {
      throw new ObjectsTypeNotRegisteredError(
        input.objectType,
        `object type "${input.objectType}" is no longer a writable artifact type (definer uninstalled mid-write)`,
      );
    }
    const declaredAccepts =
      preDef.isArtifact?.accepts?.file?.mimeTypes ?? input.expectedAcceptMimes;
    if (
      Array.isArray(declaredAccepts) &&
      declaredAccepts.length > 0 &&
      !mimeAcceptedByAccepts(declaredAccepts, newBlob.mimeDetected)
    ) {
      throw new ObjectsTypeNotRegisteredError(
        input.objectType,
        `detected MIME "${newBlob.mimeDetected}" is not accepted by "${input.objectType}" (accepts [${declaredAccepts.join(", ")}])`,
      );
    }
    const previewEnvelope: ArtifactObjectData = {
      artifactType: "file",
      latestRepresentationRevisionId: representationRevisionId,
      latestDigest: newBlob.sha256,
      mime: newBlob.mimeDetected,
      size: newBlob.sizeBytes,
      originKind,
      viewerHint: "mime",
      title: input.title,
    };
    const parsed = preDef.schema.safeParse(previewEnvelope);
    if (!parsed.success) {
      throw new ObjectsTypeNotRegisteredError(
        input.objectType,
        `object payload does not satisfy the declared schema for "${input.objectType}": ${parsed.error.message}`,
      );
    }
  } catch (err) {
    await blobStore
      .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
      .catch(() => {});
    throw err;
  }

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
    // Pre-tx-2 failure → the new blob bytes are (probably) unreferenced.
    // Best-effort delete. The content-addressed file may pre-date this put
    // (same-bytes reuse) and be owned by an existing row — the
    // reachability-guarded deleteByStorageKey (cinatra#926) keeps
    // referenced/young files; residuals are the verifier's to report.
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

  // Resolve + ORG-VALIDATE the deterministic producer-assertion plan BEFORE
  // Tx2 (and before the classifier-signals composition, so the composed signals
  // can carry the producer's declared `produces` — cinatra#1891 scope 3). A
  // missing or cross-org `createdByRunId` yields `validatedRunId: null` (we then
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
  // Per-binding producer scoping (cinatra#923): when the caller names ONE
  // produced extension, assert only that one — the whole-`produces` splice
  // would stamp a multi-produce agent's every declared type onto every
  // output. The plan's `produces` list already passed run-org validation,
  // manifest membership, and the CG-4 write gate; an extension that did not
  // survive (or was never declared) degrades to NO producer assertion —
  // the existing fail-soft (the LLM matcher path stays the fallback).
  let planProduces = producerPlan.produces;
  if (input.producerAssertionExtension !== undefined) {
    planProduces = planProduces.includes(input.producerAssertionExtension)
      ? [input.producerAssertionExtension]
      : [];
    if (planProduces.length === 0) {
      console.warn(
        `[producer-assertions] producerAssertionExtension "${input.producerAssertionExtension}" is not in the run's validated produces set — degrading to no producer assertion`,
      );
    }
  }

  // Server-side composition of `ClassifierSignals` BEFORE the
  // artifact-creation tx commits, so the signals row goes in atomically
  // with the representation row. The composition pipeline:
  //   1) resolve `chatContextSource.threadId` via the tenant-safe
  //      reader (deny-by-default; null on legacy/cross-user/wrong-org);
  //   2) compose with the upload-side metadata already in `input` AND the
  //      producer's declared `produces` (cinatra#1891 scope 3);
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
    // cinatra#1891 scope 3: carry the producer's declared `produces` (the
    // scoped, run-org-validated set) into the signals so the matcher prompt can
    // use "what the emitting run said it produces" as meaning evidence. The
    // composer dedupes + byte-caps; an empty list is omitted.
    const producesSignals =
      planProduces.length > 0
        ? planProduces.map((extension) => ({ extension }))
        : undefined;
    const candidateSignals: ClassifierSignals = {
      chatContext,
      produces: producesSignals,
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

  // Build the tx-composable producer assertion ops (assertedBy:"agent"
  // — the highest-confidence deterministic source). One archive +
  // insert-RETURNING pair per produced extension. The default-floor
  // type was already filtered out in resolveProducerAssertionPlan so
  // `buildAssertSemanticTypeQueries` cannot throw here.
  const producerSplice = planProduces.map((extension) =>
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

  // -------------------------------------------------------------------
  // Dedupe-delta re-validation (epic #1785, wave A3). The pre-Tx1 validation
  // above ran against the freshly-DETECTED MIME + a detected-MIME envelope. On a
  // same-bytes DEDUPE the PERSISTED `objects.data.mime` is the EXISTING
  // resource's recorded MIME (`authoritative.mime`), which — with
  // declared-sensitive sniffing — can differ from `newBlob.mimeDetected`. Only
  // then re-run the FULL envelope validation against the persisted values: the
  // type must still resolve (fail CLOSED if the definer vanished mid-write), the
  // persisted MIME must be accepted, and the final `objectData` must satisfy the
  // schema. Cleanup deletes ONLY the dedupe-duplicate blob whose key differs from
  // the winner's — NO fresh resource/artifact_blobs rows were written on a
  // dedupe, so nothing leaks a representation-less resource. (A fresh, non-dedupe
  // write already passed the equivalent checks pre-Tx1 against the identical
  // detected MIME + envelope.)
  // -------------------------------------------------------------------
  if (authoritative.isDedupe && authoritative.mime !== newBlob.mimeDetected) {
    const refuseDedupe = async (message: string): Promise<never> => {
      if (newBlob.storageKey !== authoritative.storageKey) {
        await blobStore
          .deleteByStorageKey({ orgId: input.orgId, storageKey: newBlob.storageKey })
          .catch(() => {});
      }
      throw new ObjectsTypeNotRegisteredError(input.objectType, message);
    };
    const postDef = objectTypeRegistry.resolve(input.objectType);
    if (!postDef || !isArtifactWritableType(postDef)) {
      await refuseDedupe(
        `object type "${input.objectType}" is no longer a writable artifact type (definer uninstalled mid-write)`,
      );
    } else {
      const declaredAccepts =
        postDef.isArtifact?.accepts?.file?.mimeTypes ?? input.expectedAcceptMimes;
      if (
        Array.isArray(declaredAccepts) &&
        declaredAccepts.length > 0 &&
        !mimeAcceptedByAccepts(declaredAccepts, authoritative.mime)
      ) {
        await refuseDedupe(
          `persisted (dedupe-winner) MIME "${authoritative.mime}" is not accepted by "${input.objectType}" (accepts [${declaredAccepts.join(", ")}])`,
        );
      }
      const parsed = postDef.schema.safeParse(objectData);
      if (!parsed.success) {
        await refuseDedupe(
          `object payload does not satisfy the declared schema for "${input.objectType}": ${parsed.error.message}`,
        );
      }
    }
  }

  // Archive gate. Resolved projectId is non-NULL iff the frame is active
  // AND the type is not on the substrate exclusion list (semantic artifacts
  // are NEVER substrate, so when a frame is set this fires). When
  // projectIdForRow is set and the target project is archived, reject before
  // opening the held-lock tx.
  {
    const projectIdForRow = resolveProjectInheritanceForType(
      mcpRequestContextStorage.getStore()?.projectContext?.projectId,
      input.objectType,
    );
    if (projectIdForRow !== null) {
      assertProjectWritableSync(projectIdForRow);
    }
  }
  // The producer assertion ops (archive + insert-RETURNING per produced
  // extension) are spliced AFTER the artifact_audit INSERT. They run inside the
  // SAME held-lock Tx2 so producer assertion + creation commit atomically. (The
  // default-floor rebalance INSERT is retired — epic #1785 wave A3: the row now
  // carries its exact declared type in `objects.type`, so there is no default
  // eligible assertion to rebalance.)
  const producerOps = producerSplice.flatMap((p) => p.queries);
  // Fixed leading-query count before the producer ops: lock(1) +
  // objects/outbox(1) + representation(1) + audit(1) = 4. Each
  // `buildAssertSemanticTypeQueries` contributes exactly 2 ops
  // (archive, insert-RETURNING) — parseResult locates its
  // insert-RETURNING relative to the spliced offset.
  const PRODUCER_OPS_OFFSET = 4;
  // ---------------------------------------------------------------------
  // Binding reconcile, IN Tx2 (cinatra#1868).
  //
  // WHY HERE. The ordinary object write path (`upsertObjectAndEnqueue`) rides a
  // `binding_reconcile_enqueue` CTE that durably records a per-artifact reconcile
  // whenever a create could affect the row's claim-derived identity. Artifact
  // creation writes `objects` DIRECTLY (module header), so it rides nothing: a
  // run-materialized row whose declared type is CLAIM-BACKED was minted with NO
  // binding assertion, and the recurring reconcile worker only DRAINS QUEUED work
  // — it never discovers unqueued rows. A binding could then only appear via an
  // incidental external trigger (a later claim-winner transition, an explicit
  // backfill/type sweep, a qualifying type-changing write). In the ordinary
  // steady state (claim already active, transition queue drained) none of those
  // fire, so the row stayed unbound — and every claimed-row gate keys off exactly
  // that assertion. Net: not pinnable (cinatra#1868).
  //
  // WHY IN-TX rather than an enqueue. Enqueuing would only yield the binding
  // after a queue drain, so the pin would not be available at run completion.
  // Tx2 ALREADY opens with `pg_advisory_xact_lock(hashtext(artifactId))` as its
  // FIRST statement — exactly the composition contract
  // `buildBindingReconcileQueries` documents — so the canonical builder drops
  // straight in and the binding commits ATOMICALLY with the row it describes: no
  // crash window, either the artifact and its binding both exist or neither does.
  //
  // WHY READ COMMITTED IS SOUND HERE. `reconcileArtifactBinding` opts into
  // REPEATABLE READ only to defend against a winner change committed BETWEEN the
  // archive and the insert leaving binding A retained AND binding B inserted (two
  // active bindings). That hazard needs a PRE-EXISTING active binding. `artifactId`
  // is a UUID minted in this call and the objects INSERT is a plain INSERT (no ON
  // CONFLICT — a collision throws and rolls back Tx2), so the row provably carries
  // ZERO pre-existing binding assertions: the archive can only touch rows this very
  // transaction wrote, and the insert adds at most the one `LIMIT 1` winner, so the
  // sa_one_active_binding_idx (one active binding per org+artifact) can NEVER be
  // violated on this fresh row. Tx2 therefore keeps its READ COMMITTED level (and
  // avoids the serialization-failure retry surface a REPEATABLE-READ creation path
  // would take on across ALL of the objects/representation/audit/producer writes).
  //
  // The one residual READ-COMMITTED effect (codex convergence #1868) is a
  // cross-statement WINNER SKEW: a claim-winner transition on this type committed
  // in the microsecond gap between the two statements can make the archive act on
  // winner A while the insert resolves winner B. This is INTEGRITY-SAFE, never a
  // persisted invariant violation: if the fresh row's producer classic is for
  // winner B, the archive (winner A) leaves that classic live and the binding-B
  // INSERT hits sa_active_unique_idx (org,artifact,extension) → the WHOLE Tx2 rolls
  // back and the caller retries against a now-stable winner (the same optimistic
  // outcome any concurrent create would take); otherwise the row commits a
  // winner-B binding (pinnable) with at most an over-archived foreign classic. A
  // winner transition ALSO enqueues a per-type reconcile sweep, so any such
  // transient is re-reconciled to the live winner on the next drain — self-healing.
  // Winner transitions are rare administrative claim events, not a hot path.
  //
  // WHY AFTER THE PRODUCER OPS. The reconcile's archive statement supersedes the
  // WINNER extension's live CLASSIC row (cinatra#1493) because that row holds the
  // `sa_active_unique_idx` (org, artifact, extension) slot the binding INSERT
  // needs. Running the reconcile BEFORE the producer splice would invert that:
  // `buildAssertSemanticTypeQueries`' own archive excludes binding rows (a classic
  // never displaces a binding) but does NOT treat one as a precedence block, so
  // its INSERT would collide on that unique index and roll back the whole
  // creation. After the producer ops the two compose exactly as the
  // reconcile-queue consumer would: same-extension classic archived, winner
  // binding inserted, both in one transaction so the artifact never transiently
  // loses the extension's identity. A producer classic from a DIFFERENT extension
  // than the claim winner is untouched.
  //
  // GATING IS IN THE SQL. `winnerCte` yields a row only when the artifact's
  // CURRENT `objects.type` carries a live DEDICATED claim in the org's scope chain
  // and the object is not quarantined. A non-claimed type (the pack-typed and
  // generic cases) produces an EMPTY winner: the archive matches nothing (a fresh
  // row has no bindings, and the classic clause requires a winner) and the insert
  // selects nothing. Behavior for those rows is bit-for-bit unchanged — no JS-side
  // guard SELECT is needed (unlike `reconcileArtifactBindingForWrite`, whose guard
  // exists to avoid OPENING a locked REPEATABLE READ tx; here the lock and the tx
  // are already paid for).
  //
  // PROJECTION. Tx2 already inserted the graphiti outbox row for this artifact and
  // the projector runs POST-commit, so it observes the binding without a separate
  // refresh tail.
  //
  // NOTE the raw `postgresSchema`: the builder escapes its own identifier, and the
  // local `schema` const above is ALREADY escaped — passing it would double-escape
  // an embedded quote.
  const bindingOps = buildBindingReconcileQueries(postgresSchema, {
    orgId: input.orgId,
    artifactId,
  });
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
            input.objectType,
            input.parentId ?? null,
            input.parentType ?? null,
            JSON.stringify(objectData),
            input.createdBy ?? null,
            input.orgId,
            ownerLevelNorm,
            input.ownerId,
            visibility,
            // Artifact inherits projectId from the active
            // mcpRequestContextStorage frame. A semantic-artifact type is never
            // on the substrate exclusion list, so the helper returns the frame
            // projectId verbatim (or null when no frame is active).
            resolveProjectInheritanceForType(
              mcpRequestContextStorage.getStore()?.projectContext?.projectId,
              input.objectType,
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
        // Producer assertion ops spliced HERE (after audit). Empty when there
        // is no trusted producer. The default-floor rebalance INSERT/UPDATE that
        // used to follow is RETIRED (epic #1785 wave A3) — the row carries its
        // exact declared type in `objects.type`, so no default-artifact eligible
        // assertion is ever written or rebalanced at creation.
        ...producerOps,
        // Binding reconcile spliced HERE (cinatra#1868) — AFTER the producer ops
        // so a same-extension classic is already present for the archive to
        // supersede (cinatra#1493), and BEFORE the authoring-ledger + caller
        // follow-ons so those stay the tail. For a NON-claimed type the winner CTE
        // is empty ⇒ both statements are no-ops (behavior unchanged). Result
        // positions after the producer splice are never parsed.
        ...bindingOps,
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
        // Caller-composed follow-on ops (cinatra#923 — the materialization-
        // ledger finalize). Appended LAST so every fixed offset above
        // (PRODUCER_OPS_OFFSET and the producer splice) is untouched; they
        // commit atomically with the artifact write and their results are
        // never parsed.
        ...(input.additionalTx2Queries
          ? input.additionalTx2Queries({ artifactId, representationRevisionId })
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
    if (authoritative.isDedupe && newBlob.storageKey !== authoritative.storageKey) {
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
  // proper backstop for any residual disk leak.
  //
  // Content-addressed keys (cinatra#926): same substance ⇒ same sha ⇒ the
  // loser key can EQUAL the winner key (same final file — nothing to
  // remove; deleting would unlink the winner's bytes). Skip on equality;
  // any other content-addressed removal routes through the reachability-
  // guarded deleteByStorageKey (which keeps young/referenced files).
  // -------------------------------------------------------------------
  if (authoritative.isDedupe && newBlob.storageKey !== authoritative.storageKey) {
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
        const ext = planProduces[i];
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

  // Async LLM MEANING-matcher enqueue — REACTIVATED (epic #1883 wave A3,
  // cinatra#1891). Every artifact is typed at write time (its STRUCTURAL type is
  // in `objects.type`), but the matcher layers a MEANING assertion (a `matcher`
  // DRAFT surfaced by the presentation resolver) on top — e.g. a structurally
  // "document" upload recognized as "our marketing strategy". Enqueued POST-Tx2
  // COMMIT so the matcher's authoritative read always resolves the committed row
  // + its persisted classifier signals; best-effort so a queue failure never
  // fails the committed creation.
  //
  // `skipFallbackClassification` is honored: the deterministic template /
  // chat-authoring paths set it so the matcher does not race their follow-up
  // `assertSemanticType` (their type is asserted AFTER this create returns). The
  // agent-emit materializer sets it too and enqueues EXPLICITLY after its
  // producer assertion has committed (run-artifact-materializer) — the issue's
  // "after agent-emit materialization" seam.
  if (!input.skipFallbackClassification) {
    const { enqueueArtifactMatchRun } = await import("./matcher-enqueue");
    await enqueueArtifactMatchRun({
      orgId: input.orgId,
      artifactId,
      representationRevisionId,
      createdByRunId: persistedRunId,
    });
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

// Canonical default visibility per owner level (cinatra#1428). The owner axis
// lives in owner_level + owner_id; visibility is the SHARE axis:
//   user-owned      → 'private'      (only the owning user)
//   team-owned      → 'team'         (the owning team's members)
//   org-owned       → 'organization' (all org members)
//   workspace-owned → 'public'       (anyone in the owning org; the
//                                     multi-tenant scoping lives in
//                                     buildOwnershipFilter)
function defaultVisibilityFor(ownerLevel: OwnerLevel): CanonicalVisibility {
  switch (ownerLevel) {
    case "user":
      return "private";
    case "team":
      return "team";
    case "organization":
      return "organization";
    case "workspace":
      return "public";
  }
}

// Tenant/version-scoped blob store contract.
//
// Pure interface + types — NO node/fs/server imports, so it is safe in any
// module graph. The local-disk binding lives in the app at
// `src/lib/artifacts/local-disk-blob-store.ts`; an S3/object-store impl can
// be swapped in later behind this same interface (spec §8 deferral).
//
// Invariants enforced by every implementation (artifacts-architecture.md §2):
//  - Blob identity is ALWAYS tenant + artifact-version scoped. Storage keys
//    are server-generated; a client filename is NEVER used as a path.
//  - sha256 dedupe (if any) is internal only — never exposed, never used
//    for authorization or cross-tenant existence inference.
//  - Bytes live ONLY in the blob store; `objects.data` never holds bytes.

/** Scope for every blob operation — the only way to address a blob.
 *
 * The `representationRevisionId` field aligns blob scope with the semantic
 * Resource → Representation → Assertion model. SQL columns currently retain
 * the `version_id` name for compatibility with the existing store schema. */
export type BlobScope = {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
};

export type BlobPutInput = BlobScope & {
  /** Async byte source (Web ReadableStream or Node Readable-like). */
  stream: AsyncIterable<Uint8Array>;
  /** Caller's claimed MIME (advisory; implementations also sniff). */
  declaredMime?: string;
  /** Hard ceiling — implementations MUST abort past this many bytes. */
  maxBytes: number;
};

export type BlobRecord = {
  blobId: string;
  /** Server-generated, scope-derived key. Opaque to callers. */
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  /** Server-detected MIME (content sniff), not the client's claim. */
  mimeDetected: string;
};

export type BlobReadHandle = {
  sizeBytes: number;
  mimeDetected: string;
  /** Full stream. Range slicing is the serving layer's concern. */
  stream: AsyncIterable<Uint8Array>;
};

export class BlobTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`blob exceeds max size of ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

/**
 * Atomic creation is enabled on the semantic Resource → Representation →
 * Assertion data model (`createSemanticArtifact`). The disabled-creation class
 * is retained as a type-only compatibility export for external importers; all
 * runtime `throw` sites have been removed.
 */
export class ArtifactCreationDisabledError extends Error {
  readonly code = "ARTIFACT_CREATION_DISABLED_V51_REFRAME";
  constructor() {
    super(
      "ArtifactCreationDisabledError is retired (creation re-enabled on the semantic model). " +
        "If this is thrown in production, a stale build is in play.",
    );
    this.name = "ArtifactCreationDisabledError";
  }
}

export interface BlobStore {
  /** Persist a blob; computes sha256 + size, sniffs MIME, enforces maxBytes. */
  put(input: BlobPutInput): Promise<BlobRecord>;
  /** Open a blob for reading, scoped — fails if scope/blob mismatch. */
  open(scope: BlobScope & { blobId: string }): Promise<BlobReadHandle>;
  /**
   * Open an inclusive byte range `[start, end]` (HTTP Range semantics) for
   * the serving layer. `end` is inclusive; implementations clamp to size-1.
   */
  openRange(
    scope: BlobScope & { blobId: string; start: number; end: number },
  ): Promise<BlobReadHandle & { totalSize: number }>;
  /** Metadata without reading bytes. Null if absent. */
  stat(
    scope: BlobScope & { blobId: string },
  ): Promise<Pick<BlobRecord, "sizeBytes" | "mimeDetected" | "sha256"> | null>;
  /** Best-effort delete (orphan GC / retention). Never throws on absence. */
  deleteBlob(scope: BlobScope & { blobId: string }): Promise<void>;

  // Storage-key-keyed accessors for the semantic serve path. Scope-keyed
  // access reconstructs the on-disk key from (orgId, artifactId,
  // representationRevisionId, blobId). Resource-level dedupe means two
  // artifacts can share one resource pointing at one canonical storage key.
  // The serve resolver looks up the storage key on the resource and opens by
  // that key directly. Implementations MUST validate the storage key starts
  // with `orgs/<orgId>/` (defense-in-depth on DB-carried keys).

  /** Open a blob by its server-allocated storage_key (resource-bound).
   *  MUST reject any storage_key not under the requested org prefix. */
  openByStorageKey(input: {
    orgId: string;
    storageKey: string;
  }): Promise<BlobReadHandle>;

  /** Range-open for the serve route's 206 path. */
  openRangeByStorageKey(input: {
    orgId: string;
    storageKey: string;
    start: number;
    end: number;
  }): Promise<BlobReadHandle & { totalSize: number }>;

  /** Best-effort delete by storage_key (orphan cleanup / dedupe-loser). */
  deleteByStorageKey(input: {
    orgId: string;
    storageKey: string;
  }): Promise<void>;
}

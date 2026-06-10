// Immutable artifact version + normalized ArtifactRef.
// Pure types (no node/server imports). Mirrors artifacts-architecture.md §4.
//
// The generic semantic artifact object type. Every semantic artifact row in
// `objects` carries `type = SEMANTIC_ARTIFACT_OBJECT_TYPE`.
// Semantic identity lives in `semantic_assertion`, NOT in `objects.type`.
// The shared object type keeps semantic artifact identity separate from the
// extension-specific artifact package that produced it.
export const SEMANTIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

export type ArtifactOriginKind =
  | "upload"
  | "email_attachment"
  | "agent_generated"
  | "external_link"
  | "live_generator";

/**
 * Normalized, immutable reference a run/message pins. NEVER carries bytes;
 * `objects.version` is a mutable per-row counter and is intentionally NOT
 * part of this — pinning is by the immutable `representationRevisionId` +
 * `digest`.
 *
 * `representationRevisionId` matches the semantic Representation contract.
 * The persisted SQL column remains `version_id` for storage compatibility.
 */
export type ArtifactRef = {
  artifactId: string;
  representationRevisionId: string;
  digest: string;
  mime: string;
  originKind: ArtifactOriginKind;
};

/** One immutable artifact version (full-fidelity `file` model, §2.2). */
export type ArtifactVersion = {
  id: string;
  artifactId: string;
  orgId: string;
  versionNumber: number;
  blobId: string | null;
  digest: string;
  sizeBytes: number;
  mime: string;
  viewerHint: string;
  originKind: ArtifactOriginKind;
  bodyText: string | null;
  bodyFormat: string | null;
  imageVariants: ReadonlyArray<{ label: string; blobId: string; mime: string }>;
  provenance: {
    runId?: string;
    messageId?: string;
    provider?: string;
    agentId?: string;
  };
  publication: { published?: boolean; editable?: boolean };
  referenceMetadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
};

/** Metadata mirror written to `objects.data` — refs only, NEVER bytes.
 *
 * `latestRepresentationRevisionId` matches the semantic Representation
 * contract. Persisted `objects.data` uses this JSON key as well; no
 * back-compat mapping is required for substrate rows in current stores.
 * Graphiti projector, UI, and agent MCP handler consume the same key. */
export type ArtifactObjectData = {
  artifactType: string;
  latestRepresentationRevisionId: string;
  latestDigest: string;
  mime: string;
  size: number;
  originKind: ArtifactOriginKind;
  viewerHint: string;
  title?: string;
  excerpt?: string;
  /**
   * Connector-ref source pointer (canonical persisted shape).
   *
   * `url` is the absolute http(s) URL that opens the object in its source
   * application (e.g. a Google Doc, a Notion page). Written by connector-sync
   * producers when they materialize a connector-ref representation; absent
   * for blob/dashboard artifacts. No current writer populates it yet — the
   * field defines the contract consumed by the artifact-service summary
   * projection (`ArtifactSummary.sourceUrl`), which validates the protocol
   * before exposing it to UI hrefs.
   */
  connectorRef?: { url: string };
};

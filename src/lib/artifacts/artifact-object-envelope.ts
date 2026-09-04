// ---------------------------------------------------------------------------
// THE DECLARED-FIELDS ROAD INTO AN ARTIFACT ROW'S OBJECT ENVELOPE
// (lifecycle-c W9, the re-pin half).
//
// The host writes an artifact row's `objects.data` as a FIXED file envelope —
// the representation ref, the digest, the form, the size — and validates it
// against the type's DECLARED schema before any blob IO. That was total while
// every artifact type's schema described the envelope and nothing else.
//
// It stops being total the moment a type declares REQUIRED fields of its own:
// the picture type declares the post it belongs to and its placement, and an
// envelope with neither is refused by the type's own schema. So a deterministic
// caller that KNOWS those values needs a road to carry them, and the host needs
// one place where such a field can never quietly overwrite an envelope key the
// host owns.
//
// PURE — no fs, no DB, no server-only import: the validation that follows is
// the type's own schema, exactly as before.
// ---------------------------------------------------------------------------

import type { ArtifactObjectData } from "@cinatra-ai/artifacts";

/** The envelope keys the HOST owns. A declared field may never take one of
 *  these: a caller that could overwrite `latestRepresentationRevisionId` or
 *  `mime` would be rewriting the row's own provenance through a side door. */
export const RESERVED_ARTIFACT_ENVELOPE_KEYS = [
  "artifactType",
  "latestRepresentationRevisionId",
  "latestDigest",
  "mime",
  "size",
  "originKind",
  "viewerHint",
  "title",
  "excerpt",
  "connectorRef",
] as const;

const RESERVED = new Set<string>(RESERVED_ARTIFACT_ENVELOPE_KEYS);

/** The extra, type-DECLARED fields a caller carries into the envelope. */
export type DeclaredObjectFields = Readonly<Record<string, unknown>>;

/**
 * Compose the host's envelope with a caller's type-declared fields.
 *
 * Fail-closed: a declared field naming a reserved envelope key THROWS rather
 * than winning or being dropped silently — a caller writing under the host's
 * own keys is a defect, not a preference. With no declared fields the result is
 * the envelope itself, so every existing writer is byte-unchanged.
 */
export function snapshotDeclaredObjectFields(
  declaredObjectFields: DeclaredObjectFields,
): DeclaredObjectFields {
  return Object.freeze({ ...declaredObjectFields });
}

export function buildArtifactObjectEnvelope(
  envelope: ArtifactObjectData,
  declaredObjectFields?: DeclaredObjectFields,
): ArtifactObjectData & Record<string, unknown> {
  if (declaredObjectFields === undefined) return { ...envelope };
  // ONE materialization. The fields are read exactly once into a plain,
  // frozen snapshot, and the reserved-key check plus every later merge read
  // THAT snapshot — never the caller's object again. A caller object with a
  // getter (or a Proxy) can otherwise answer one way to the key check and
  // another to the spread, and a second spread later in the write can differ
  // from the one that was validated.
  const snapshot = snapshotDeclaredObjectFields(declaredObjectFields);
  const offending = Object.keys(snapshot).filter((k) => RESERVED.has(k));
  if (offending.length > 0) {
    throw new Error(
      `[artifact-creation] declared object field(s) [${offending.join(", ")}] name a reserved envelope key — ` +
        "the host owns the artifact envelope; a type's declared fields sit beside it, never over it",
    );
  }
  return { ...envelope, ...snapshot };
}

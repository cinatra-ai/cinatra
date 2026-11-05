import type { ArtifactObjectData } from "@cinatra-ai/artifacts";
import {
  buildObjectContentProjection,
  type ArtifactContentProjection,
  type ArtifactRepresentationForm,
} from "./artifact-content-channel";

/** Mirror fields of `ArtifactObjectData` that the core file writer does NOT
 *  stamp on a file row (artifact-creation.ts writes eight fields): `excerpt` is
 *  a producer's own field when a file row holds it, and `connectorRef` is the
 *  connector-ref form's source pointer. On a file row either one is a field of
 *  the producer's record, not of the envelope. */
type NonEnvelopeMirrorField = "excerpt" | "connectorRef";

/** The fields the core file writer stamps on EVERY file row. A row that
 *  carries only these holds no record of its own type: an uploaded pdf or
 *  image has nothing beside its bytes to show. The mapped type makes a new
 *  `ArtifactObjectData` mirror field fail the typecheck until it is named here
 *  or in `NonEnvelopeMirrorField`. */
const FILE_ENVELOPE_FIELDS: {
  readonly [K in Exclude<keyof Required<ArtifactObjectData>, NonEnvelopeMirrorField>]: true;
} = {
  artifactType: true,
  latestRepresentationRevisionId: true,
  latestDigest: true,
  mime: true,
  size: true,
  originKind: true,
  viewerHint: true,
  title: true,
};

/** A plain record as a JSON column yields it: its prototype is
 *  `Object.prototype` or null. A class instance, a Date, a Map or an array is
 *  no record. */
function isPlainRecord(data: unknown): data is Record<string, unknown> {
  if (typeof data !== "object" || data === null) return false;
  const prototype = Object.getPrototypeOf(data);
  return prototype === Object.prototype || prototype === null;
}

/** True only when the row holds a typed record its producer wrote (for example
 *  a screenshot's measured capture facts), not just the core file envelope:
 *  a plain record with at least one OWN field outside the envelope that holds
 *  a value. An inherited field, or one whose value is undefined (it vanishes
 *  from the JSON projection), does not count. */
function carriesTypedRecord(data: unknown): data is Record<string, unknown> {
  if (!isPlainRecord(data)) return false;
  return Object.entries(data).some(
    ([field, value]) =>
      value !== undefined && !Object.prototype.hasOwnProperty.call(FILE_ENVELOPE_FIELDS, field),
  );
}

/** Composes a file's structured record beside its bytes for the live artifact
 * page. Its record is explicitly LIVE; it never claims to be the pinned file's
 * data. The caller must supply data from the authorized detail read, not a raw
 * lookup. It composes only for a file-form revision whose pinned content is
 * `none` with reason `unsupported-form` and names a pinned revision, and whose
 * row holds a typed record of its own. Any other pinned content (text, an
 * over-cap or absent result, no pinned revision) and an envelope-only row keep
 * the pinned content unchanged. Review surfaces do not use this composition. */
export function withLiveFileObjectContent(input: {
  content: ArtifactContentProjection;
  form: ArtifactRepresentationForm | null;
  objectType: string;
  authorizedLiveData: unknown;
}): ArtifactContentProjection {
  if (input.form !== "file" || input.content.kind !== "none"
    || input.content.reason !== "unsupported-form"
    || !input.content.representationRevisionId
    || !carriesTypedRecord(input.authorizedLiveData)) {
    return input.content;
  }
  return buildObjectContentProjection({
    objectType: input.objectType, data: input.authorizedLiveData, source: "live",
  });
}

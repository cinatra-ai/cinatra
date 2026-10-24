import type { ArtifactObjectData } from "@cinatra-ai/artifacts";
import {
  buildObjectContentProjection,
  type ArtifactContentProjection,
  type ArtifactRepresentationForm,
} from "./artifact-content-channel";

/** The fields the core file writer stamps on EVERY file row (the metadata
 *  mirror of `ArtifactObjectData`). A row that carries only these holds no
 *  record of its own type: an uploaded pdf or image has nothing beside its
 *  bytes to show. The mapped type makes a new mirror field fail the typecheck
 *  until it is named here. */
const FILE_ENVELOPE_FIELDS: { readonly [K in keyof Required<ArtifactObjectData>]: true } = {
  artifactType: true,
  latestRepresentationRevisionId: true,
  latestDigest: true,
  mime: true,
  size: true,
  originKind: true,
  viewerHint: true,
  title: true,
  excerpt: true,
  connectorRef: true,
};

/** True only when the row holds a typed record its producer wrote (for example
 *  a screenshot's measured capture facts), not just the core file envelope. */
function carriesTypedRecord(data: unknown): data is Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  return Object.keys(data).some(
    (field) => !Object.prototype.hasOwnProperty.call(FILE_ENVELOPE_FIELDS, field),
  );
}

/** The live artifact page can show a file's structured record beside its bytes.
 * Its record is explicitly LIVE; it never claims to be the pinned file's data.
 * The caller must supply data from the authorized detail read, not a raw lookup.
 * Only a row with a typed record of its own qualifies; a file whose row carries
 * only the core envelope keeps its pinned content unchanged.
 * Review surfaces do not use this composition. */
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

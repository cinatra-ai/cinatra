import {
  buildObjectContentProjection,
  type ArtifactContentProjection,
  type ArtifactRepresentationForm,
} from "./artifact-content-channel";

/** The live artifact page can show a file's structured record beside its bytes.
 * Its record is explicitly LIVE; it never claims to be the pinned file's data.
 * The caller must supply data from the authorized detail read, not a raw lookup.
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
    || input.authorizedLiveData === undefined || input.authorizedLiveData === null) {
    return input.content;
  }
  return buildObjectContentProjection({
    objectType: input.objectType, data: input.authorizedLiveData, source: "live",
  });
}

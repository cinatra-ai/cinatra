import { createUploadedArtifact } from "@/lib/artifacts/artifact-service";
import { resolveUploadArtifactType } from "@/lib/artifacts/upload-artifact-type-map";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { mediaKindSamples, type MediaKindSample } from "./media-kind-samples";

/** One filed sample: what the marked review gate fixture pins, plus its kind. */
export interface FiledMediaKind {
  kind: MediaKindSample["kind"];
  mime: string;
  objectType: string;
  artifactId: string;
  representationRevisionId: string;
}

export function assertMediaFixtureRuntime(env: Record<string, string | undefined> = process.env) {
  if (env.CINATRA_RUNTIME_MODE !== "development") {
    throw new Error("Media fixtures require CINATRA_RUNTIME_MODE=development");
  }
}

/**
 * File one artifact of each of the six media kinds for one user, through the
 * upload route's own service entry: the form is mapped to the one installed
 * required artifact type that accepts it, and the bytes go through the
 * canonical writer, which detects the form again before it writes.
 *
 * Every kind is resolved before the first write, so a missing type files
 * nothing. The artifacts are the user's own private uploads, as the upload
 * route files them. They are typed by their form, so no matcher runs.
 */
export async function fileMediaKindSamples(
  input: { orgId: string; userId: string },
  samples: MediaKindSample[] = mediaKindSamples(),
): Promise<FiledMediaKind[]> {
  assertMediaFixtureRuntime();
  const orgId = input.orgId.trim(), userId = input.userId.trim();
  if (!orgId || !userId) throw new Error("The organization and the user must be nonempty");
  registerAllObjectTypes();
  const plan = samples.map((sample) => {
    const resolved = resolveUploadArtifactType(sample.mime);
    if (!resolved.ok) {
      throw new Error(`No installed upload type takes the ${sample.kind} sample (${sample.mime}): ${resolved.reason}; nothing was filed`);
    }
    return { sample, objectType: resolved.objectTypeId };
  });
  const filed: FiledMediaKind[] = [];
  for (const { sample, objectType } of plan) {
    const result = await createUploadedArtifact({
      orgId, createdBy: userId, ownerLevel: "user", ownerId: userId, visibility: "private",
      declaredMime: sample.mime, title: sample.title, originKind: "upload",
      skipFallbackClassification: true,
      stream: (async function* () { yield sample.bytes; })(),
    });
    filed.push({
      kind: sample.kind, mime: sample.mime, objectType,
      artifactId: result.artifactId, representationRevisionId: result.representationRevisionId,
    });
  }
  return filed;
}

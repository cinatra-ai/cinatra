import "server-only";
import {
  createSemanticArtifact,
  type CreateSemanticArtifactInput,
  type CreateSemanticArtifactResult,
} from "./artifact-creation";

// `writeUploadedArtifact` is a thin compatibility shim that delegates to the
// canonical semantic writer (`createSemanticArtifact` in artifact-creation.ts).
// Keep this file so direct importers stay on the supported semantic write path;
// artifact-service exports the same types (`WriteUploadedArtifactInput`
// / `WriteUploadedArtifactResult`) as compatibility aliases.
//
// Invariants:
//  - The substrate writer is intentionally unavailable; writes must go through
//    the semantic artifact model.
//  - Do not leave a callable writer against the `artifact_versions` table.
//  - Creation is enabled only through the semantic writer.

export type WriteUploadedArtifactInput = CreateSemanticArtifactInput;
export type WriteUploadedArtifactResult = CreateSemanticArtifactResult;

/**
 * @deprecated Delegates to the canonical `createSemanticArtifact`. New callers
 * should import the semantic writer directly.
 */
export async function writeUploadedArtifact(
  input: WriteUploadedArtifactInput,
): Promise<WriteUploadedArtifactResult> {
  return createSemanticArtifact(input);
}

export const FILE_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/file-artifact:artifact";

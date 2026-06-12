import "server-only";

// ---------------------------------------------------------------------------
// Blog post IDEA summary materializer + reader. Parallel to
// `src/lib/blog-post-artifact-materializer.ts`.
//
// The blog-post-idea record carried a free-form `summary: string` field.
// The host store keeps only refs + operational metadata, so the body lives in
// `@cinatra-ai/blog-idea-artifact`.
//
// Same identity rule (singleton-org, asset-blog single-tenant) +
// `liveOnly: true` reader as the image / post-body materializers.
//
// `@cinatra-ai/blog-idea-artifact` accepts `text/markdown` + `text/plain`;
// we choose `text/markdown` for agent-produced summaries (consistent with
// blog-post-artifact). The matcher's 0.7 confidence floor does NOT gate
// `assertedBy: "agent"` writes; explicit agent assertions use
// `skipFallbackClassification: true`.
// ---------------------------------------------------------------------------

import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import { assertSemanticType } from "@/lib/artifacts/semantic-assertion-store";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { resolveSingletonBlogOrgId } from "@/lib/blog-image-materializer";
// Target type via the manifest-declared "artifact-blog-idea-summary"
// extension role — fail-loud when absent (cinatra#151 Stage 6).
import { requireExtensionRole } from "@/lib/extension-roles";

export type MaterializeBlogIdeaInput = {
  /** UTF-8 markdown idea summary string. */
  summary: string;
  title?: string;
  createdByRunId?: string | null;
};

export type MaterializeBlogIdeaResult = {
  artifactId: string;
  representationRevisionId: string;
};

async function* asTextStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export async function materializeBlogIdeaArtifact(
  input: MaterializeBlogIdeaInput,
): Promise<MaterializeBlogIdeaResult> {
  // Resolve the target type FIRST (fail-loud in reduced universes) so an
  // absent claimant never leaves an orphaned floor-only artifact behind.
  const targetExtension = requireExtensionRole("artifact-blog-idea-summary");
  const orgId = await resolveSingletonBlogOrgId();
  const bytes = Buffer.from(input.summary, "utf-8");
  const result = await createSemanticArtifact({
    orgId,
    createdBy: null,
    ownerLevel: "organization",
    ownerId: orgId,
    title: input.title,
    declaredMime: "text/markdown",
    originKind: "agent_generated",
    stream: asTextStream(bytes),
    createdByRunId: input.createdByRunId ?? null,
    skipFallbackClassification: true,
  });

  assertSemanticType({
    orgId,
    artifactId: result.artifactId,
    extension: targetExtension,
    assertedBy: "agent",
    principal: null,
  });

  return {
    artifactId: result.artifactId,
    representationRevisionId: result.representationRevisionId,
  };
}

export type ReadBlogIdeaArtifactBytesInput = {
  artifactId: string;
  representationRevisionId: string;
};

export type ReadBlogIdeaArtifactBytesResult = {
  summary: string;
  mime: string;
};

export async function readBlogIdeaArtifactBytes(
  input: ReadBlogIdeaArtifactBytesInput,
): Promise<ReadBlogIdeaArtifactBytesResult | null> {
  const orgId = await resolveSingletonBlogOrgId();
  const resolution = resolveArtifactVersionForServe({
    orgId,
    artifactId: input.artifactId,
    representationRevisionId: input.representationRevisionId,
    liveOnly: true,
  });
  if (!resolution) return null;
  const store = createLocalDiskBlobStore();
  const handle = await store.openByStorageKey({
    orgId,
    storageKey: resolution.storageKey,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of handle.stream) {
    chunks.push(Buffer.from(chunk));
  }
  return {
    summary: Buffer.concat(chunks).toString("utf-8"),
    mime: resolution.mime,
  };
}

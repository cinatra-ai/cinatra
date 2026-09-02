import "server-only";

// ---------------------------------------------------------------------------
// Blog post IDEA summary READER. Parallel to
// `src/lib/blog-post-artifact-materializer.ts`.
//
// The blog-post-idea record carried a free-form `summary: string` field.
// The host store keeps only refs + operational metadata, so the body lives in
// `@cinatra-ai/blog-idea-artifact`.
//
// The in-core idea WRITER that used to live here is GONE (cinatra#3034): a
// call-site census over the whole tree found no caller, and an idea is now
// filed through the declarative binding road — the idea generator's fan-out
// over its plain-text ideas, one artifact per idea. What remains is the
// reader, on the same identity rule (singleton-org, asset-blog single-tenant)
// and the same `liveOnly: true` default as the image / post-body readers; the
// publish path still reads an idea's bytes through it.
// ---------------------------------------------------------------------------

import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { resolveSingletonBlogOrgId } from "@/lib/blog-image-materializer";

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

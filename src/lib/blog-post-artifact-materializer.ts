import "server-only";

// ---------------------------------------------------------------------------
// Blog post BODY materializer + reader. Parallel to
// `src/lib/blog-image-materializer.ts` for canonical image artifacts.
//
// Identity derivation: singleton-org rule shared with the image materializer.
// asset-blog uses a singleton organization; the resolver fails loud on 0 or
// >1 organizations. The intended owner source is per-actor context once the
// blog-pipeline-agent path is the sole producer. Cache via the shared resolver
// in `blog-image-materializer` to keep ONE source of truth for the org id.
//
// Regen pattern: each body update / save creates a NEW artifact id (ref
// swap). Editor saves debounce upstream — every persisted save mints one
// new revision, matching the image regen contract.
//
// Reader: `liveOnly: true` — the same tombstone-replay BLOCKER the image
// reader carries. Internal publish/UI reads have no actor-visibility check; a
// tombstoned-but-pinned representation must NOT replay through these helpers.
//
// `@cinatra-ai/blog-post-artifact` accepts `text/markdown` only; the
// matcher's confidence floor (0.7) does NOT gate `assertedBy: "agent"`
// writes — `skipFallbackClassification: true` + an explicit assertion is
// the canonical agent-write pattern.
//
// LinkedIn copy reuses this same artifact extension to avoid premature
// abstraction.
// ---------------------------------------------------------------------------

import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import { assertSemanticType } from "@/lib/artifacts/semantic-assertion-store";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { resolveSingletonBlogOrgId } from "@/lib/blog-image-materializer";

export type MaterializeBlogPostBodyInput = {
  /** UTF-8 markdown body string. */
  content: string;
  /** Optional human-readable title (artifact title metadata). */
  title?: string;
  createdByRunId?: string | null;
};

export type MaterializeBlogPostBodyResult = {
  artifactId: string;
  representationRevisionId: string;
};

async function* asTextStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export async function materializeBlogPostBodyArtifact(
  input: MaterializeBlogPostBodyInput,
): Promise<MaterializeBlogPostBodyResult> {
  const orgId = await resolveSingletonBlogOrgId();
  const bytes = Buffer.from(input.content, "utf-8");
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
    extension: "@cinatra-ai/blog-post-artifact",
    assertedBy: "agent",
    principal: null,
  });

  return {
    artifactId: result.artifactId,
    representationRevisionId: result.representationRevisionId,
  };
}

// ---------------------------------------------------------------------------
// Reader — `liveOnly: true`. Returns the markdown body decoded from the
// representation bytes. NULL when the representation is unresolvable
// (typically a stale ref pointing at a missing / tombstoned artifact).
// ---------------------------------------------------------------------------

export type ReadBlogPostBodyArtifactBytesInput = {
  artifactId: string;
  representationRevisionId: string;
};

export type ReadBlogPostBodyArtifactBytesResult = {
  body: string;
  mime: string;
};

export async function readBlogPostBodyArtifactBytes(
  input: ReadBlogPostBodyArtifactBytesInput,
): Promise<ReadBlogPostBodyArtifactBytesResult | null> {
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
    body: Buffer.concat(chunks).toString("utf-8"),
    mime: resolution.mime,
  };
}

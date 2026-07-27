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
import { resolveBoundArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";
import { assertSemanticType } from "@/lib/artifacts/semantic-assertion-store";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { resolveSingletonBlogOrgId } from "@/lib/blog-image-materializer";
// The target semantic artifact type resolves from the manifest-declared
// "artifact-blog-post-body" extension role — fail-loud when the blog
// artifact universe is absent (cinatra#151 Stage 6); never a hard-coded
// package name, never a dangling assertion on a non-present type.
import { requireExtensionRole } from "@/lib/extension-roles";

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
  // Resolve the target type FIRST (fail-loud in reduced universes) so an
  // absent claimant never leaves an orphaned floor-only artifact behind.
  const targetExtension = requireExtensionRole("artifact-blog-post-body");
  const orgId = await resolveSingletonBlogOrgId();
  // Resolve the target extension's EXACT declared object type (epic #1785 wave
  // A3 — the writer requires a concrete type; the generic default is retired).
  const resolvedTarget = await resolveBoundArtifactTarget({
    orgId,
    extension: targetExtension,
  });
  if (!resolvedTarget.ok) {
    throw new Error(
      `blog-post body materialization: extension "${targetExtension}" resolves no declared artifact object type: ${resolvedTarget.error}`,
    );
  }
  const bytes = Buffer.from(input.content, "utf-8");
  const result = await createSemanticArtifact({
    orgId,
    objectType: resolvedTarget.target.objectTypeId,
    expectedAcceptMimes: resolvedTarget.target.acceptedFileMimeTypes,
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

  // Post-Tx CLASSIC assertion. On an org that does NOT hold the pack's claim
  // this is what stamps the blog-post identity onto the fresh row.
  //
  // On an org that DOES hold it (cinatra#2047 D-8), `createSemanticArtifact`
  // has already composed the binding reconcile into its Tx2 and committed a
  // BINDING-basis assertion for the very same extension — the claim winner for
  // the declared type. This call then correctly returns
  // `blockedByPrecedence` and writes nothing: a classic never displaces a
  // binding (epic #1424), and the identity the caller wants is already on the
  // row with strictly higher authority. Before the store-level fix the INSERT
  // fired anyway and collided with `sa_active_unique_idx`, throwing AFTER the
  // artifact had committed — an orphaned row on every claim-holding org.
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

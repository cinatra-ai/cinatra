import "server-only";

// ---------------------------------------------------------------------------
// Blog image artifact materializer.
//
// Pushes Gemini-produced blog hero/inline image bytes through the
// semantic-artifact pipeline so they land as `@cinatra-ai/blog-image-artifact`
// rows as canonical image content.
//
// Identity derivation: asset-blog is single-tenant. Its metadata blob
// `source_config:asset-blog` has no per-org column, and shadow rows in
// `cinatra.objects` are written with org_id=null. The materializer normalizes
// that NULL tenant into the single Better Auth `organization` row. Fails loud
// if 0 or >1 orgs exist; callers must enforce singleton semantics for
// asset-blog.
//
// Regen pattern: each regen creates a NEW artifact id. We do NOT use
// `appendRepresentation` to grow an existing artifact. The simpler "ref swap"
// keeps the materializer a thin one-shot. The post draft store updates
// `imageArtifactId` + `imageRepresentationRevisionId` to the new pair on
// every regen.
// ---------------------------------------------------------------------------

import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import { assertSemanticType } from "@/lib/artifacts/semantic-assertion-store";
// Target type via the manifest-declared "artifact-blog-image" extension
// role — fail-loud when absent (cinatra#151 Stage 6).
import { requireExtensionRole } from "@/lib/extension-roles";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { betterAuthDb, betterAuthOrganizations } from "@/lib/better-auth-db";

export type MaterializeBlogImageInput = {
  imageBase64: string;
  imageMimeType: string;
  title?: string;
  createdByRunId?: string | null;
};

export type MaterializeBlogImageResult = {
  artifactId: string;
  representationRevisionId: string;
};

async function* asImageStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

let _cachedSingletonOrgId: string | null = null;

// Exported so the post-body + idea-summary materializers share one resolver
// because asset-blog is single-tenant.
export async function resolveSingletonBlogOrgId(): Promise<string> {
  if (_cachedSingletonOrgId) return _cachedSingletonOrgId;
  const rows = await betterAuthDb
    .select({ id: betterAuthOrganizations.id })
    .from(betterAuthOrganizations);
  if (rows.length === 0) {
    throw new Error(
      "[blog-image-materializer] no `auth.organization` row found — " +
        "asset-blog is single-tenant; one organization must exist.",
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `[blog-image-materializer] found ${rows.length} \`auth.organization\` ` +
        "rows but asset-blog is single-tenant. This resolver requires " +
        "exactly one organization while asset-blog produces images without " +
        "actor context.",
    );
  }
  const id = rows[0].id;
  if (!id) {
    throw new Error(
      "[blog-image-materializer] singleton organization row has a null id.",
    );
  }
  _cachedSingletonOrgId = id;
  return id;
}

export async function materializeBlogImageArtifact(
  input: MaterializeBlogImageInput,
): Promise<MaterializeBlogImageResult> {
  // Resolve the target type FIRST (fail-loud in reduced universes) so an
  // absent claimant never leaves an orphaned floor-only artifact behind.
  const targetExtension = requireExtensionRole("artifact-blog-image");
  const orgId = await resolveSingletonBlogOrgId();
  const bytes = Buffer.from(input.imageBase64, "base64");
  const result = await createSemanticArtifact({
    orgId,
    createdBy: null,
    ownerLevel: "organization",
    ownerId: orgId,
    title: input.title,
    declaredMime: input.imageMimeType,
    originKind: "agent_generated",
    stream: asImageStream(bytes),
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

// ---------------------------------------------------------------------------
// Blog image artifact publish read helper.
//
// Server-side helper for reading the raw image bytes from a
// `@cinatra-ai/blog-image-artifact` representation. Used by the
// asset-blog publish path, which uploads bytes to WordPress media.
//
// Resolves to the singleton org (same identity rule as the materializer) so a
// single read can serve every asset-blog project. Returns null when the
// representation is not resolvable, typically a stale ref pointing at a
// missing artifact.
// ---------------------------------------------------------------------------

export type ReadBlogImageArtifactBytesInput = {
  imageArtifactId: string;
  imageRepresentationRevisionId: string;
};

export type ReadBlogImageArtifactBytesResult = {
  imageBase64: string;
  imageMimeType: string;
};

export async function readBlogImageArtifactBytes(
  input: ReadBlogImageArtifactBytesInput,
): Promise<ReadBlogImageArtifactBytesResult | null> {
  const orgId = await resolveSingletonBlogOrgId();
  // `liveOnly: true` because this helper is an internal publish read with NO
  // actor-visibility check. The default deleted-allowed override is route-only
  // and actor-visibility-gated in `resolveArtifactVersionForServe`; using it
  // here would let a tombstoned-but-pinned representation replay into
  // WordPress.
  const resolution = resolveArtifactVersionForServe({
    orgId,
    artifactId: input.imageArtifactId,
    representationRevisionId: input.imageRepresentationRevisionId,
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
    imageBase64: Buffer.concat(chunks).toString("base64"),
    imageMimeType: resolution.mime,
  };
}

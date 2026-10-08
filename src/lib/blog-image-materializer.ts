import "server-only";

// ---------------------------------------------------------------------------
// Blog image artifact helpers.
//
// Identity derivation: asset-blog is single-tenant. Its metadata blob
// `source_config:asset-blog` has no per-org column, and shadow rows in
// `cinatra.objects` are written with org_id=null. resolveSingletonBlogOrgId
// normalizes that NULL tenant into the single Better Auth `organization` row.
// Fails loud if 0 or >1 orgs exist; callers must enforce singleton semantics
// for asset-blog.
// ---------------------------------------------------------------------------

import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import { betterAuthDb, betterAuthOrganizations } from "@/lib/better-auth-db";

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

// ---------------------------------------------------------------------------
// Blog image artifact publish read helper.
//
// Server-side helper for reading the raw image bytes from a
// `@cinatra-ai/blog-image-artifact` representation. Used by the
// asset-blog publish path, which uploads bytes to WordPress media.
//
// Resolves to the singleton org (the identity rule above) so a
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

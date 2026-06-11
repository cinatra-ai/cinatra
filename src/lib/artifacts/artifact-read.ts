import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";

// Serve-side resolver. Tenant isolation is enforced HERE: a representation is
// only resolvable when org_id + artifact_id + representation.id all match. Blob
// identity is always tenant/version scoped; sha is never an addressing/authz
// signal.
//
// Resolves through the semantic data model:
// `representation` -> `resource` -> `artifact_blobs`. Returns `storageKey`
// (resource-bound, dedupe-stable) rather than `blobId` so the blob store opens
// by storage key directly.

export type ServeResolution = {
  storageKey: string;
  mime: string;
  sizeBytes: number;
  originKind: string;
};

export function resolveArtifactVersionForServe(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  // The deleted-allowed pin override is ROUTE-only, gated by the route's
  // actor-visibility check. Internal callers (LLM bridge, agent runs) pass
  // `liveOnly: true` so they CANNOT replay a tombstoned-pinned representation:
  // the LLM bridge does not currently enforce per-actor visibility, and the
  // pin override must not widen the bridge's read surface.
  liveOnly?: boolean;
}): ServeResolution | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        // Semantic-model serve path.
        //  - `representation` is the immutable pin (replay-safe);
        //  - `resource` is the substance-keyed dedupe layer (storage_key
        //    + blob_id stored in metadata jsonb — see createSemanticArtifact);
        //  - `artifact_blobs` is the physical-bytes registry.
        //
        // Deleted-allowed serve replay: a tombstoned-but-pinned-by-`artifact_refs`
        // representation MUST stay resolvable until physical GC reclaims the
        // resource. The OR-clause below mirrors the invariant:
        // `o.deleted_at IS NULL` OR a pinning artifact_refs row exists on
        // (artifact, representation).
        text: `SELECT b.storage_key, r.mime, r.size_bytes
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r
  ON r.id = rep.resource_id AND r.org_id = rep.org_id
LEFT JOIN "${schema}"."artifact_blobs" b
  ON b.id = (r.metadata->>'blobId') AND b.org_id = r.org_id
JOIN "${schema}"."objects" o
  ON o.id = rep.artifact_id AND o.org_id = rep.org_id
WHERE rep.id = $1 AND rep.artifact_id = $2 AND rep.org_id = $3
  AND r.kind = 'blob'
  AND o.type = $4
  AND (
    o.deleted_at IS NULL
    ${input.liveOnly ? "" : `OR EXISTS (
      SELECT 1 FROM "${schema}"."artifact_refs" ar
      WHERE ar.org_id = rep.org_id
        AND ar.artifact_id = rep.artifact_id
        AND ar.representation_revision_id = rep.id
    )`}
  )
LIMIT 1`,
        values: [
          input.representationRevisionId,
          input.artifactId,
          input.orgId,
          SEMANTIC_ARTIFACT_OBJECT_TYPE,
        ],
      },
    ],
  });
  const row = res?.rows?.[0] as
    | {
        storage_key: string | null;
        mime: string;
        size_bytes: string | number;
      }
    | undefined;
  if (!row || !row.storage_key) return null;
  return {
    storageKey: row.storage_key,
    mime: row.mime,
    sizeBytes:
      typeof row.size_bytes === "number"
        ? row.size_bytes
        : Number(row.size_bytes),
    // `originKind` is decorative in the serve resolver and is not validated
    // downstream by attachment-resolver ports. Use a static value; semantic
    // identity lives in `semantic_assertion`, and per-row originKind is on
    // `objects.data.originKind` for callers that need it.
    originKind: "upload",
  };
}

// MIMEs the preview route's MIME-aware handlers can safely render
// inline under a sandbox CSP. The download route NEVER uses this allowlist —
// it always serves with `Content-Disposition: attachment`. By design:
// `downloadDispositionFor` + `previewDispositionFor` are two distinct
// helpers so neither can be subverted into the other's behaviour by a
// future MIME-allowlist edit; the helpers are also unit-paired in
// `__tests__/dispositions.test.ts` to catch any future regression where
// one's behaviour leaks into the other.
//
// HTML stays excluded because it would execute scripts even under the
// preview sandbox (sandbox blocks scripts; HTML preview is therefore a
// metadata-card fallback, not an inline render). PDF is sandbox-friendly
// in `<embed>` form (browser's bundled PDF viewer); the preview route's
// CSP is `sandbox` (no privileges) which most browsers tolerate for the
// PDF viewer because it runs in its own isolated process.
//
// Video/audio entries are passive media — no script surface under the
// preview CSP; the browser's media stack renders them (`<video>`/`<audio>`
// in the detail-page handlers, range-served by the preview route). The
// set stays exact-string (NO wildcard `video/*` matching) and is limited
// to containers browsers broadly play natively. `video/quicktime` and
// `video/x-msvideo` stay excluded: codec support is too inconsistent for
// an inline player, so they keep the metadata-card + download fallback.
const PREVIEW_INLINE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/aac",
]);

/** Test-only export so unit tests can reason about the allowlist without
 * importing the production set directly (keeps the production set
 * private-by-convention). */
export const PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS = PREVIEW_INLINE_MIME_ALLOWLIST;

/**
 * True when `mime` may be served inline by the preview route. Server-side
 * consumers (e.g. the dashboard portlet loaders) use this to decide whether
 * to hand a client a `/preview` href at all. The route itself stays the
 * enforcement point (415 short-circuit + `previewDispositionFor` fallback);
 * this predicate only avoids minting hrefs that would 415.
 */
export function isPreviewInlineMime(mime: string): boolean {
  return PREVIEW_INLINE_MIME_ALLOWLIST.has(mime);
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "artifact";
}

/**
 * Disposition header for the DOWNLOAD route. ALWAYS `attachment` — never
 * `inline`, regardless of MIME type. Used by
 * `src/app/api/artifacts/[artifactId]/versions/[versionId]/content/route.ts`.
 *
 * Guardrail: this helper and `previewDispositionFor` do NOT share
 * a code path that could be subverted by a future MIME-allowlist edit. Any
 * change here must keep the always-`attachment` contract intact (proven
 * by `dispositions.test.ts`).
 */
export function downloadDispositionFor(_mime: string, filename: string): string {
  return `attachment; filename="${sanitizeFilename(filename)}"`;
}

/**
 * Disposition header for the PREVIEW route. Returns `inline` if and only
 * if the MIME is in `PREVIEW_INLINE_MIME_ALLOWLIST`; otherwise falls
 * through to `attachment` as the safe default (the preview route also
 * 415s when called with a non-allowlisted MIME — this helper is the
 * second layer of defence).
 *
 * Used by
 * `src/app/api/artifacts/[artifactId]/versions/[versionId]/preview/route.ts`.
 */
export function previewDispositionFor(mime: string, filename: string): string {
  const safe = sanitizeFilename(filename);
  return PREVIEW_INLINE_MIME_ALLOWLIST.has(mime)
    ? `inline; filename="${safe}"`
    : `attachment; filename="${safe}"`;
}

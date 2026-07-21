import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { ensureArtifactTypesRegistered } from "./ensure-artifact-registry";

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
  // The registered isArtifact pack types (read at CALL time — never a frozen
  // module-load snapshot). A pack-typed row's DIRECT (uploaded/latest,
  // non-snapshot) representation must serve; the generic-literal gate alone
  // 404s it (epic #1785 wave A4). Warm the registry first: the serve routes do
  // not transitively trigger boot registration, so a cold process would see an
  // empty artifact-type set and strand every pack row.
  ensureArtifactTypesRegistered();
  const artifactTypeIds = objectTypeRegistry.listArtifacts().map((d) => d.type);
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
  AND (
    o.type = $4
    -- cinatra#1430: a typed row's CONTENT SNAPSHOT representation serves by
    -- its IMMUTABLE object_content_snapshots row — never by the row's
    -- CURRENT binding state. Replay-safety: a pinned selection must keep
    -- serving after binding retirement/reclassification (the pin +
    -- retention machinery governs lifetime), and a REPLACEMENT binding
    -- must not indiscriminately admit another claimant's snapshots — the
    -- admission is per-representation, keyed to the exact snapshot row.
    OR EXISTS (
      SELECT 1 FROM "${schema}"."object_content_snapshots" snap
      WHERE snap.org_id = rep.org_id AND snap.object_id = rep.artifact_id
        AND snap.representation_revision_id = rep.id
    )
    -- epic #1785 wave A4: a registered isArtifact PACK-typed row serves its
    -- DIRECT (uploaded/latest, non-snapshot) representation — the A3 writer
    -- stamps the exact pack type into objects.type instead of the retired
    -- generic base. Guarded by NOT-claimed: a CLAIMED row (any eligible
    -- binding) keeps serving ONLY through its content snapshot above
    -- (cinatra#1430 claimant-isolation/redaction preserved), never its
    -- latest representation.
    OR (
      o.type = ANY($5::text[])
      AND NOT EXISTS (
        SELECT 1 FROM "${schema}"."semantic_assertion" bnd
        WHERE bnd.org_id = rep.org_id AND bnd.artifact_id = rep.artifact_id
          AND bnd.assertion_basis = 'binding' AND bnd.eligibility = 'eligible'
      )
    )
  )
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
          artifactTypeIds,
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

// The host SAFE-TRANSPORT FORMAT SET — the concrete MIMEs the four build-bundled
// SYSTEM `-artifact` bases (image/pdf/audio/video) are permitted to inline-serve.
//
// ROLE (cinatra#1630 AC-2, the preview-serving decoupling): this set is NO LONGER
// the preview route's eligibility gate. Preview eligibility now resolves through
// the effective representation-provider CAPABILITY (`isInlineTransportEligible`,
// `src/app/artifacts/[id]/renderer-resolution.ts`) — so an admitted marketplace
// preview provider can add a previewable type WITHOUT a host edit, and an
// archived/retired provider fails closed. What this set still does is BOUND the
// system bases' WILDCARD providers: the boot registrar
// (`system-artifact-renderer-registrar.ts`) expands each base's declared
// `image/*`/`audio/*`/`video/*` to exactly these concrete MIMEs, so a raw wildcard
// can never claim a row the byte transport cannot safely render (e.g. `image/bmp`,
// `audio/midi`, `video/quicktime`). Concrete provider declarations (the pdf base's
// exact `application/pdf`, or a moderated marketplace provider) are trusted as
// declared + admitted; the wildcard bound applies only to the system bases.
//
// The download route NEVER consults this set — it always serves
// `Content-Disposition: attachment`. `downloadDispositionFor` + `previewDispositionFor`
// stay two distinct helpers so neither can be subverted into the other's behaviour;
// they are unit-paired in `__tests__/dispositions.test.ts`.
//
// HTML is absent because it would execute scripts even under the preview sandbox
// (metadata-card fallback, not an inline render). Video/audio entries are passive
// media (no script surface under the sandbox CSP), range-served by the preview
// route. The set stays exact-string (NO wildcard matching); `video/quicktime` /
// `video/x-msvideo` stay out (codec support too inconsistent for an inline player).
const PREVIEW_INLINE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  // Required text/JSON bases (epic #1883 A1): non-executable text formats that
  // render safely under the same preview sandbox CSP + `nosniff` as text/plain
  // (no script surface). This is what bounds text-artifact's `text/csv` and
  // json-artifact's `application/json` to inline byte-serving; their system-base
  // detail renderers (a sandboxed text frame / the collapsible JSON tree) fetch
  // `urls.preview`, which 415s any type absent from this set.
  "text/csv",
  "application/json",
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

/** Test-only export so unit tests + the boot registrar can reason about the
 * host safe-transport format set without importing the production constant
 * directly (keeps the production set private-by-convention). This is the
 * system-base wildcard bound (see the constant's doc) — NOT the preview route's
 * eligibility gate, which resolves through the representation-provider capability. */
export const PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS = PREVIEW_INLINE_MIME_ALLOWLIST;

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
 * Disposition header for the PREVIEW route. Returns `inline` when the caller
 * has resolved the representation as inline-transport eligible (through the
 * representation-provider capability — see `isInlineTransportEligible`),
 * otherwise `attachment` as the safe default. Takes the RESOLVED eligibility
 * boolean rather than the MIME so the disposition can never re-derive a stale
 * concrete-MIME allowlist (cinatra#1630 AC-2): eligibility is decided once, at
 * the capability, and the route 415s an ineligible representation before this
 * helper is reached — so on the served path this is always `inline`.
 *
 * Guardrail: this helper and `downloadDispositionFor` stay two distinct
 * helpers (unit-paired in `dispositions.test.ts`) so a preview refactor can
 * never make the download route serve `inline`.
 *
 * Used by
 * `src/app/api/artifacts/[artifactId]/versions/[versionId]/preview/route.ts`.
 */
export function previewDispositionFor(inlineEligible: boolean, filename: string): string {
  const safe = sanitizeFilename(filename);
  return inlineEligible
    ? `inline; filename="${safe}"`
    : `attachment; filename="${safe}"`;
}

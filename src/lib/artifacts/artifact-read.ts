import "server-only";
import { createHash } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { ensureArtifactTypesRegistered } from "./ensure-artifact-registry";
import { artifactWriterWitnessExistsSql } from "./artifact-writer-witness";

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
  /** The representation form the SUBSTRATE recorded for this revision.
   *
   * The join below admits a row on `resource.kind = 'blob'` and does NOT
   * constrain `representation.form`, so "this resolved, therefore it is a file
   * form" is an inference, not a fact. A caller that has to tell the content
   * channel what form a revision is (lifecycle-c W9) must be able to say what
   * the substrate says, never what the resolution implies — the channel's own
   * rule is that it is told the substrate's form and never a caller claim.
   * `null` only where a legacy row records no form at all. */
  form: string | null;
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
        text: `SELECT b.storage_key, r.mime, r.size_bytes, rep.form
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
    --
    -- ...EXCEPT a representation THIS HOST'S ARTIFACT WRITER authored
    -- (cinatra#2047 OBS-1). A4's not-claimed guard was written when the A3
    -- writer minted NO binding, so "pack-typed AND claimed" could only mean a
    -- TYPED-DATA row — a row with no bytes of its own, whose only legitimate
    -- content is the policy-keyed object_content_snapshots representation #1430
    -- mints from objects.data (that IS the claimant-isolation/redaction surface:
    -- one claimant must not serve another claimant's snapshot of the SAME row
    -- data). cinatra#1868 then made createSemanticArtifact compose the binding
    -- reconcile into Tx2, so a genuine FILE artifact written on an org that
    -- HOLDS the pack's claim now carries an eligible binding too — and this
    -- guard stranded it: serve -> null, review target "revision-not-member",
    -- typed changes-request BLOCKED on a tombstoned-base witness (the #2047
    -- re-acceptance repro).
    --
    -- The admission is keyed to WRITER PROVENANCE OF THE EXACT REPRESENTATION,
    -- never to caller-supplied data. SCOPE, stated exactly: the predicate admits
    -- representations authored by a HOST ARTIFACT WRITER — createSemanticArtifact
    -- (the artifact write CHOKE POINT the lifecycle contract names and every
    -- materializer calls) and the two CMS capture writers, each emitting the
    -- 'create' artifact_audit row carrying this representation_revision_id inside
    -- the SAME transaction as the representation it describes. The table is
    -- append-only and NO objects/MCP write path, route, extension DB port,
    -- migration or trigger can reach it. It is a TRUST-BOUNDARY witness, not a
    -- DB-enforced one: trusted server code or direct SQL could mint it, the same
    -- trust boundary every server-only store already sits behind.
    --
    -- (An objects.data marker such as data.artifactType would NOT do:
    -- objects_save/objects_update merge caller-supplied fields into objects.data,
    -- so a claimed typed-DATA row could forge it and serve unredacted row content
    -- — the codex round caught exactly that; the forgery control in
    -- claimed-production-write-serve-review-2047.integration.test.ts pins it.)
    --
    -- Such a representation has NO snapshot policy to bypass: its bytes ARE its
    -- authored content, not a rendering of the mutable object row, so admitting it
    -- neither reads objects.data as content nor crosses a claimant boundary. A
    -- typed-DATA row keeps the strict snapshot-only path unchanged.
    --
    -- The witness predicate is the SHARED one (artifact-writer-witness.ts), the
    -- same fragment the context-candidate rule, the resolver and both
    -- selection-finalizer statements test — a writer and a reader cannot drift
    -- into "authored bytes no read path admits". The former gap here (the two CMS
    -- capture writers minted form='file' representations WITHOUT the audit row,
    -- so a future claim over either type would have stranded them) is CLOSED:
    -- both now emit the witness from that same builder, inside their own capture
    -- transaction.
    OR (
      o.type = ANY($5::text[])
      AND (
        NOT EXISTS (
          SELECT 1 FROM "${schema}"."semantic_assertion" bnd
          WHERE bnd.org_id = rep.org_id AND bnd.artifact_id = rep.artifact_id
            AND bnd.assertion_basis = 'binding' AND bnd.eligibility = 'eligible'
        )
        OR ${artifactWriterWitnessExistsSql(schema, {
          orgId: "rep.org_id",
          artifactId: "rep.artifact_id",
          representationRevisionId: "rep.id",
        })}
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
        form: string | null;
      }
    | undefined;
  if (!row || !row.storage_key) return null;
  return {
    storageKey: row.storage_key,
    mime: row.mime,
    form: row.form ?? null,
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

// ---------------------------------------------------------------------------
// THE NON-FILE REVISION READER (enabler 0.10 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The non-file revision reader: a
// membership-and-projection reader for resources that are not files verifies the
// exact organization, artifact and representation-revision tuple and returns its
// form and the pinned configuration record; the file-serving read stays
// file-only, and non-file props carry no preview or download address."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "the review path serves file-backed
// resources only, so a non-file artifact floors before any renderer runs,
// however good the renderer, and a revision of it carries nothing pinned to
// draw."
//
// WHY IT IS A SECOND READER AND NOT A WIDENING OF THE FIRST. The resolver above
// exists to answer "which BYTES may be streamed" — it joins `artifact_blobs`,
// it returns a storage key, and every caller of it hands that key to the blob
// store. A dashboard revision has no bytes and no storage key; widening that
// query to admit it would put a null storage key on a serving path and make
// every byte caller carry a branch it must never take. The plan says so
// directly: "the file-serving read stays file-only". So this is a sibling
// reader with the SAME tenant rule and a different projection.
//
// THE TENANT RULE IS IDENTICAL, and deliberately copied rather than shared:
// org_id + artifact_id + representation.id must all match, the object must be an
// artifact type, and a tombstoned object is refused unless a pinning
// `artifact_refs` row keeps it alive (the historical reading of enabler 0.9).
// A reader that quietly used a laxer rule than the byte reader would be a
// tenant-isolation hole with no bytes to make it obvious.
//
// THE PINNED CONFIGURATION RECORD lives on the REVISION, under the reserved
// `pinnedConfiguration` key of `representation.classifier_signals` — the only
// per-revision jsonb the substrate carries. That location is this slice's own
// call and is recorded as a deviation: the plan fixes that the record is
// "written by the owning system's twin writer on every upsert" and per-revision,
// but names no column, and a new column would be a migration this slice's issue
// says it does not expect. The dashboard twin writer that fills it is the
// sibling plan's ("the dashboard's is the first, wired in the sibling plan"), so
// TODAY this reader returns a null configuration for every existing dashboard
// revision — and says so honestly rather than inventing one.
// ---------------------------------------------------------------------------

/** The two non-file representation forms the substrate admits
 *  (`representation_form_chk`: 'file' | 'connectorRef' | 'dashboard'). */
export type NonFileRepresentationForm = "connectorRef" | "dashboard";

/** The reserved key the per-revision configuration record is written under. */
export const PINNED_CONFIGURATION_SIGNAL_KEY = "pinnedConfiguration";

export type NonFileRevisionResolution = {
  /** The form the substrate recorded for this revision — never a caller claim. */
  form: NonFileRepresentationForm;
  /** The resource's mime (e.g. `application/vnd.cinatra.dashboard+json`). */
  mime: string;
  /** The pinned configuration record for THIS revision, or null when the owning
   *  system's twin writer has not written one for it. */
  configuration: unknown | null;
  /** A stable digest of that record — the value a data capability is sealed to
   *  (enabler 0.12) — or null when there is no record. */
  configurationDigest: string | null;
};

/** Canonical JSON: object keys sorted at every depth, so two structurally equal
 *  configurations always digest identically. */
function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
    return out;
  };
  return JSON.stringify(norm(value));
}

/** The digest a data capability seals and the content channel carries. */
export function pinnedConfigurationDigest(configuration: unknown): string {
  return createHash("sha256").update(canonicalJson(configuration), "utf8").digest("hex");
}

/**
 * Resolve ONE non-file representation revision: verify the exact
 * (organization, artifact, representation-revision) tuple and project the
 * revision's form plus its pinned configuration record.
 *
 * `null` for every failure — a tuple that does not match, a FILE revision
 * (which belongs to the byte reader), a row in another tenant, or a tombstoned
 * object with no pin. One answer, so nothing here is an existence oracle.
 *
 * `liveOnly` defaults to TRUE, the safe reading: only the run-/gate-authorized
 * HISTORICAL reader of enabler 0.9 passes `false`, and it does so only after the
 * gate has vouched for the exact revision.
 */
export function resolveNonFileArtifactRevision(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  liveOnly?: boolean;
}): NonFileRevisionResolution | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  ensureArtifactTypesRegistered();
  const artifactTypeIds = objectTypeRegistry.listArtifacts().map((d) => d.type);
  const liveOnly = input.liveOnly !== false;
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT rep.form, r.mime, rep.classifier_signals
FROM "${schema}"."representation" rep
JOIN "${schema}"."resource" r
  ON r.id = rep.resource_id AND r.org_id = rep.org_id
JOIN "${schema}"."objects" o
  ON o.id = rep.artifact_id AND o.org_id = rep.org_id
WHERE rep.id = $1 AND rep.artifact_id = $2 AND rep.org_id = $3
  AND rep.form <> 'file'
  AND r.kind <> 'blob'
  AND (o.type = $4 OR o.type = ANY($5::text[]))
  AND (
    o.deleted_at IS NULL
    ${liveOnly ? "" : `OR EXISTS (
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
    | { form: string; mime: string; classifier_signals: unknown }
    | undefined;
  if (!row) return null;
  if (row.form !== "connectorRef" && row.form !== "dashboard") return null;

  let signals: Record<string, unknown> | null = null;
  const raw = row.classifier_signals;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        signals = parsed as Record<string, unknown>;
      }
    } catch {
      signals = null;
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    signals = raw as Record<string, unknown>;
  }
  const configuration =
    signals && Object.hasOwn(signals, PINNED_CONFIGURATION_SIGNAL_KEY)
      ? (signals[PINNED_CONFIGURATION_SIGNAL_KEY] ?? null)
      : null;

  return {
    form: row.form,
    mime: row.mime,
    configuration,
    configurationDigest: configuration === null ? null : pinnedConfigurationDigest(configuration),
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

import "server-only";
import { reviewPicturePrompt } from "@/lib/artifacts/review-surface-model";
import type { ActorContext } from "@/lib/authz/actor-context";
// Canonical `object.*` row authorization (cinatra#1428 RBAC matrix): the
// artifact surface enforces the SAME object authorization the objects
// surface routes through `enforceResourceAccess` — this sync core IS that
// decision (single implementation, no drift) — plus its own surface gating.
import {
  decideResourceAccessForActorContext,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import {
  listObjectsByFilter,
  getObjectById,
  type ObjectRecord,
} from "@/lib/objects-store";
import type { ArtifactObjectData } from "@cinatra-ai/artifacts";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";
import {
  objectTypeRegistry,
  isDispositionGovernedType,
  resolveTypeProjectionDisposition,
} from "@cinatra-ai/objects/registry";
import {
  createSemanticArtifact,
  ObjectsTypeNotRegisteredError,
  type CreateSemanticArtifactInput,
  type CreateSemanticArtifactResult,
} from "./artifact-creation";
import { resolveUploadArtifactType, normalizeMime } from "./upload-artifact-type-map";
import { tombstoneArtifact as retentionTombstone } from "./artifact-retention";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { listArtifactIdsForExtension } from "./semantic-assertion-store";
// Effective-identity service (epic #1785): the ONE resolution point for
// artifact identity — now TYPE-DRIVEN (the type's installed namespace-defining
// extension, else no primary). The enrichment below resolves THROUGH it and
// carries the raw eligible-extension summary set.
import {
  resolveArtifactEffectiveIdentities,
  resolveArtifactEffectiveIdentity,
  type ArtifactIdentityEnrichment,
  type EffectiveIdentity,
} from "@/lib/objects/effective-identity";

// Presentation-identity service (epic #1883 slice A6): the assertion-aware
// identity the renderer dispatch, the library Type facet, and row labeling
// present. DISTINCT from the effective identity above — that stays the shared,
// type-driven identity context selection / replay / Graphiti consume.
import {
  resolveArtifactPresentationIdentities,
  resolveArtifactPresentationIdentity,
  type PresentationIdentity,
} from "@/lib/objects/presentation-identity";

// The artifact object-types registry is populated only by
// registerAllObjectTypes() through the artifact extension registration
// bridge. The UI/MCP read paths don't transitively trigger it, so list/get
// would see an empty registry in a fresh process. Idempotent (registry is
// replace-by-id); guarded so it runs at most once per process.
//
// list/get filter on the generic SEMANTIC_ARTIFACT_OBJECT_TYPE (legacy rows,
// until the #1785 A6 purge) PLUS every registered isArtifact pack type read
// from the in-process registry — the A3 writer now stamps a row's EXACT
// declared pack type (`pdf-artifact:document`, …) into `objects.type` instead
// of the retired generic base, so a read filter pinned to the generic literal
// alone would strand every pack-typed row (invisible in the library, 404 in
// get/detail). Reading `objectTypeRegistry.listArtifacts()` keeps the surface
// pluggable: a newly-installed artifact pack appears with zero per-type
// branches here.
let _artifactRegistryReady = false;
function ensureArtifactRegistry(): void {
  if (_artifactRegistryReady) return;
  registerAllObjectTypes();
  _artifactRegistryReady = true;
}

// Canonical artifact service. This is the one write path: the upload route,
// the MCP CRUD layer, and the Artifacts library UI all call this service,
// never a second writer and never raw blob/object writes. Creation delegates
// to the single transactional writer; deletion delegates to the tombstone/
// retention path. Reads are object-store reads filtered to the registered
// artifact object types, so a new artifact type surfaces with zero per-type
// branches here.

export type ArtifactSummary = {
  artifactId: string;
  latestRepresentationRevisionId: string | null;
  objectType: string;
  artifactType: string;
  title: string | null;
  mime: string;
  size: number;
  originKind: string;
  createdAt: string;
  updatedAt: string;
  // Canonical ownership/visibility projection (read-only) for the library
  // surface's meta line (cinatra#1431 §II) — the SAME column model the raw
  // objects browser (§IV) shows. Projected straight from the object row; no
  // new query, no write.
  ownerLevel: "user" | "team" | "organization" | "workspace";
  visibility: "private" | "team" | "organization" | "public";
  // Scope projection for the library's scope filter (cinatra#2449) — the
  // owning locus id axis next to `ownerLevel`, projected straight from the
  // object row exactly like `ownerLevel` (no new query, no write). At
  // ownerLevel "team" `ownerId` is the owning team's id; at "user" it is the
  // owning user's id. `projectId` rides the objects.project_id column.
  ownerId: string | null;
  organizationId: string | null;
  projectId: string | null;
  // Semantic identity resolves through the effective-identity service
  // (epic #1785): `effectiveIdentity` is the type-driven resolution (the
  // installed namespace-defining extension, or no-primary); `primaryExtension`
  // is the summary string derived from it — the identity's extension, or NULL
  // when the row has no defining extension (the retired generic catch-all, an
  // uninstalled extension's type). `eligibleExtensions` stays the raw active
  // eligible set (not drafts).
  eligibleExtensions: string[];
  primaryExtension: string | null;
  effectiveIdentity: EffectiveIdentity;
  // Presentation identity (epic #1883 A6): the assertion-aware identity the
  // renderer dispatch, the library Type facet, and row labeling PRESENT — the
  // highest-ranked live classic assertion, else a threshold-passing matcher
  // draft, else the row's claim-backed / type-namespace identity. Diverges from
  // `effectiveIdentity` (the shared, type-driven identity) BY DESIGN; for a row
  // with no assertions it equals `effectiveIdentity`. `presentationSuggestions`
  // are the matcher-draft extensions offered as suggestion chips (A4 UI).
  presentationIdentity: EffectiveIdentity;
  presentationSuggestions: string[];
  /**
   * THE PROMPT THE ROW RECORDS IT WAS MADE FROM (cinatra#3080 item 5), projected
   * straight off the object row exactly like `ownerLevel` and `sourceUrl` — no
   * new query, no write, and read-only.
   *
   * It exists so the REVIEW SCREEN can pre-fill the prompt field beside its note
   * and send an edited one back with Regenerate. It is deliberately NOT in the
   * renderer props contract: a display shows the work, not the instructions the
   * work was made from.
   *
   * Optional so every existing caller and fixture keeps compiling; absent and
   * null mean the same thing — this row records no prompt.
   */
  recordedPrompt?: string | null;
  // Validated "Open in source application" URL for connector-ref artifacts,
  // projected from `objects.data.connectorRef.url` via
  // `connectorRefSourceUrl` (http/https only). Null for every artifact
  // without a connector-ref pointer — i.e. all blob/dashboard artifacts.
  sourceUrl: string | null;
};

/**
 * Typed connector-ref accessor: extract the safe external "open in source
 * application" URL from a raw `objects.data` value.
 *
 * `objects.data` is org-supplied JSONB, so the URL is untrusted input that
 * ends up in an `<a href>`. Only absolute `http:`/`https:` URLs pass
 * (`javascript:`, `data:`, relative paths, and malformed shapes all return
 * null); the canonical parsed `URL.href` is returned, never the raw string.
 */
export function connectorRefSourceUrl(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const ref = (data as { connectorRef?: unknown }).connectorRef;
  if (typeof ref !== "object" || ref === null) return null;
  const raw = (ref as { url?: unknown }).url;
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

// The admissible artifact object-type id set. Three sources, unioned:
//   1. the generic base (legacy rows, retired by the A6 purge);
//   2. every registered `isArtifact` pack type (the descriptor path — a
//      `kind:"artifact"` extension's first-class type);
//   3. every DISPOSITION-GOVERNED type whose type-driven projection resolves to
//      `artifact-safe` — a claim-backed HOST type (e.g. `@cinatra-ai/email:body`)
//      that ships an artifact-safe disposition WITHOUT an `isArtifact` descriptor
//      (cinatra#1867). Under the #1854/#1785 claim-based model a type can be
//      artifact-safe by DISPOSITION without being an artifact by DESCRIPTOR; the
//      library keyed only on the descriptor, so a fully-materialized
//      `email:body` row was library-invisible ("No artifacts yet"). This admits
//      it through the SAME #1785 A1 seam (`isDispositionGovernedType` +
//      `resolveTypeProjectionDisposition`) the projector / rebuild / recall use,
//      so the library agrees with those four surfaces on exactly which types are
//      artifact-safe/faceted. THIS disposition lane admits nothing more: a
//      `none`-projection sensitive type (e.g. `email:recipient`) and a
//      `raw`-projection data type are both excluded (only `"artifact-safe"`
//      passes), and an ungoverned data object (no declared disposition) never
//      enters. (Source 2 is independent: an `isArtifact` descriptor type stays
//      admitted regardless of any disposition it also declares.) Admissibility
//      is a TYPE filter only: every row it lets through still passes the
//      unchanged per-row SQL ownership filter AND the canonical `object.read`
//      kernel decision below, so the surface denies exactly what the objects
//      surface denies.
//
// Warms the registry first (idempotent) so the set is complete in a fresh
// process, and reads it at CALL time (never a frozen module-load snapshot) so a
// hot-installed pack/claim is admitted immediately.
function artifactObjectTypeIds(): Set<string> {
  ensureArtifactRegistry();
  const ids = new Set<string>([SEMANTIC_ARTIFACT_OBJECT_TYPE]);
  for (const def of objectTypeRegistry.listArtifacts()) ids.add(def.type);
  for (const def of objectTypeRegistry.list()) {
    if (
      isDispositionGovernedType(def.type) &&
      resolveTypeProjectionDisposition(def.type) === "artifact-safe"
    ) {
      ids.add(def.type);
    }
  }
  return ids;
}

/**
 * The registered artifact object-type ids, as a list (cinatra#3031, epic #3023
 * W7). The dependency-scoped reads of plan (C) 0.26 need the CANDIDATE set the
 * listing would otherwise read whole, so they can hand back only the admitted
 * subset — a read-only projection of the same registry the listing uses, never
 * a second source of truth about what an artifact type is.
 */
export function registeredArtifactTypeIds(): string[] {
  return [...artifactObjectTypeIds()].sort();
}

// ---------------------------------------------------------------------------
// Canonical object authorization (cinatra#1428 RBAC matrix).
//
// A faceted (artifact-eligible) row is governed by canonical `object.*`
// authorization: the artifact surface layers the SAME kernel decision the
// objects surface enforces (`enforceResourceAccess` → shared sync core) on
// top of the SQL ownership filter it already splices. Cross-surface
// invariant: neither surface returns a row the other would deny.
// ---------------------------------------------------------------------------

/** Lift an objects row into the generic authz envelope (objects have no
 *  co-owner table, so coOwnerUserIds is omitted — mirrors the objects MCP
 *  surface's `buildObjectResourceCheck`). */
function artifactRowResourceCheck(rec: ObjectRecord): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: rec.id,
    organizationId: rec.orgId ?? null,
    ownerLevel: normalizeOwnerLevel(rec.ownerLevel),
    ownerId: rec.ownerId,
    // Artifact rows may still carry composite visibility strings (the
    // pre-#1428-vocabulary values); the kernel `can()` does not consult
    // visibility, so pass null rather than coerce.
    visibility: null,
    projectId: rec.projectId,
  };
}

/** Sync canonical `object.*` gate for an artifact row. `true` = allowed.
 *  No actor (internal server-side callers) keeps today's trusted-path
 *  semantics — the SQL ownership filter is also skipped for those. */
function actorPassesObjectAuthz(
  rec: ObjectRecord,
  actor: ActorContext | undefined,
  op: "object.read" | "object.update" | "object.delete",
): boolean {
  if (!actor) return true;
  return (
    decideResourceAccessForActorContext(
      artifactRowResourceCheck(rec),
      actor,
      op,
    ) === null
  );
}

/** The summary `primaryExtension` string for a resolved identity: the type's
 *  defining extension when the identity names one, else NULL (no-primary — the
 *  retired generic catch-all or an uninstalled extension's type). The honest
 *  signal is `effectiveIdentity.kind`. */
function primaryExtensionOf(identity: EffectiveIdentity): string | null {
  return identity.kind === "extension" ? identity.extension : null;
}

const NO_PRIMARY_IDENTITY_FALLBACK: EffectiveIdentity = { kind: "no-primary" };

function toSummary(
  rec: {
    id: string;
    type: string;
    data: unknown;
    createdAt?: string;
    updatedAt?: string;
    ownerLevel?: "user" | "team" | "organization" | "workspace" | null;
    visibility?: "private" | "team" | "organization" | "public" | null;
    ownerId?: string | null;
    orgId?: string | null;
    projectId?: string | null;
  },
  semanticIdentity?: ArtifactIdentityEnrichment,
  presentation?: PresentationIdentity,
): ArtifactSummary {
  const d = (rec.data ?? {}) as Partial<ArtifactObjectData>;
  // Behavior-preserving default: with no presentation resolution (unit tests /
  // orgless callers), presentation identity IS the effective identity and there
  // are no suggestion chips — the same output as a row with no assertions.
  const effective = semanticIdentity?.identity ?? NO_PRIMARY_IDENTITY_FALLBACK;
  return {
    artifactId: rec.id,
    latestRepresentationRevisionId: d.latestRepresentationRevisionId ?? null,
    objectType: rec.type,
    artifactType: d.artifactType ?? "file",
    title: d.title ?? null,
    mime: d.mime ?? "application/octet-stream",
    size: typeof d.size === "number" ? d.size : 0,
    originKind: d.originKind ?? "upload",
    createdAt: rec.createdAt ?? "",
    updatedAt: rec.updatedAt ?? "",
    ownerLevel: rec.ownerLevel ?? "organization",
    visibility: rec.visibility ?? "organization",
    ownerId: rec.ownerId ?? null,
    organizationId: rec.orgId ?? null,
    projectId: rec.projectId ?? null,
    // Default to no-primary if the caller didn't enrich (e.g., from a
    // unit test that doesn't drive the resolver).
    eligibleExtensions: semanticIdentity?.eligibleExtensions ?? [],
    primaryExtension: semanticIdentity
      ? primaryExtensionOf(semanticIdentity.identity)
      : null,
    effectiveIdentity: effective,
    presentationIdentity: presentation?.identity ?? effective,
    presentationSuggestions: presentation?.suggestions ?? [],
    sourceUrl: connectorRefSourceUrl(rec.data),
    // cinatra#3080 item 5 — the prompt the row records it was made from, for the
    // review screen's own field. Read from the same `rec.data` bag every other
    // projection above comes from.
    recordedPrompt: reviewPicturePrompt({ properties: d as Record<string, unknown> }),
  };
}

/** Canonical creation entry: the single semantic write path. The upload
 *  route's required ownership is `organization`/orgId; other callers
 *  (MCP / agent-emit) supply their own ownership.
 *
 *  The upload path only knows a MIME, so this entry MAPS `declaredMime` to the
 *  exactly-one installed system-base artifact type (pdf/audio/video/image) and
 *  injects it as the writer's REQUIRED `objectType` (epic #1785, wave A3). A MIME
 *  no base pack accepts (or one accepted ambiguously) is REFUSED via
 *  `OBJECTS_TYPE_NOT_REGISTERED` before any blob IO — the generic catch-all is
 *  retired, so an untypable upload fails closed. Callers that already know their
 *  exact type call `createSemanticArtifact` directly. */
export async function createUploadedArtifact(
  input: Omit<CreateSemanticArtifactInput, "objectType">,
): Promise<CreateSemanticArtifactResult> {
  ensureArtifactRegistry();
  const resolution = resolveUploadArtifactType(input.declaredMime);
  if (!resolution.ok) {
    // Carry the STRUCTURED refusal class (cinatra#1890) so the upload route's
    // advisory channel branches on `kind` rather than parsing the message —
    // only `no_type` (a real MIME no installed type accepts) earns the
    // marketplace "install a type" recourse. `normalizedMime` is the exact MIME
    // the resolver refused on, so the advisory + deep link key on the same value.
    throw new ObjectsTypeNotRegisteredError(
      null,
      `upload cannot be typed to a system-base artifact pack: ${resolution.reason}`,
      undefined,
      { kind: resolution.kind, normalizedMime: normalizeMime(input.declaredMime ?? "") },
    );
  }
  return createSemanticArtifact({ ...input, objectType: resolution.objectTypeId });
}

// Compatibility aliases for WriteUploadedArtifact* type names.
export type WriteUploadedArtifactInput = CreateSemanticArtifactInput;
export type WriteUploadedArtifactResult = CreateSemanticArtifactResult;

/** List artifacts for an org, generically across ALL registered artifact
 *  types (no per-type branch). Actor-scoped via the object store's
 *  ownership filter.
 *
 *  Each summary is enriched with semantic identity
 *  (eligibleExtensions + primaryExtension) read from `semantic_assertion`.
 *  A single batched query fetches assertions for every artifact in the
 *  page, avoiding N+1. orgId must be non-null for enrichment to fire
 *  (null = no tenant boundary -> caller bug elsewhere, but we degrade
 *  gracefully to floor-default identity). */
export function listArtifacts(input: {
  orgId: string | null;
  actor?: ActorContext;
  limit?: number;
  // cinatra#3031 (epic #3023 W7, plan (C) 0.26): "the listing gains a filter by
  // type and a cursor in place of its flat cap." The filter narrows the type
  // set the listing reads at all — it is what a dependency-scoped read is
  // bounded to, so it runs BEFORE the per-type fetch rather than over its
  // result. An empty array means "no admitted type", which returns nothing;
  // `undefined` is the historical "every registered artifact type".
  types?: readonly string[];
  // The keyset the cursor rides on (see `listArtifactsPage`).
  before?: { createdAt: string; id: string };
  // Sealed-room read filter passthrough. When set, every per-type call to
  // `listObjectsByFilter` adds `AND project_id = $projectId` (subject to
  // CINATRA_SEALED_ROOM_ARTIFACTS / OBJECTS flags). Artifacts are objects,
  // so this rides the existing `objects.project_id` column with no separate
  // filter path.
  projectId?: string | null;
  // Config-supplied filter to artifacts whose eligible assertion set
  // includes the named extension. Applied as a QUERY-level id-set filter
  // BEFORE the limit/pagination slice (never a caller tenant override).
  extensionPackageName?: string;
}): ArtifactSummary[] {
  return scanArtifacts(input).rows.slice(
    0,
    typeof input.limit === "number" ? input.limit : undefined,
  );
}

/** The keyset one row rides on, in the order the listing sorts by. */
type ArtifactKey = { createdAt: string; id: string };

/**
 * ONE read of the store, with the boundary the read is provably complete down
 * to (cinatra#3031).
 *
 * `watermark` is the NEWEST last-row among the types whose fetch came back
 * SATURATED (as many rows as were asked for). Below it some type's fetch may be
 * incomplete, so it is the oldest point a page may end at; `null` means every
 * type ran out and the listing is exhausted. The paging loop needs this because
 * the per-type limit is applied in SQL while the authorization and extension
 * filters run afterwards in JS: a page whose rows are all filtered away is NOT
 * the end of the listing, and reporting it as one skips every older row for
 * good.
 */
function scanArtifacts(input: {
  orgId: string | null;
  actor?: ActorContext;
  limit?: number;
  types?: readonly string[];
  before?: ArtifactKey;
  projectId?: string | null;
  extensionPackageName?: string;
}): { rows: ArtifactSummary[]; watermark: ArtifactKey | null } {
  ensureArtifactRegistry();
  let typeIds = artifactObjectTypeIds();
  if (input.types !== undefined) {
    const wanted = new Set(input.types);
    typeIds = new Set([...typeIds].filter((t) => wanted.has(t)));
  }
  if (typeIds.size === 0) return { rows: [], watermark: null };
  // Resolve the extension id-set first so the per-type fetch can pre-filter
  // BEFORE applying the limit (correct pagination semantics).
  const extFilter =
    input.extensionPackageName && input.orgId !== null
      ? listArtifactIdsForExtension(input.orgId, input.extensionPackageName)
      : null;
  let rawRecs: ObjectRecord[] = [];
  const perTypeLimit = extFilter ? undefined : input.limit;
  let watermark: ArtifactKey | null = null;
  for (const typeId of typeIds) {
    const recs = listObjectsByFilter(
      {
        orgId: input.orgId,
        type: typeId,
        // When an extension filter is active, fetch without the per-type limit so
        // the filter applies BEFORE the final slice; otherwise keep the limit.
        limit: perTypeLimit,
        projectId: input.projectId ?? null,
        ...(input.before ? { before: input.before } : {}),
      },
      input.actor,
    );
    rawRecs.push(...recs);
    // Saturated: this type may have more rows below its last one, so the page
    // may not end below that row.
    if (typeof perTypeLimit === "number" && recs.length >= perTypeLimit) {
      const last = recs[recs.length - 1];
      if (last) {
        const key = { createdAt: last.createdAt, id: last.id };
        if (watermark === null || compareArtifactKeysDesc(key, watermark) < 0) watermark = key;
      }
    }
  }
  // Canonical object authorization post-filter (cinatra#1428): drop rows the
  // kernel `object.read` decision denies — the same per-row gate the objects
  // surface applies — so the two surfaces cannot diverge on role-permission
  // denials (the SQL ownership filter above already covers the data axis).
  if (input.actor) {
    rawRecs = rawRecs.filter((r) =>
      actorPassesObjectAuthz(r, input.actor, "object.read"),
    );
  }
  if (extFilter) rawRecs = rawRecs.filter((r) => extFilter.has(r.id));
  // Batched effective-identity resolution (cinatra#1426; avoids N+1 across
  // the page — one assertion query + one claim read + one install read).
  const identityByArtifact =
    input.orgId !== null
      ? resolveArtifactEffectiveIdentities({
          orgId: input.orgId,
          rows: rawRecs.map((r) => ({ id: r.id, type: r.type })),
        })
      : new Map<string, ArtifactIdentityEnrichment>();
  // Presentation identity (A6) — a second batched pass (active assertions ×
  // install/live × thresholds × the org toggle). Separate from the shared
  // effective-identity resolution above so that path stays untouched.
  const presentationByArtifact =
    input.orgId !== null
      ? resolveArtifactPresentationIdentities({
          orgId: input.orgId,
          rows: rawRecs.map((r) => ({ id: r.id, type: r.type })),
        })
      : new Map<string, PresentationIdentity>();
  const out: ArtifactSummary[] = rawRecs.map((r) =>
    toSummary(r, identityByArtifact.get(r.id), presentationByArtifact.get(r.id)),
  );
  // Same order the store applies per type, tie-broken the same way, so a page
  // boundary means the same thing on both sides of the merge.
  out.sort((a, b) =>
    compareArtifactKeysDesc(
      { createdAt: a.createdAt, id: a.artifactId },
      { createdAt: b.createdAt, id: b.artifactId },
    ),
  );
  return { rows: out, watermark };
}

/** `created_at DESC, id DESC` — the order the store applies, in JS. */
function compareArtifactKeysDesc(a: ArtifactKey, b: ArtifactKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

// ---------------------------------------------------------------------------
// THE CURSOR (cinatra#3031, epic #3023 W7; plan (C) enabler 0.26).
//
// "the listing returns one bounded page — a hundred rows unless asked for up to
// five hundred — with no continuation" was the whole of it before: a caller
// with more than five hundred artifacts could not reach the rest, and a flow
// reading a page per hundred ideas (§8.9) had no way to ask for the next one.
//
// The cursor is the LAST ROW OF THE PAGE, not an offset: `(createdAt, id)`,
// compared against the same `created_at DESC, id DESC` order the store sorts
// by. A row written between two pages therefore cannot shift a boundary and
// make the second page skip or repeat a row, which is exactly what an OFFSET
// does. It is opaque on purpose — base64 of a tuple, not a promise about the
// tuple's shape — so the paging key can change without breaking a caller that
// stored one.
// ---------------------------------------------------------------------------

/** The default page, and the ceiling a caller may ask for. */
export const ARTIFACT_PAGE_DEFAULT_LIMIT = 100;
export const ARTIFACT_PAGE_MAX_LIMIT = 500;
/** How many store scans one page may take before it returns short. */
const ARTIFACT_PAGE_MAX_SCANS = 25;

export type ArtifactPage = {
  artifacts: ArtifactSummary[];
  /** Pass back as `cursor` for the next page; null when the listing is exhausted. */
  nextCursor: string | null;
};

export function encodeArtifactCursor(row: { createdAt: string; artifactId: string }): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt, i: row.artifactId }),
    "utf8",
  ).toString("base64url");
}

/** Null for anything that is not a cursor this listing wrote. */
export function decodeArtifactCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      c?: unknown;
      i?: unknown;
    };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string") return null;
    // Shape is not enough: an unparsable timestamp would reach the store as a
    // `::timestamptz` cast and come back as an untyped database error rather
    // than as the stated refusal. (The cursor is NOT a capability and is not
    // signed — it only narrows a listing the caller is already authorised for,
    // so a forged one can reveal nothing the caller could not already read.)
    if (parsed.i === "" || Number.isNaN(Date.parse(parsed.c))) return null;
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}

export class ArtifactCursorRefusal extends Error {
  readonly reason = "invalid-cursor";
  constructor(cursor: string) {
    super(
      `artifacts_list: ${JSON.stringify(cursor.slice(0, 32))} is not a cursor this listing wrote — ` +
        `refusing rather than silently restarting from the first page`,
    );
    this.name = "ArtifactCursorRefusal";
  }
}

/**
 * One page of the listing, with the continuation. `listArtifacts` keeps its
 * flat-cap shape for every caller that had one.
 */
export function listArtifactsPage(input: {
  orgId: string | null;
  actor?: ActorContext;
  limit?: number;
  cursor?: string | null;
  types?: readonly string[];
  projectId?: string | null;
  extensionPackageName?: string;
}): ArtifactPage {
  const limit = Math.min(
    Math.max(1, input.limit ?? ARTIFACT_PAGE_DEFAULT_LIMIT),
    ARTIFACT_PAGE_MAX_LIMIT,
  );
  let before: { createdAt: string; id: string } | undefined;
  if (input.cursor) {
    const decoded = decodeArtifactCursor(input.cursor);
    // A cursor that does not decode is REFUSED, never treated as "no cursor":
    // silently restarting from the first page is how a paging loop turns into
    // an endless one that re-reads the same rows.
    if (!decoded) throw new ArtifactCursorRefusal(input.cursor);
    before = decoded;
  }
  // ONE scan is not enough to answer "is there another page". The per-type
  // limit is applied in SQL; the `object.read` authorization filter and the
  // extension id-set filter run afterwards in JS. A scan whose rows are all
  // filtered away therefore looks exactly like the end of the listing while
  // older readable rows are still there — and reporting it as the end skips
  // them for good. So the page is filled by scanning DOWN from the cursor,
  // each scan starting where the previous one is provably complete to.
  const seen = new Set<string>();
  const collected: ArtifactSummary[] = [];
  let boundary: ArtifactKey | null = before ?? null;
  let exhausted = false;
  let scans = 0;
  for (;;) {
    const scan = scanArtifacts({
      orgId: input.orgId,
      ...(input.actor ? { actor: input.actor } : {}),
      // One more than the page, so "is there another page" is answered by the
      // read itself rather than by a second count query.
      limit: limit + 1,
      ...(input.types !== undefined ? { types: input.types } : {}),
      ...(boundary ? { before: boundary } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.extensionPackageName ? { extensionPackageName: input.extensionPackageName } : {}),
    });
    for (const row of scan.rows) {
      if (seen.has(row.artifactId)) continue;
      seen.add(row.artifactId);
      collected.push(row);
    }
    scans += 1;
    if (scan.watermark === null) {
      // Every type ran out: what is in hand is the whole rest of the listing.
      exhausted = true;
      break;
    }
    const mark: ArtifactKey = scan.watermark;
    boundary = mark;
    const usableSoFar = collected.filter(
      (r) => compareArtifactKeysDesc({ createdAt: r.createdAt, id: r.artifactId }, mark) <= 0,
    );
    if (usableSoFar.length > limit) break;
    // A bounded walk: a listing that is almost entirely unreadable to this
    // actor returns a SHORT page with a continuation rather than spinning.
    if (scans >= ARTIFACT_PAGE_MAX_SCANS) break;
  }

  // Only rows at or above the last boundary are provably complete — below it a
  // saturated type may still hold rows this walk never read.
  const usable = exhausted
    ? collected
    : collected.filter(
        (r) =>
          boundary === null ||
          compareArtifactKeysDesc({ createdAt: r.createdAt, id: r.artifactId }, boundary) <= 0,
      );
  usable.sort((a, b) =>
    compareArtifactKeysDesc(
      { createdAt: a.createdAt, id: a.artifactId },
      { createdAt: b.createdAt, id: b.artifactId },
    ),
  );
  const page = usable.slice(0, limit);
  const last = page[page.length - 1];
  let nextCursor: string | null = null;
  if (usable.length > limit && last) {
    nextCursor = encodeArtifactCursor(last);
  } else if (!exhausted && boundary) {
    // The page is short only because rows were filtered away; the continuation
    // is the point the walk is complete to, not the last row it could show.
    nextCursor = encodeArtifactCursor({ createdAt: boundary.createdAt, artifactId: boundary.id });
  }
  return { artifacts: page, nextCursor };
}

/** Fetch one artifact (object metadata), actor-scoped. Null if not an
 *  artifact type or not visible to the actor. */
export function getArtifact(input: {
  artifactId: string;
  orgId: string | null;
  actor?: ActorContext;
  // `allowDeleted` lets the serve route's pin-override branch distinguish
  // "tombstoned-but-actor-visible" from "actor-denied". A pinned tombstone
  // is serveable only when the actor would have been allowed to see the live
  // artifact; the pin is not a backdoor around the ownership filter.
  allowDeleted?: boolean;
}): ArtifactSummary | null {
  const rec = getObjectById(
    input.artifactId,
    { orgId: input.orgId },
    input.actor,
    { allowDeleted: input.allowDeleted },
  );
  if (!rec) return null;
  ensureArtifactRegistry();
  if (!artifactObjectTypeIds().has(rec.type)) return null;
  // Canonical object authorization (cinatra#1428): the kernel `object.read`
  // decision gates this surface exactly like the objects surface — including
  // the `allowDeleted` pin-override branch, which is a tombstone-visibility
  // carve-out, never an authorization backdoor.
  if (!actorPassesObjectAuthz(rec, input.actor, "object.read")) return null;
  // Enrich through the effective-identity service (cinatra#1426): assertions
  // × claims × bindings × install status, never objects.type alone.
  const enrichment =
    input.orgId !== null
      ? resolveArtifactEffectiveIdentity({
          orgId: input.orgId,
          artifactId: rec.id,
          baseType: rec.type,
        })
      : undefined;
  const presentation =
    input.orgId !== null
      ? resolveArtifactPresentationIdentity({
          orgId: input.orgId,
          artifactId: rec.id,
          baseType: rec.type,
        })
      : undefined;
  return toSummary(rec, enrichment, presentation);
}

/**
 * Detail-page access outcome (cinatra#1431 §III). The consolidated `/artifacts`
 * detail route must DISTINGUISH the two nulls `getArtifact` collapses:
 *   - `not-found` — the row is absent, not an artifact type, or the actor's
 *     ownership filter would not even LIST it (the store returns null). The
 *     detail route 404s (existence stays hidden — never revealed to a caller
 *     who cannot list it).
 *   - `denied` — the row IS an artifact the actor can list, but the canonical
 *     `object.read` decision refuses it. Per spec §III ("a row the viewer may
 *     list but not read opens to a not-authorized panel, never to its bytes")
 *     the detail route renders the not-authorized panel, NOT a 404.
 */
export type ArtifactDetailAccess =
  | { kind: "ok"; artifact: ArtifactSummary }
  | { kind: "not-found" }
  | { kind: "denied" };

/**
 * Resolve one artifact for the detail route, splitting not-found from
 * read-denied. Mirrors {@link getArtifact}'s two gates but reports which gate
 * refused: the actor-scoped ownership filter (`getObjectById(actor)` → null ⇒
 * not-found / 404-hidden) versus the canonical `object.read` kernel decision
 * (⇒ denied). Live rows only — a tombstone reads as not-found.
 */
export function readArtifactForDetail(input: {
  artifactId: string;
  orgId: string | null;
  actor?: ActorContext;
}): ArtifactDetailAccess {
  return readArtifactAccess(input, { allowDeleted: false });
}

/**
 * Resolve one artifact for the SETTLED, read-only review reading — the
 * ARTIFACT-LEVEL half of enabler 0.9 of `PLAN: Agents Lifecycle (C)`
 * (cinatra#3027 / epic #3023).
 *
 * IDENTICAL to {@link readArtifactForDetail} in every authorization respect: the
 * same actor-scoped ownership filter and the same canonical `object.read`
 * decision, so a caller who cannot read the row live cannot read it here either.
 * ONE difference, and it is the enabler's whole sentence: a TOMBSTONED row still
 * resolves — "a run- or gate-authorized historical reader reads exactly that
 * pinned representation EVEN AFTER THE ARTIFACT IS TOMBSTONED; the ordinary
 * artifact page stays live and latest."
 *
 * WHY IT HAS TO EXIST. The historical REVISION reader alone could not deliver
 * the enabler: the live artifact read runs first and answers `not-found` for a
 * tombstone, so the settled card floored at `unknown-or-tombstoned` before the
 * revision reader was ever consulted. Both halves of the read go historical
 * together or neither does.
 *
 * ONE CALLER: the review binder's settled reading, over a target the gate itself
 * pinned. `allowDeleted` is the same option the byte routes' pin override
 * already uses, under the same visibility check.
 */
export function readArtifactForSettledReview(input: {
  artifactId: string;
  orgId: string | null;
  actor?: ActorContext;
}): ArtifactDetailAccess {
  return readArtifactAccess(input, { allowDeleted: true });
}

/** The shared body of the two readings above — one implementation, one place a
 *  rung could be dropped. `allowDeleted` is the ONLY thing that varies. */
function readArtifactAccess(
  input: { artifactId: string; orgId: string | null; actor?: ActorContext },
  options: { allowDeleted: boolean },
): ArtifactDetailAccess {
  const rec = getObjectById(input.artifactId, { orgId: input.orgId }, input.actor, {
    allowDeleted: options.allowDeleted,
  });
  if (!rec) return { kind: "not-found" };
  ensureArtifactRegistry();
  if (!artifactObjectTypeIds().has(rec.type)) return { kind: "not-found" };
  // Ownership filter passed (the actor CAN list this row); a canonical
  // `object.read` refusal here is the spec's "may list but not read" case.
  if (!actorPassesObjectAuthz(rec, input.actor, "object.read")) {
    return { kind: "denied" };
  }
  const enrichment =
    input.orgId !== null
      ? resolveArtifactEffectiveIdentity({
          orgId: input.orgId,
          artifactId: rec.id,
          baseType: rec.type,
        })
      : undefined;
  const presentation =
    input.orgId !== null
      ? resolveArtifactPresentationIdentity({
          orgId: input.orgId,
          artifactId: rec.id,
          baseType: rec.type,
        })
      : undefined;
  return { kind: "ok", artifact: toSummary(rec, enrichment, presentation) };
}

/**
 * Resolve one artifact for a MEANING-WRITE mutation (the §VI.1 user meaning
 * assertion), enforcing WRITE authority — not merely read. Mirrors
 * {@link readArtifactForDetail} but layers the canonical `object.update` gate
 * on top of `object.read` (cinatra#1428 RBAC matrix): asserting a user meaning
 * MUTATES the artifact's identity, so it is a WRITE and must pass the SAME
 * decision `objects_save` enforces — never a mere read.
 *
 * The two nulls are distinguished exactly as the detail route requires:
 *   - `not-found` — absent / not-an-artifact / ownership-filtered (404-hidden).
 *   - `denied`    — the row lists + reads, but the actor lacks WRITE authority.
 *
 * With uploads uploader-owned (cinatra#1930), the user-owner short-circuit
 * grants the UPLOADER `object.update` on their own row, and org_admins pass via
 * the admin-tier grant; a mere READER of a shared (org-visible) artifact — who
 * can `object.read` but is neither owner nor admin — is DENIED, so a reader can
 * never write a user meaning assertion on someone else's artifact.
 */
export function readArtifactForMeaningWrite(input: {
  artifactId: string;
  orgId: string | null;
  actor?: ActorContext;
}): ArtifactDetailAccess {
  const rec = getObjectById(input.artifactId, { orgId: input.orgId }, input.actor);
  if (!rec) return { kind: "not-found" };
  ensureArtifactRegistry();
  if (!artifactObjectTypeIds().has(rec.type)) return { kind: "not-found" };
  // Read gate first (existence-hiding parity with the detail route), THEN the
  // canonical WRITE gate. Both must pass; `object.update` is the load-bearing
  // authority check the read-only surface never enforced.
  if (!actorPassesObjectAuthz(rec, input.actor, "object.read")) {
    return { kind: "denied" };
  }
  if (!actorPassesObjectAuthz(rec, input.actor, "object.update")) {
    return { kind: "denied" };
  }
  const enrichment =
    input.orgId !== null
      ? resolveArtifactEffectiveIdentity({
          orgId: input.orgId,
          artifactId: rec.id,
          baseType: rec.type,
        })
      : undefined;
  const presentation =
    input.orgId !== null
      ? resolveArtifactPresentationIdentity({
          orgId: input.orgId,
          artifactId: rec.id,
          baseType: rec.type,
        })
      : undefined;
  return { kind: "ok", artifact: toSummary(rec, enrichment, presentation) };
}

/**
 * Canonical delete = tombstone (never hard-delete a referenced artifact).
 * Authorization (cinatra#1428 RBAC matrix), both layers required:
 *   1. actor-scoped visibility — the same SQL ownership filter every read
 *      uses (an org-scoped caller must not tombstone an artifact the
 *      ownership/visibility filter would deny it; denied reads 404-hide);
 *   2. canonical `object.delete` — the same kernel decision the objects
 *      surface enforces for `objects_delete` (owner short-circuit for
 *      user-owned rows; role grant otherwise).
 * `auditActor` is the audit-trail string; `actor` is the authz context.
 *
 * The delete rides the canonical object soft-delete path (change event +
 * outbox delete projection + undoable change_set); `changeSetId` is surfaced
 * for Undo parity with `objects_delete`.
 */
export function tombstoneArtifact(input: {
  orgId: string;
  artifactId: string;
  actor?: ActorContext;
  auditActor?: string | null;
}): { referenced: boolean; pinCount: number; changeSetId: string | null } {
  if (input.actor) {
    const rec = getObjectById(
      input.artifactId,
      { orgId: input.orgId },
      input.actor,
    );
    ensureArtifactRegistry();
    if (!rec || !artifactObjectTypeIds().has(rec.type)) {
      throw new Error(
        `artifact ${input.artifactId} not found or not permitted`,
      );
    }
    if (!actorPassesObjectAuthz(rec, input.actor, "object.delete")) {
      throw new Error(
        `artifact ${input.artifactId}: object.delete denied for actor`,
      );
    }
  }
  return retentionTombstone({
    orgId: input.orgId,
    artifactId: input.artifactId,
    actor: input.auditActor ?? null,
    actorKind: input.auditActor ? "user" : "system",
  });
}

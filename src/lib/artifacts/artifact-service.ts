import "server-only";
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
  createSemanticArtifact,
  ObjectsTypeNotRegisteredError,
  type CreateSemanticArtifactInput,
  type CreateSemanticArtifactResult,
} from "./artifact-creation";
import { resolveUploadArtifactType } from "./upload-artifact-type-map";
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

// The artifact object-types registry is populated only by
// registerAllObjectTypes() through the artifact extension registration
// bridge. The UI/MCP read paths don't transitively trigger it, so list/get
// would see an empty registry in a fresh process. Idempotent (registry is
// replace-by-id); guarded so it runs at most once per process.
//
// list/get filter on the generic SEMANTIC_ARTIFACT_OBJECT_TYPE directly.
// The registry is still warmed because other paths (cross-kind dep graph,
// manifest validation) consume it; the artifact service no longer reads
// `objectTypeRegistry.listArtifacts()`.
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

// Every artifact row carries the same SEMANTIC_ARTIFACT_OBJECT_TYPE.
function artifactObjectTypeIds(): Set<string> {
  return new Set([SEMANTIC_ARTIFACT_OBJECT_TYPE]);
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
  op: "object.read" | "object.delete",
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
  },
  semanticIdentity?: ArtifactIdentityEnrichment,
): ArtifactSummary {
  const d = (rec.data ?? {}) as Partial<ArtifactObjectData>;
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
    // Default to no-primary if the caller didn't enrich (e.g., from a
    // unit test that doesn't drive the resolver).
    eligibleExtensions: semanticIdentity?.eligibleExtensions ?? [],
    primaryExtension: semanticIdentity
      ? primaryExtensionOf(semanticIdentity.identity)
      : null,
    effectiveIdentity: semanticIdentity?.identity ?? NO_PRIMARY_IDENTITY_FALLBACK,
    sourceUrl: connectorRefSourceUrl(rec.data),
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
    throw new ObjectsTypeNotRegisteredError(
      null,
      `upload cannot be typed to a system-base artifact pack: ${resolution.reason}`,
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
  ensureArtifactRegistry();
  const typeIds = artifactObjectTypeIds();
  if (typeIds.size === 0) return [];
  // Resolve the extension id-set first so the per-type fetch can pre-filter
  // BEFORE applying the limit (correct pagination semantics).
  const extFilter =
    input.extensionPackageName && input.orgId !== null
      ? listArtifactIdsForExtension(input.orgId, input.extensionPackageName)
      : null;
  let rawRecs: ObjectRecord[] = [];
  for (const typeId of typeIds) {
    const recs = listObjectsByFilter(
      {
        orgId: input.orgId,
        type: typeId,
        // When an extension filter is active, fetch without the per-type limit so
        // the filter applies BEFORE the final slice; otherwise keep the limit.
        limit: extFilter ? undefined : input.limit,
        projectId: input.projectId ?? null,
      },
      input.actor,
    );
    rawRecs.push(...recs);
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
  const out: ArtifactSummary[] = rawRecs.map((r) =>
    toSummary(r, identityByArtifact.get(r.id)),
  );
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return typeof input.limit === "number" ? out.slice(0, input.limit) : out;
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
  return toSummary(rec, enrichment);
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
  const rec = getObjectById(input.artifactId, { orgId: input.orgId }, input.actor);
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
  return { kind: "ok", artifact: toSummary(rec, enrichment) };
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

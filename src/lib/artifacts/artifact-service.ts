import "server-only";
import type { ActorContext } from "@/lib/authz/actor-context";
import { listObjectsByFilter, getObjectById } from "@/lib/objects-store";
import type { ArtifactObjectData } from "@cinatra-ai/artifacts";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";
import {
  createSemanticArtifact,
  type CreateSemanticArtifactInput,
  type CreateSemanticArtifactResult,
} from "./artifact-creation";
import { tombstoneArtifact as retentionTombstone } from "./artifact-retention";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
// Generated pure-data floor constant (cinatra#151 Stage 6) — core source
// never names the floor extension package.
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";
import {
  listEligibleAssertions,
  listEligibleAssertionsForArtifacts,
  listArtifactIdsForExtension,
  primaryExtensionFor,
} from "./semantic-assertion-store";

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
  // Semantic identity is derived from `semantic_assertion` (read assertions,
  // not objects.type). Every artifact has at least the default-artifact floor
  // assertion; classifier-asserted (matcher/agent/authoring_skill/user)
  // extensions may join. `primaryExtension` is the highest-precedence
  // non-default eligible extension, falling back to default if none.
  // `eligibleExtensions` is every active eligible extension (not drafts).
  eligibleExtensions: string[];
  primaryExtension: string;
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

function toSummary(
  rec: {
    id: string;
    type: string;
    data: unknown;
    createdAt?: string;
    updatedAt?: string;
  },
  semanticIdentity?: {
    eligibleExtensions: string[];
    primaryExtension: string;
  },
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
    // Default to the floor if the caller didn't enrich (e.g., from a
    // unit test that doesn't drive the assertion store).
    eligibleExtensions: semanticIdentity?.eligibleExtensions ?? [],
    primaryExtension:
      semanticIdentity?.primaryExtension ?? DEFAULT_ARTIFACT_EXTENSION,
    sourceUrl: connectorRefSourceUrl(rec.data),
  };
}

/** Canonical creation entry: the single semantic write path. The upload
 *  route's required ownership is `organization`/orgId; other callers
 *  (MCP / agent-emit) supply their own ownership. */
export async function createUploadedArtifact(
  input: CreateSemanticArtifactInput,
): Promise<CreateSemanticArtifactResult> {
  return createSemanticArtifact(input);
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
  let rawRecs: {
    id: string;
    type: string;
    data: unknown;
    createdAt?: string;
    updatedAt?: string;
  }[] = [];
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
  if (extFilter) rawRecs = rawRecs.filter((r) => extFilter.has(r.id));
  // Batched assertion lookup (avoids N+1 across the page).
  const assertionsByArtifact =
    input.orgId !== null
      ? listEligibleAssertionsForArtifacts(
          input.orgId,
          rawRecs.map((r) => r.id),
        )
      : new Map<string, ReturnType<typeof listEligibleAssertions>>();
  const out: ArtifactSummary[] = rawRecs.map((r) => {
    const eligible = assertionsByArtifact.get(r.id) ?? [];
    return toSummary(r, {
      eligibleExtensions: eligible.map((a) => a.extension),
      primaryExtension: primaryExtensionFor(eligible),
    });
  });
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
  // Enrich with semantic identity from the assertion store (read assertions,
  // not objects.type).
  const eligible =
    input.orgId !== null
      ? listEligibleAssertions(input.orgId, rec.id)
      : [];
  return toSummary(rec, {
    eligibleExtensions: eligible.map((a) => a.extension),
    primaryExtension: primaryExtensionFor(eligible),
  });
}

/**
 * Canonical delete = tombstone (never hard-delete a referenced artifact).
 * Authorize through the same actor-scoped read as everything else before
 * mutating: an org-scoped caller must not tombstone an artifact the
 * ownership/visibility filter would deny it. `auditActor` is the audit-trail
 * string; `actor` is the authz context.
 */
export function tombstoneArtifact(input: {
  orgId: string;
  artifactId: string;
  actor?: ActorContext;
  auditActor?: string | null;
}): { referenced: boolean; pinCount: number } {
  if (input.actor) {
    const visible = getArtifact({
      artifactId: input.artifactId,
      orgId: input.orgId,
      actor: input.actor,
    });
    if (!visible) {
      throw new Error(
        `artifact ${input.artifactId} not found or not permitted`,
      );
    }
  }
  return retentionTombstone({
    orgId: input.orgId,
    artifactId: input.artifactId,
    actor: input.auditActor ?? null,
  });
}

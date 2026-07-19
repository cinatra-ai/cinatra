import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";
import { addEpisode, deleteEpisode, identityHashToUuid } from "./graphiti-client";
import { DEFAULT_ARTIFACT_EXTENSION } from "./generated/artifact-floor";
import { objectSyncAdapterRegistry } from "./sync-adapters/registry";
import type { ObjectSyncAdapter, StoredObject } from "./sync-adapters/adapter";
import { claimedTypeRegisteringPackage } from "./claims";
import {
  objectTypeRegistry,
  isDispositionGovernedType,
  resolveTypeProjectionDisposition,
} from "./registry";
import { GENERIC_ARTIFACT_OBJECT_TYPE } from "./effective-identity";
import {
  deriveProjectionGroupId,
  deriveScopeLane,
  readProjectionEpochs,
} from "./graphiti-projection-policy";
// Claimed-row projection (#1427 AC-3) now resolves the disposition through the
// type-driven registry seam (epic #1785) — the single disposition authority the
// projector / rebuild / recall / effective-type-catalog share — and the row's
// identity through the ONE effective-identity service (epic #1424: one
// resolution point for every surface; that enrichment call is unchanged, A2
// owns its rework).
import { resolveArtifactEffectiveIdentity } from "@/lib/objects/effective-identity";

// ---------------------------------------------------------------------------
// Reads cinatra.graphiti_projection_outbox, calls Graphiti, updates objects
// row with version-guard SQL. NEVER called synchronously from MCP handlers —
// invoked exclusively via the GRAPHITI_PROJECTION_REPAIR BullMQ job
// (background-jobs-registry.ts → processGraphitiProjectionCycle in
// ./graphiti-rebuild, which drains the outbox through processProjectionOutbox
// below). REBUILD NOTE: the equal-version dedup guard below suppresses
// same-version re-projection BY DESIGN; whole-group rebuilds therefore ride
// the epoch-fenced rebuild journal (#1427, ./graphiti-rebuild), whose
// clearing phase resets the `graphiti_projected_version` bookkeeping before
// the replay re-drives rows through this path.
//
// Exposed via tsconfig sub-path alias `@cinatra-ai/objects/graphiti-projector`
// (NOT re-exported from packages/objects/src/index.ts) to avoid the
// barrel-import trap that drags @cinatra-ai/mcp-server (host-only) into worker
// dispatch contexts.
// ---------------------------------------------------------------------------

type OutboxRow = {
  id: string;
  object_id: string;
  object_version: number;
  org_id: string | null;
  operation: "upsert" | "delete";
  payload_hash: string | null;
  attempts: number;
  // Rebuild-replay items are stamped with their target projection-policy
  // epoch (#1427 AC-4); NULL = ordinary write-path item (always processed
  // under the group's live policy). The worker discards a stamped item whose
  // epoch is older than the group's current epoch (stale-epoch fencing).
  projection_epoch: number | null;
};

type CanonicalRow = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  org_id: string | null;
  version: number;
  run_id: string | null;
  agent_id: string | null;
  graphiti_episode_uuid: string | null;
  // Last version already projected to Graphiti (null = never projected).
  // Feeds the equal-version dedup guard so a re-enqueued outbox item for an
  // already-projected version never appends a duplicate episode.
  graphiti_projected_version: number | null;
  // `source` gates projection to cinatra-originated writes (agent | ui |
  // route); `created_at` feeds the adapter's reference_time when routing.
  source: string | null;
  created_at: string;
  // Canonical scope columns (core__0033 ownership vocabulary). Read for the
  // memory-concept nested-lane derivation (#1379); NULL/absent for the many
  // fixtures that predate it — non-memory rows never consult them.
  owner_level: string | null;
  owner_id: string | null;
  visibility: string | null;
  project_id: string | null;
  // The lane a memory-concept row was LAST projected into (#1379 lane-move
  // bookkeeping). NULL = never projected under the lane model (or a non-memory
  // row). The OLD lane is read from HERE — not re-derived from the current
  // scope — so a scope change can locate and delete the prior-lane episode
  // (identityHashToUuid is lane-scoped, so a lane change also moves the UUID).
  projected_group_id: string | null;
};

// ---------------------------------------------------------------------------
// Memory-concept capped projection body (cinatra#1379 AC3).
//
// The `@cinatra-ai/memory:concept` type id, inlined as a literal on purpose:
// importing it from `../integration/register-types` would drag that module's
// zod schema + React renderers into this worker-dispatch graph. The source of
// truth is `MEMORY_CONCEPT_TYPE_ID` there; the memory projector test asserts
// this literal equals that constant.
// ---------------------------------------------------------------------------
const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";

/** Hard cap on the memory-concept episode body excerpt, in UTF-8 BYTES (the
 * same unit the envelope's 64 KiB bodyMarkdown cap uses). */
export const MEMORY_CONCEPT_PROJECTION_EXCERPT_MAX_BYTES = 4 * 1024;

/** Truncate `s` to at most `maxBytes` UTF-8 bytes on a code-point boundary
 * (never splits a multi-byte char — `for..of` iterates by code point). */
function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

/**
 * Capped projection body for a `@cinatra-ai/memory:concept` row (#1379 AC3).
 * Whitelist ONLY: { conceptId, okfType, title (from frontmatter.title), excerpt
 * (bodyMarkdown truncated to 4 KiB) }. NEVER the full envelope — no full
 * bodyMarkdown (64 KiB cap), no raw `frontmatter` passthrough, no `links[]`,
 * no externalId/bundleId. Pure — mirrors `projectArtifactSafe`.
 */
export function projectMemoryConceptCapped(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const conceptId = typeof data.conceptId === "string" ? data.conceptId : undefined;
  const okfType = typeof data.okfType === "string" ? data.okfType : undefined;
  const frontmatter =
    data.frontmatter && typeof data.frontmatter === "object" && !Array.isArray(data.frontmatter)
      ? (data.frontmatter as Record<string, unknown>)
      : undefined;
  const title =
    frontmatter && typeof frontmatter.title === "string" ? frontmatter.title : undefined;
  const bodyMarkdown = typeof data.bodyMarkdown === "string" ? data.bodyMarkdown : "";
  return {
    conceptId,
    okfType,
    title,
    excerpt: truncateToUtf8Bytes(bodyMarkdown, MEMORY_CONCEPT_PROJECTION_EXCERPT_MAX_BYTES),
  };
}

function deriveEntityName(data: Record<string, unknown>, type: string): string {
  const candidate =
    (data.name as string | undefined) ??
    (data.title as string | undefined) ??
    (data.email as string | undefined) ??
    type;
  return String(candidate).slice(0, 200);
}

// Metadata/excerpt-only projection for artifact object rows.
// Returns null for non-artifact data (caller keeps the raw-data projection).
// An artifact row is identified by the
// ArtifactObjectData shape (artifactType + latestRepresentationRevisionId).
// Whitelisted fields only; excerpt hard-capped; NEVER body bytes/base64/
// storage keys.
//
// The Graphiti projection carries the semantic identity (the eligible
// extensions + the primary) read from `semantic_assertion`. Callers pass
// the identity via the optional `semanticIdentity` arg; the projector itself
// stays pure (no DB access) so the function remains unit-testable with a
// single fixture call.
const ARTIFACT_EXCERPT_CAP = 2000;
export type ArtifactSemanticIdentity = {
  eligibleExtensions: string[];
  /** The row's primary extension, or NULL when it has no defining extension
   * (epic #1785 — the retired generic catch-all, or no eligible non-floor
   * assertion). */
  primaryExtension: string | null;
};
export function projectArtifactSafe(
  data: Record<string, unknown>,
  semanticIdentity?: ArtifactSemanticIdentity,
): Record<string, unknown> | null {
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.artifactType !== "string" ||
    typeof data.latestRepresentationRevisionId !== "string"
  ) {
    return null;
  }
  const pick = (k: string): unknown =>
    typeof data[k] === "string" || typeof data[k] === "number"
      ? data[k]
      : undefined;
  const excerptRaw = data.excerpt;
  return {
    artifactType: data.artifactType,
    latestRepresentationRevisionId: data.latestRepresentationRevisionId,
    latestDigest: pick("latestDigest"),
    mime: pick("mime"),
    size: pick("size"),
    originKind: pick("originKind"),
    viewerHint: pick("viewerHint"),
    title: pick("title"),
    // Semantic identity in the Graphiti projection. An empty array / null
    // primary are valid sentinels for "no enrichment / no defining extension"
    // (epic #1785) — Graphiti consumers can still navigate by the immutable
    // artifactId.
    primaryExtension: semanticIdentity?.primaryExtension ?? null,
    eligibleExtensions: semanticIdentity?.eligibleExtensions ?? [],
    excerpt:
      typeof excerptRaw === "string"
        ? excerptRaw.slice(0, ARTIFACT_EXCERPT_CAP)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Claimed-row faceted projection (#1427 AC-3). Rows whose `objects.type`
// carries a WINNING artifact-type claim leave the raw-data projection path:
// the episode body is the artifact-safe faceted shape — base type + claiming
// extension + effective identity + a capped excerpt — whitelisted fields
// ONLY, never a spread of `row.data` (bytes / base64 / storage keys can never
// reach Graphiti, whatever a claimed type's writer stores). Pure function —
// the winner/identity reads happen in resolveClaimedRowProjection below.
// ---------------------------------------------------------------------------

/** Excerpt derivation priority for claimed typed rows: the first non-empty
 * STRING field wins; capped at ARTIFACT_EXCERPT_CAP. Whitelist-only — an
 * unlisted field never leaks into the projection. */
export const CLAIMED_ROW_EXCERPT_FIELDS = [
  "excerpt",
  "summary",
  "description",
  "subject",
  "body",
  "text",
  "content",
  "title",
  "name",
] as const;

export function deriveClaimedRowExcerpt(data: Record<string, unknown>): string | undefined {
  for (const field of CLAIMED_ROW_EXCERPT_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value.length > 0) {
      return value.slice(0, ARTIFACT_EXCERPT_CAP);
    }
  }
  return undefined;
}

export type ClaimedRowFacetInput = {
  baseType: string;
  claimingExtension: string;
  claimKind: "dedicated" | "default";
  claimGeneration: number;
  /** The effective-identity service's resolution — the type's defining
   * extension, or null when the identity is no-primary (epic #1785). */
  effectiveExtension: string | null;
  eligibleExtensions: string[];
};

export function projectClaimedRowFaceted(
  data: Record<string, unknown>,
  facet: ClaimedRowFacetInput,
): Record<string, unknown> {
  const scalar = (k: string): unknown =>
    typeof data[k] === "string" || typeof data[k] === "number" ? data[k] : undefined;
  return {
    baseType: facet.baseType,
    claimedBy: facet.claimingExtension,
    claimKind: facet.claimKind,
    claimGeneration: facet.claimGeneration,
    // The effective identity when resolution lands an extension identity; the
    // claiming (defining) extension otherwise. For a disposition-governed typed
    // row these are the same package (the type's namespace-definer).
    primaryExtension: facet.effectiveExtension ?? facet.claimingExtension,
    eligibleExtensions: facet.eligibleExtensions,
    title: scalar("title") ?? scalar("name"),
    excerpt: deriveClaimedRowExcerpt(data),
  };
}

type ClaimedRowProjection =
  | { kind: "skip" }
  | { kind: "raw" }
  | { kind: "faceted"; body: Record<string, unknown> };

/**
 * Resolve how a non-generic typed row projects, type-driven (epic #1785):
 *   - not disposition-governed → null (an ungoverned data object, or an
 *     uninstalled definer — the caller keeps the existing raw/generic path)
 *   - disposition 'none'      → terminal skip (never projected, outbox done)
 *   - disposition 'raw'       → the raw-data path (an explicit type opt-in)
 *   - 'artifact-safe' / undeclared / invalid → the faceted shape (fail-CLOSED:
 *     an invalid declared projection gates DOWN to the metadata-only shape,
 *     never up to raw — the shared resolver enforces this).
 * The disposition comes from the SAME shared registry resolver the rebuild and
 * recall surfaces read, so the write path can never disagree with the counted /
 * replayed / recalled set. Under the single-definer model there is no claim
 * winner: the faceted body's claiming extension is the registering (defining)
 * package from the registry, `claimKind` is always 'dedicated', and the
 * generation sentinel is 1. Identity still comes from the effective-identity
 * service — the ONE resolution point (#1426), unchanged here (A2 owns its
 * rework); read errors propagate (the outbox row retries).
 */
function resolveClaimedRowProjection(row: CanonicalRow): ClaimedRowProjection | null {
  const orgId = row.org_id;
  if (orgId == null) return null; // no-tenant rows keep the raw path
  // A plain data object (no declared disposition) or an uninstalled definer is
  // NOT disposition-governed — keep the existing raw/generic projection path.
  if (!isDispositionGovernedType(row.type)) return null;
  const projection = resolveTypeProjectionDisposition(row.type);
  if (projection === "none") return { kind: "skip" };
  if (projection === "raw") return { kind: "raw" };
  // The claiming extension is the type's REGISTERING (single-definer) package —
  // the actual provenance when a pack registered the type, else the id's
  // namespace-defining package (a host-registered type).
  const claimingExtension =
    objectTypeRegistry.getRegisteringPackage(row.type) ??
    claimedTypeRegisteringPackage(row.type) ??
    row.type;
  const enrichment = resolveArtifactEffectiveIdentity({
    orgId,
    artifactId: row.id,
    baseType: row.type,
  });
  const identity = enrichment.identity;
  return {
    kind: "faceted",
    body: projectClaimedRowFaceted(row.data, {
      baseType: row.type,
      claimingExtension,
      claimKind: "dedicated",
      claimGeneration: 1,
      effectiveExtension: identity.kind === "extension" ? identity.extension : null,
      eligibleExtensions: enrichment.eligibleExtensions,
    }),
  };
}

function readCanonicalRow(objectId: string, orgId: string | null): CanonicalRow | null {
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, data, org_id, version, run_id, agent_id, graphiti_episode_uuid, graphiti_projected_version, source, created_at, owner_level, owner_id, visibility, project_id, projected_group_id
             FROM "${schema}"."objects"
             WHERE id = $1 AND (org_id = $2 OR $2 IS NULL) AND deleted_at IS NULL
             LIMIT 1`,
        values: [objectId, orgId],
      },
    ],
  });
  return (result?.rows[0] as CanonicalRow | undefined) ?? null;
}

function markProjected(input: {
  objectId: string;
  episodeUuid: string;
  projectedVersion: number;
  // The lane this projection landed in — persisted so a later scope change can
  // read the OLD lane and delete its episode (#1379 lane-move). Passed for
  // every path (memory rows carry the nested lane; non-memory/adapter rows
  // carry the ambient org lane) so the column is always populated post-project.
  projectedGroupId: string;
}): void {
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."objects"
             SET graphiti_sync_status = 'synced',
                 graphiti_episode_uuid = $1,
                 graphiti_projected_version = $2,
                 graphiti_projected_at = now(),
                 graphiti_projection_error = NULL,
                 projected_group_id = $4
             WHERE id = $3
               AND (graphiti_projected_version IS NULL OR graphiti_projected_version < $2)`,
        values: [input.episodeUuid, input.projectedVersion, input.objectId, input.projectedGroupId],
      },
    ],
  });
  // 0 rows affected ⇒ a newer version already won; benign.
}

/**
 * Retract a lane-eligible row's lane bookkeeping after its prior-lane episode
 * has been deleted because the row transitioned to a NON-projected scope
 * (visibility='public' or an unclassifiable scope — #1379 memory, #1436
 * artifact). Clears projected_group_id + graphiti_episode_uuid so a re-enqueue
 * does not re-delete an already-gone episode (prior lane reads back as "none"),
 * and records that the row is no longer projected. graphiti_projected_version is
 * intentionally left untouched (a later scope change back to a real lane bumps
 * the version and re-projects fresh). */
function markLaneRetracted(objectId: string): void {
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."objects"
             SET graphiti_sync_status = 'skipped',
                 graphiti_episode_uuid = NULL,
                 projected_group_id = NULL,
                 graphiti_projected_at = now(),
                 graphiti_projection_error = NULL
             WHERE id = $1`,
        values: [objectId],
      },
    ],
  });
}

/**
 * Retract a row that transitions to a NON-projected state — a lane-derivation
 * terminal skip (public / unclassifiable scope) OR a winning claim disposition
 * of 'none'. Best-effort purge the PRIOR-lane episode (located via the PERSISTED
 * projected_group_id, never re-derived) and clear the lane bookkeeping so a
 * re-enqueue does not re-attempt the purge. A row that was never projected
 * (priorLane null) just logs the skip. Best-effort + swallowed: the purge is
 * relevance HYGIENE, not the authz gate (recall re-checks Postgres ownership +
 * object.read on the CURRENT scope), so a delete failure never blocks the skip.
 * Shared by the claim-'none' skip and the lane-skip so an artifact-safe -> none
 * disposition flip never leaves a nested-lane episode orphaned (#1436).
 */
async function retractPriorLaneEpisode(row: CanonicalRow, reason: string): Promise<void> {
  const priorLane = row.projected_group_id;
  if (!priorLane) {
    console.log(`[graphiti-projector] skipping row ${row.id} (${row.type}): ${reason}`);
    return;
  }
  try {
    await deleteEpisode({ uuid: identityHashToUuid(row.id, priorLane) });
  } catch (err) {
    console.warn(
      `[graphiti-projector] lane retract: deleteEpisode failed for prior lane ${priorLane} of ${row.id}:`,
      err,
    );
  }
  markLaneRetracted(row.id);
  console.log(
    `[graphiti-projector] row ${row.id} (${row.type}): retracted prior-lane episode (${priorLane}) — ${reason}`,
  );
}

function markDeleted(objectId: string): void {
  const schema = postgresSchema.replaceAll('"', '""');
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."objects"
             SET graphiti_sync_status = 'deleted',
                 graphiti_projected_at = now(),
                 graphiti_projection_error = NULL
             WHERE id = $1`,
        values: [objectId],
      },
    ],
  });
}

/**
 * Project an object to Graphiti as a NEW append-only episode.
 * Calls addEpisode only; never deleteEpisode + addEpisode.
 *
 * Returns `{ episodeUuid: string }` on success, or `{ episodeUuid: null,
 * skipped: true }` when the canonical row's version has already advanced
 * past this outbox entry (stale-outbox guard).
 */
export async function projectObjectToGraphiti(input: {
  objectId: string;
  objectVersion: number;
  orgId: string | null;
}): Promise<{ episodeUuid: string | null; skipped?: boolean }> {
  // episodeUuid is "" when Graphiti returns no uuid in any known shape.
  // Callers should treat empty string as a soft-failure signal (still marks
  // the row projected to avoid retry loops, but downstream lookups by uuid
  // will return nothing — the reconcile CLI handles such orphans).
  const row = readCanonicalRow(input.objectId, input.orgId);
  if (!row) {
    throw new Error(`projectObjectToGraphiti: canonical row not found id=${input.objectId}`);
  }
  // Stale-outbox guard (BEFORE addEpisode).
  // If the canonical row has already advanced past this outbox entry's
  // object_version, a newer entry will land later and overwrite the episode
  // pointer. Calling addEpisode here would append a stale ghost episode that
  // the version-guard markProjected UPDATE could not later retract. Guard the
  // network call BEFORE making it.
  if (row.version > input.objectVersion) {
    console.log(
      `[graphiti-projector] skipping stale outbox entry for ${input.objectId} ` +
        `(row.version=${row.version} > input.objectVersion=${input.objectVersion})`,
    );
    return { episodeUuid: null, skipped: true };
  }

  // Equal-version dedup guard (BEFORE addEpisode, BEFORE adapter routing).
  // The stale guard above only rejects entries whose CANONICAL version has
  // advanced, and markProjected only moves graphiti_projected_version on
  // strictly newer projections — so a re-enqueued outbox item for a version
  // that is already projected (equal or older than graphiti_projected_version)
  // would otherwise call addEpisode again and append a duplicate episode.
  // Skip terminally instead: the outbox row settles as done (not failed),
  // no retry, zero new episodes. `!= null` (loose) covers both SQL NULL and
  // an absent field.
  if (
    row.graphiti_projected_version != null &&
    input.objectVersion <= row.graphiti_projected_version
  ) {
    console.log(
      `[graphiti-projector] skipping already-projected outbox entry for ${input.objectId} ` +
        `(objectVersion=${input.objectVersion} <= graphiti_projected_version=${row.graphiti_projected_version})`,
    );
    return { episodeUuid: null, skipped: true };
  }

  // Source gate. Graphiti indexes data ORIGINATED in cinatra: agent writes,
  // UI writes, and authenticated HTTP-route writes (canonical artifact
  // creation — uploads included — persists source='route'; see the objects
  // INSERT in src/lib/artifacts/artifact-creation.ts). Data PULLED from
  // external systems by background sync (worker | scheduler) is NOT
  // projected. Rows with source ∉ {agent, ui, route} are skipped terminally —
  // the outbox row is marked done (not failed), no retry. A `null` source
  // predates this gate and is treated as cinatra-originated to avoid
  // dropping legacy rows.
  if (
    row.source !== null &&
    row.source !== "agent" &&
    row.source !== "ui" &&
    row.source !== "route"
  ) {
    console.log(
      `[graphiti-projector] skipping non-cinatra-originated row ${row.id} (source=${row.source})`,
    );
    return { episodeUuid: null, skipped: true };
  }

  // Adapter routing. Adapter-owned types (CRM account/contact under
  // the Twenty migration) route here to TwentyToGraphitiAdapter.export(),
  // which hydrates the full record from Twenty via the crm_* facade before
  // composing the episode. Filter to targetSystem === "graphiti" so a
  // future non-Graphiti sync adapter on the same type cannot be invoked by
  // this Graphiti-specific projection path. The adapter calls addEpisode
  // itself + returns a deterministic externalId (the episode UUID) which we
  // use for markProjected bookkeeping.
  const adapters = objectSyncAdapterRegistry
    .getAdaptersForType(row.type)
    .filter((a: ObjectSyncAdapter) => a.targetSystem === "graphiti");
  if (adapters.length > 0) {
    const adapter = adapters[0]!;
    const storedObject: StoredObject = {
      id: row.id,
      type: row.type,
      data: row.data,
      parentId: null,
      orgId: row.org_id,
      createdAt: row.created_at,
      createdBy: null,
      agentId: row.agent_id,
      runId: row.run_id,
      source: (row.source as StoredObject["source"]) ?? null,
      classificationConfidence: null,
      exportedTo: {},
      deletedAt: null,
    };
    // Adapters are configless built-ins for now (the Twenty→Graphiti
    // adapter ships without a config row). Pass an empty config; future per-row
    // configs can plug in via `readActiveObjectSyncAdapterConfigs` here.
    const result = await adapter.export(storedObject, {} as never);
    if (!result.ok) {
      // Adapter export failed — let processProjectionOutbox surface this as
      // a failed outbox row (same retry semantics as the generic path).
      throw new Error(
        `adapter ${adapter.id} export failed for ${row.id}: ${result.error ?? "(no error message)"}`,
      );
    }
    // externalId is the deterministic episode UUID the adapter generated +
    // recorded with Graphiti. Use it for the projector's bookkeeping so
    // future delete attempts hit the right episode.
    const adapterEpisodeUuid = result.externalId ?? "";
    markProjected({
      objectId: row.id,
      episodeUuid: adapterEpisodeUuid,
      projectedVersion: input.objectVersion,
      // Adapter-owned types (CRM pointer rows) are never memory-scoped and
      // project to the ambient org lane.
      projectedGroupId: deriveProjectionGroupId(input.orgId ?? row.org_id),
    });
    return { episodeUuid: adapterEpisodeUuid };
  }

  // Claimed typed rows leave the raw path (#1427 AC-3). Resolved AFTER
  // adapter routing on purpose: adapter-owned types (CRM pointer rows) are
  // never claimed in this epic (#1424 guardrail) and keep adapter ownership
  // regardless. Generic artifact rows are never claimed either — they keep
  // the projectArtifactSafe path below.
  const claimedProjection =
    row.org_id !== null && row.type !== GENERIC_ARTIFACT_OBJECT_TYPE
      ? resolveClaimedRowProjection(row)
      : null;
  if (claimedProjection?.kind === "skip") {
    // The winning claim's dispositions say projection: 'none' — terminal skip:
    // the outbox row settles done, nothing is projected, no retry. If the row
    // was PREVIOUSLY projected (e.g. an artifact-safe -> none disposition flip
    // that left a nested-lane episode), best-effort purge that prior-lane
    // episode + clear the bookkeeping so it is not orphaned (#1436) — the
    // ambient-group rebuild would never reach a nested lane.
    await retractPriorLaneEpisode(
      row,
      "winning claim dispositions set projection='none'",
    );
    return { episodeUuid: null, skipped: true };
  }

  // Group-id (Graphiti lane) derivation. LANE-ELIGIBLE rows NEST under the org
  // lane via their server-derived scope: memory concepts (#1379 AC1) UNION
  // generic artifact rows UNION claimed rows whose winning disposition is
  // artifact-safe / faceted (#1436 AC1). A claimed 'raw' explicit opt-in,
  // adapter-owned CRM rows (routed to the adapter above and never reaching
  // here), and every other typed row keep the SINGLE ambient org lane (epic
  // #1424 guardrail — deriveProjectionGroupId stays single-lane-per-org for
  // those). All lane-eligible classes reuse the SAME hardened scope->lane
  // function (deriveScopeLane) — no independent artifact branch that could
  // reintroduce the #1379 phantom-team-lane bug (#1436 AC6).
  const isMemory = row.type === MEMORY_CONCEPT_TYPE_ID;
  const isLaneEligible =
    isMemory ||
    row.type === GENERIC_ARTIFACT_OBJECT_TYPE ||
    claimedProjection?.kind === "faceted";
  // The prior lane is the PERSISTED `projected_group_id` (NOT re-derived from
  // the current scope — that already reflects the NEW scope). The lane-scoped
  // deterministic UUID (identityHashToUuid(row.id, priorLane)) locates the
  // prior-lane episode for the best-effort purge below.
  //
  // SECURITY BOUNDARY NOTE. The Graphiti lane is a RECALL-RELEVANCE scoping
  // mechanism, NOT the authorization boundary. The authz boundary is the
  // recall handler's canonical re-fetch: objects_list resolves searchNodes
  // candidate ids, then `listObjectsByFilter(..., scopeActor)` re-reads the
  // Postgres rows through `buildOwnershipFilter` (owner_level/owner_id/
  // visibility) and `enforceResourceAccess(object.read)` re-checks each — on
  // the CURRENT scope. So a stale/orphaned episode in an old lane can at worst
  // surface a candidate id that the Postgres ownership filter then DROPS; it
  // can never disclose content under a scope the actor no longer has. The
  // episode purge here is therefore relevance HYGIENE, and it is best-effort:
  // Graphiti gives no episode-uuid control (see graphiti-rebuild.ts — the
  // authoritative purge is a group rebuild, not per-episode delete), exactly
  // like `deleteCurrentEpisodeFromGraphiti`. A delete failure must NOT block
  // re-projection (that would strand the row out of its new lane), so it is
  // swallowed + warned, mirroring the object-delete path.
  const priorLane = row.projected_group_id;
  let groupId: string;
  if (isLaneEligible) {
    const derivation = deriveScopeLane(input.orgId ?? row.org_id, {
      ownerLevel: row.owner_level,
      ownerId: row.owner_id,
      visibility: row.visibility,
      projectId: row.project_id,
    });
    if (derivation.kind === "skip") {
      // Terminal skip (public / unclassifiable scope). Best-effort purge any
      // prior-lane episode + clear the bookkeeping (shared with the claim-'none'
      // skip). Recall authz is enforced Postgres-side on the current scope
      // regardless.
      await retractPriorLaneEpisode(row, derivation.reason);
      return { episodeUuid: null, skipped: true };
    }
    groupId = derivation.groupId;
  } else {
    groupId = deriveProjectionGroupId(input.orgId ?? row.org_id);
  }
  // Lane-move (#1379 AC2, generalized to artifact rows #1436 AC2). When the prior
  // lane differs from the newly-derived lane — a scope change between nested
  // lanes, OR a claimed row leaving lane treatment entirely because its winning
  // disposition flipped artifact-safe -> raw (nested lane -> the ambient org
  // lane) — best-effort purge the prior-lane episode (its lane-scoped UUID
  // differs from the new one) before projecting into the new lane. Applies to
  // BOTH branches so a lane-eligibility EXIT never strands a nested episode.
  // Best-effort + swallowed for the same reason as the retract above — the purge
  // is relevance hygiene, not the authz gate. A first-ever projection (priorLane
  // null) and a same-lane re-projection (priorLane === groupId) purge nothing.
  if (priorLane && priorLane !== groupId) {
    try {
      await deleteEpisode({ uuid: identityHashToUuid(row.id, priorLane) });
      console.log(
        `[graphiti-projector] lane-move for ${row.id} (${row.type}): purged prior-lane episode ` +
          `(${priorLane} -> ${groupId})`,
      );
    } catch (err) {
      console.warn(
        `[graphiti-projector] lane-move: deleteEpisode failed for prior lane ${priorLane} of ${row.id}:`,
        err,
      );
    }
  }
  // EPISODE-UUID-EMPTY: knowledge-graph-mcp 1.0.x add_memory returns only a
  // message string — no uuid in any known response path. We compute a stable
  // deterministic UUID locally for Postgres bookkeeping and delete attempts.
  // NOTE: do NOT pass uuid to addEpisode. Graphiti 0.28.2 queue_service
  // interprets the uuid param as "re-process an existing node" — it issues
  // MATCH (uuid) which fails with "node not found" when the episode is new,
  // permanently blocking its processing. Episodes must be created without uuid.
  //
  // Embed [oid:<objectId>] in the episode name so it travels with
  // the episode record. NOTE: live verification (2026-04-30) showed this tag does
  // NOT propagate to entity node names via LLM extraction in Graphiti 0.28.2.
  // OID_RE in handlers.ts extractObjectIds is therefore inert for now; kept for
  // a future Graphiti version or text-body embedding approach. Deferred.
  const episodeUuid = identityHashToUuid(row.id, groupId);
  // Artifact projection policy. Artifact rows MUST NOT
  // spread raw `row.data` into graph memory: even though the artifact writer
  // keeps bytes/base64/storage keys OUT of objects.data by invariant
  // by invariant, defence-in-depth requires a metadata/excerpt-only
  // projection so a future writer bug, a large editable body, or stray
  // fields can never poison Graphiti. Non-artifact rows are unchanged.
  //
  // For semantic artifact rows, fetch the eligible semantic assertions
  // in lock-step with the projection so Graphiti sees the current
  // `primaryExtension` + the eligible extension set. Reads
  // `semantic_assertion` directly (this file already has PG access).
  // Skips for non-artifact rows (no extra query) and for rows with no
  // semantic_assertion entries, which naturally return empty arrays.
  // Skip the assertion lookup when org_id is null (project / no-tenant
  // path — semantic_assertion is org-scoped, would return nothing
  // anyway, so the resulting empty identity is identical).
  const semanticIdentity =
    row.type === "@cinatra-ai/artifact:object" && row.org_id !== null
      ? readSemanticIdentityForProjection(row.org_id, row.id)
      : undefined;
  // Precedence: claimed faceted body > claimed explicit-raw opt-in >
  // memory-concept capped body (#1379 AC3) > generic-artifact safe projection >
  // raw data (unclaimed non-artifact rows — unchanged pre-#1427 behavior).
  // Memory rows are never claimed (claims are artifact-type claims), so the
  // capped branch sits just after the claim branches: it replaces the raw-data
  // default those rows previously fell through to (which leaked the full 64 KiB
  // envelope — frontmatter, links, bundleId).
  const projectionData =
    claimedProjection?.kind === "faceted"
      ? claimedProjection.body
      : claimedProjection?.kind === "raw"
        ? row.data
        : isMemory
          ? projectMemoryConceptCapped(row.data)
          : (projectArtifactSafe(row.data, semanticIdentity) ?? row.data);
  const episodeBody = JSON.stringify({
    ...projectionData,
    cinatra_object_id: row.id,
    _cinatra: {
      objectId: row.id,
      version: row.version,
      type: row.type,
      runId: row.run_id,
      agentId: row.agent_id,
    },
  });

  await addEpisode({
    name: `${deriveEntityName(row.data, row.type)} [oid:${row.id}]`,
    episode_body: episodeBody,
    source: "json",
    source_description: `objects projection (run ${row.run_id ?? "n/a"})`,
    group_id: groupId,
    // uuid intentionally omitted — see EPISODE-UUID-EMPTY note above
  });

  markProjected({
    objectId: row.id,
    episodeUuid,
    projectedVersion: input.objectVersion,
    // Persist the lane just projected into so a later scope change can locate
    // and delete THIS episode (#1379 lane-move bookkeeping).
    projectedGroupId: groupId,
  });
  return { episodeUuid };
}

// Caller note:
// `processProjectionOutbox` must treat `{ skipped: true }` as a successful
// outcome and mark the corresponding outbox row `done` (not `failed`). The
// loop body in this file already wraps the call in try/catch — the success
// path falls through to the "Mark outbox row done" UPDATE, which is the
// correct behavior for skipped entries (do not retry; a newer outbox row
// will deliver the latest state). No special-casing needed in the worker
// loop, but executors MUST verify the resolved value is awaited (not the
// promise) so the skipped flag is observable.

/**
 * Delete the current episode pointer (does NOT hard-delete extracted entities).
 */
export async function deleteCurrentEpisodeFromGraphiti(input: {
  objectId: string;
  orgId: string | null;
}): Promise<void> {
  const row = readCanonicalRow(input.objectId, input.orgId);
  if (!row) return; // already gone
  if (row.graphiti_episode_uuid) {
    try {
      await deleteEpisode({ uuid: row.graphiti_episode_uuid });
    } catch (err) {
      console.warn(
        `[graphiti-projector] deleteEpisode failed for ${input.objectId}:`,
        err,
      );
      // Continue — we still mark deleted in PG; the cleanup CLI handles orphans.
    }
  }
  markDeleted(row.id);
}

/**
 * Repair worker: claim batch via FOR UPDATE SKIP LOCKED, project each row,
 * mark outbox rows done/failed.
 */
export async function processProjectionOutbox(options?: {
  batchSize?: number;
  maxAttempts?: number;
}): Promise<{ processed: number; failed: number }> {
  const batchSize = options?.batchSize ?? 20;
  const maxAttempts = options?.maxAttempts ?? 5;
  const schema = postgresSchema.replaceAll('"', '""');

  // Recover rows stuck in 'processing' for > 5 min (server crash/OOM
  // mid-batch leaves them unclaimable forever — the claim query below skips them).
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."graphiti_projection_outbox"
               SET status = 'failed',
                   last_error = 'recovered from stuck processing state'
               WHERE status = 'processing'
                 AND created_at < now() - interval '5 minutes'`,
        values: [],
      },
    ],
  });

  // 1. Claim batch
  const [claimResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."graphiti_projection_outbox"
             SET status = 'processing', attempts = attempts + 1
             WHERE id IN (
               SELECT id FROM "${schema}"."graphiti_projection_outbox"
               WHERE status IN ('pending', 'failed') AND attempts < $1
               ORDER BY created_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
             )
             RETURNING id, object_id, object_version, org_id, operation, payload_hash, attempts, projection_epoch`,
        values: [maxAttempts, batchSize],
      },
    ],
  });

  const rows = (claimResult?.rows ?? []) as OutboxRow[];
  let processed = 0;
  let failed = 0;

  // Stale-epoch fencing (#1427 AC-4): epoch-STAMPED items (rebuild-replay
  // enqueues) are discarded when the group's projection-policy epoch has
  // moved past them — a superseded replay must never append episodes into a
  // group a newer rebuild owns. Ordinary items (NULL stamp) always process
  // under the live policy. One epoch read per batch.
  const stampedGroups = Array.from(
    new Set(
      rows
        .filter((r) => r.projection_epoch != null)
        .map((r) => deriveProjectionGroupId(r.org_id)),
    ),
  );
  const epochByGroup =
    stampedGroups.length > 0 ? readProjectionEpochs(stampedGroups) : new Map<string, number>();

  for (const row of rows) {
    if (row.projection_epoch != null) {
      const currentEpoch = epochByGroup.get(deriveProjectionGroupId(row.org_id)) ?? 1;
      if (row.projection_epoch < currentEpoch) {
        runPostgresQueriesSync({
          connectionString: getPostgresConnectionString(),
          queries: [
            {
              text: `UPDATE "${schema}"."graphiti_projection_outbox"
                 SET status = 'done', processed_at = now(),
                     last_error = 'stale-epoch item discarded (epoch ' || $1 || ' < ' || $2 || ')'
                 WHERE id = $3`,
              values: [String(row.projection_epoch), String(currentEpoch), row.id],
            },
          ],
        });
        processed += 1;
        continue;
      }
    }
    try {
      if (row.operation === "upsert") {
        await projectObjectToGraphiti({
          objectId: row.object_id,
          objectVersion: row.object_version,
          orgId: row.org_id,
        });
      } else if (row.operation === "delete") {
        await deleteCurrentEpisodeFromGraphiti({
          objectId: row.object_id,
          orgId: row.org_id,
        });
      }
      // Mark outbox row done
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `UPDATE "${schema}"."graphiti_projection_outbox"
                 SET status = 'done', processed_at = now(), last_error = NULL
                 WHERE id = $1`,
            values: [row.id],
          },
        ],
      });
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `UPDATE "${schema}"."graphiti_projection_outbox"
                 SET status = 'failed', last_error = $1
                 WHERE id = $2`,
            values: [message.slice(0, 1000), row.id],
          },
        ],
      });
      // Also mark canonical row as failed for observability
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        queries: [
          {
            text: `UPDATE "${schema}"."objects"
                 SET graphiti_sync_status = 'failed',
                     graphiti_projection_error = $1
                 WHERE id = $2`,
            values: [message.slice(0, 1000), row.object_id],
          },
        ],
      });
    }
  }

  return { processed, failed };
}


// Semantic identity reader for the Graphiti projector. Direct PG read of
// `semantic_assertion` for the active (non-archived, eligible-only) rows
// of an artifact. Same precedence ranking as `primaryExtensionFor` in the
// assertion store (user > authoring_skill > agent > matcher). Inlined here
// (not imported from src/lib) so the objects package keeps its lean
// dependency surface — postgres-sync is already imported.
function readSemanticIdentityForProjection(
  orgId: string,
  artifactId: string,
): ArtifactSemanticIdentity {
  const schema = postgresSchema.replaceAll('"', '""');
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        // Deterministic ORDER BY so eligibleExtensions
        // is stable across projections (matches the canonical service
        // ordering in `listEligibleAssertions`).
        text: `SELECT extension, asserted_by, asserted_at
FROM "${schema}"."semantic_assertion"
WHERE org_id=$1 AND artifact_id=$2 AND eligibility='eligible'
ORDER BY asserted_at, extension`,
        values: [orgId, artifactId],
      },
    ],
  });
  type Row = { extension: string; asserted_by: string; asserted_at: string };
  const rows = (res?.rows ?? []) as Row[];
  const DEFAULT_EXT = DEFAULT_ARTIFACT_EXTENSION;
  const eligibleExtensions = rows.map((r) => String(r.extension));
  const nonDefault = rows.filter((r) => r.extension !== DEFAULT_EXT);
  if (nonDefault.length === 0) {
    // No non-floor eligible assertion ⇒ no primary extension (epic #1785 — the
    // default-artifact floor is retired as an identity).
    return {
      eligibleExtensions,
      primaryExtension: null,
    };
  }
  const rank = (src: string): number =>
    src === "user" ? 3 : src === "authoring_skill" ? 2 : src === "agent" ? 1 : 0;
  nonDefault.sort((a, b) => {
    const r = rank(b.asserted_by) - rank(a.asserted_by);
    if (r !== 0) return r;
    if (a.asserted_at !== b.asserted_at) {
      return a.asserted_at < b.asserted_at ? 1 : -1;
    }
    return a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0;
  });
  return {
    eligibleExtensions,
    primaryExtension: String(nonDefault[0]!.extension),
  };
}

import "server-only";
import { randomUUID } from "crypto";
import type { PrimitiveInvocationRequest, PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// Project-move helpers composed into `objects_update` for the optional
// `projectId` change branch:
//   - assertProjectWritable: target-side authz (write on target, target NOT
//     archived).
//   - runResourceProjectMoveTx: transactional cascade (UPDATE
//     objects.project_id + INSERT resource_project_moves audit row in
//     ONE tx with runPostgresQueriesSync({transaction:true})).
// The source-side authz is the existing objects.update enforcement that
// already gates entry to objects_update.
import { assertProjectWritable } from "@/lib/project-writable";
import { runResourceProjectMove } from "@/lib/resource-project-move";
import { classifyObject } from "../classifier";
import { resolveIdentity, hashIdentity } from "../identity";
import { ensureDynamicObjectType, readActiveDynamicObjectTypes, readAllDynamicObjectTypes, readDynamicObjectTypeByType } from "../auto-registrar";
import {
  searchNodes,
  identityHashToUuid,
} from "../graphiti-client";
import type { EntityNode } from "../graphiti-client";
// Connector dispatch is intentionally not active in this handler.
import { objectTypeRegistry } from "../registry";
// Write paths go through Postgres-primary CRUD; the legacy
// shadowUpsertObject (kept in src/lib/objects-dual-write.ts because asset-blog
// and agent-builder still depend on it) is no longer called from this file.
// Read paths are Postgres-primary too: objects_get + objects_list (without
// query) read via getObjectById / listObjectsByFilter; objects_list (with
// query) calls Graphiti's searchNodes for ranked IDs and then fetches
// canonical rows from Postgres (auth boundary + soft-delete filter live in
// PG). The legacy Graphiti-first reads
// (findEpisodeByObjectId, mapEpisodeToObject, mapEntityNodeToSearchResult)
// are removed.
import type { ObjectRecord } from "@/lib/objects-store";
import {
  upsertObjectAndEnqueue,
  getObjectById,
  listObjectsByFilter,
  softDeleteObject,
} from "@/lib/objects-store";
import { readObjectsClassificationModelFromDatabase } from "@/lib/database";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import * as schemas from "./schemas";
// Every objects_* handler routes its CRUD decision through
// `enforceResourceAccess`. Imported via the direct sub-file path (NOT the
// @/lib/authz barrel) because the barrel pulls in `import "server-only"` from
// enforce.ts and the unit tests for these handlers run in a Node vitest
// environment that cannot resolve "server-only".
import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
// Sealed-room read filter. `assertProjectReadAccess` 404-hides when the actor
// has no read+ grant on the supplied projectId; `listObjectsByFilter` then
// takes the projectId straight through and the SQL AND-clause enforces the
// canonical re-filter, including over Graphiti / semantic-search candidate
// sets.
//
// This file must NOT import the app-level resolver module from src/lib. The
// sealed-room path is independent of that resolver boundary.
import { assertProjectReadAccess } from "@/lib/sealed-room";

function resolveGroupId(orgId: string | null): string {
  return orgId ? `cinatra-org-${orgId}` : "cinatra-default";
}

function deriveEntityName(data: Record<string, unknown>, type: string): string {
  const candidates = ["name", "title", "displayName", "email", "slug"];
  for (const k of candidates) {
    const v = data[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return type;
}

// ---------------------------------------------------------------------------
// Actor context extension helper
//
// orgId / agentId / runId / packageVersion / agentSpecVersion are runtime-
// enriched fields passed from orchestration context. They are not part of the
// base PrimitiveActorContext type because they are optional and depend on how
// the calling orchestrator wires things up.
//
// Automatic agent runContext propagation. Resolution order: explicit
// `actor.<field>` (set by deterministic in-process callers) wins over the
// AsyncLocalStorage fallback (populated by the MCP transport handler from
// X-Cinatra-* headers attached by /api/llm-bridge). Both fall back to null
// when neither is present so save-paths without an active run continue to work
// unchanged.
// ---------------------------------------------------------------------------
function getActorExt(actor: PrimitiveActorContext) {
  const ext = actor as unknown as Record<string, unknown>;
  const ctx = mcpRequestContextStorage.getStore();
  return {
    orgId: (ext["orgId"] as string | null | undefined) ?? ctx?.orgId ?? null,
    agentId:
      (ext["agentId"] as string | null | undefined) ?? ctx?.agentId ?? null,
    packageVersion:
      (ext["packageVersion"] as string | null | undefined) ??
      ctx?.packageVersion ??
      null,
    agentSpecVersion:
      (ext["agentSpecVersion"] as string | null | undefined) ??
      ctx?.agentSpecVersion ??
      null,
    runId:
      (ext["runId"] as string | null | undefined) ?? ctx?.runId ?? null,
    userId: actor.userId ?? null,
    source: actor.source,
  };
}

// ---------------------------------------------------------------------------
// Postgres-row -> response shape mapper
// ---------------------------------------------------------------------------
//
// Maps the canonical ObjectRecord (from cinatra.objects via objects-store) to
// the response shape historically returned by mapEpisodeToObject /
// mapEntityNodeToSearchResult. The actor block preserves packageVersion +
// agentSpecVersion parity. classificationConfidence is read from the optional
// `classificationConfidence` field stashed on `data` by classifier flows
// (legacy rows return null).
function mapRowToObject(row: ObjectRecord): {
  id: string;
  type: string;
  name: string | null;
  data: Record<string, unknown>;
  classificationConfidence: number | null;
  parentId: string | null;
  parentType: string | null;
  actor: {
    agentId: string | null;
    packageVersion: string | null;
    agentSpecVersion: string | null;
    runId: string | null;
    source: string | null;
    userId: string | null;
  };
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
} {
  const data = (row.data as Record<string, unknown> | null) ?? {};
  const name =
    (typeof data.name === "string" && data.name) ||
    (typeof data.title === "string" && data.title) ||
    (typeof data.displayName === "string" && data.displayName) ||
    (typeof data.email === "string" && data.email) ||
    null;
  const confidenceRaw = data.classificationConfidence;
  return {
    id: row.id,
    type: row.type,
    name,
    data,
    classificationConfidence:
      typeof confidenceRaw === "number" ? confidenceRaw : null,
    parentId: row.parentId,
    parentType: row.parentType,
    actor: {
      agentId: row.agentId,
      packageVersion: row.packageVersion,
      agentSpecVersion: row.agentSpecVersion,
      runId: row.runId,
      source: row.source,
      userId: row.createdBy,
    },
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Graphiti search_nodes -> objectId extraction
// ---------------------------------------------------------------------------
//
// Reads cinatra_object_id off entity nodes returned by Graphiti's search_nodes
// MCP tool. cinatra_object_id is a top-level field of the episode_body JSON so
// that Graphiti's LLM extractor surfaces it on the resulting entity nodes.
//
// Recovery chain for cinatra_object_id from Graphiti entity nodes (search_nodes
// result). Graphiti's LLM extraction does NOT propagate custom JSON fields to
// entity node attributes in knowledge-graph-mcp 1.0.x / Graphiti 0.28.2.
// Four probes in order of reliability:
//   1. node.attributes.cinatra_object_id — future-proof if Graphiti adds attribute propagation
//   2. node.cinatra_object_id           — if Graphiti flattens episode body fields onto nodes
//   3. [oid:<uuid>] tag in node.name    — if Graphiti preserves the tag (future version)
//   4. node.name IS a bare UUID with label "Object" — confirmed Graphiti 0.28.2 behavior:
//      the UUID value from cinatra_object_id in the episode body is extracted as a distinct
//      Entity/Object node whose name IS the UUID string.
const OID_RE = /\[oid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractObjectIds(nodes: EntityNode[]): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    const attrs = (n as unknown as { attributes?: Record<string, unknown> })
      .attributes;
    const labels = (n as unknown as { labels?: string[] }).labels;
    const candidate =
      (attrs?.cinatra_object_id as unknown) ??
      (n as unknown as { cinatra_object_id?: unknown }).cinatra_object_id ??
      OID_RE.exec(n.name)?.[1] ??
      (labels?.includes("Object") && UUID_RE.test(n.name ?? "") ? n.name : undefined);
    if (typeof candidate === "string" && candidate.length > 0) {
      ids.push(candidate);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------
//
// `buildObjectResourceCheck` lifts the canonical owner_level / owner_id /
// visibility off an ObjectRecord into the generic envelope consumed by
// `enforceResourceAccess`. Objects do NOT have a co-owner table, so
// coOwnerUserIds is omitted.
//
// `deriveSaveDefaults` resolves the ownership defaults applied by
// `objects_save` when the caller does not supply explicit ownerLevel / ownerId
// / visibility:
//   - actor.userId present  → user/<userId>/private
//   - system / worker actor → organization/<orgId>/organization
// Explicit ObjectRecord.visibility -> kernel Visibility narrowing.
// The two unions are nominally equal today (`"private" | "team" |
// "organization" | "public"`), but the projects flow translates a
// distinct shape (`"discoverable" -> "public"`). To keep this site
// resilient to either union drifting (object-store widening, kernel
// narrowing), we explicitly enumerate the legal values and fall back
// to "private" for anything unexpected — denying access by default if a
// future enum value sneaks through is the safe direction.
const KERNEL_VISIBILITY = new Set<"private" | "team" | "organization" | "public">([
  "private",
  "team",
  "organization",
  "public",
]);

function normalizeObjectVisibility(
  v: ObjectRecord["visibility"],
): "private" | "team" | "organization" | "public" {
  return KERNEL_VISIBILITY.has(v) ? v : "private";
}

function buildObjectResourceCheck(row: ObjectRecord): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: row.id,
    organizationId: row.orgId ?? null,
    ownerLevel: normalizeOwnerLevel(row.ownerLevel),
    ownerId: row.ownerId,
    visibility: normalizeObjectVisibility(row.visibility),
  };
}

type SaveOwnership = {
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: "private" | "team" | "organization" | "public";
};

function deriveSaveDefaults(
  actor: PrimitiveActorContext,
  orgId: string | null,
  override?: {
    ownerLevel?: "user" | "team" | "organization" | "workspace";
    ownerId?: string;
    visibility?: "private" | "team" | "organization" | "public";
  },
): SaveOwnership {
  const userId = actor.userId ?? null;
  const defaultLevel: SaveOwnership["ownerLevel"] = userId
    ? "user"
    : "organization";
  const defaultOwnerId = userId ?? orgId ?? "";
  const defaultVisibility: SaveOwnership["visibility"] = userId
    ? "private"
    : "organization";

  return {
    ownerLevel: override?.ownerLevel ?? defaultLevel,
    ownerId: override?.ownerId ?? defaultOwnerId,
    visibility: override?.visibility ?? defaultVisibility,
  };
}

export function createObjectsPrimitiveHandlers() {
  return {
    "objects_save": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsSaveSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error("objects_save requires an authenticated org context (actor.orgId is null)");
      }

      // Resolve ownership defaults from the actor and let optional client
      // overrides flow through. The generic enforceResourceAccess gate runs
      // against the *projected* resource: for save (create) we evaluate
      // `object.create` against the soon-to-be-written row's scope so the
      // kernel can deny scope ratchet attempts the actor can't satisfy (e.g.
      // user trying to write a workspace-owned object).
      const ownership = deriveSaveDefaults(request.actor, orgId, {
        ownerLevel: input.ownerLevel,
        ownerId: input.ownerId,
        visibility: input.visibility,
      });
      // Dev bypass: when A2A_DEV_BYPASS is active and the actor is
      // a sessionless model caller (no userId — i.e. an LLM bridge call coming
      // from OpenAI's relay which has no user session), skip the authz gate.
      // The orgId guard above already ensures we have an org context. This
      // mirrors the existing pattern at the top of objects_save.
      const isTrustedDevModelCall =
        process.env.A2A_DEV_BYPASS === "true" && !getActorExt(request.actor).userId;
      if (!isTrustedDevModelCall) {
        await enforceResourceAccess(
          {
            resourceType: "object",
            resourceId: "<new>",
            organizationId: orgId,
            ownerLevel: normalizeOwnerLevel(ownership.ownerLevel),
            ownerId: ownership.ownerId,
            visibility: ownership.visibility,
          },
          request.actor,
          "object.create",
        );
      }

      // Canonical `rawData` + `typeHint` only; legacy `payload` / `type`
      // aliases are intentionally not supported here.
      const rawData = input.rawData ?? {};

      // 1. Classify
      const classificationModel = readObjectsClassificationModelFromDatabase();
      const classification = await classifyObject(rawData, input.typeHint, { model: classificationModel });

      // 2. Auto-register dynamic type whenever the resolved type is a @cinatra-ai/dynamic:*
      // ID (regardless of confidence / isNewType flag — the LLM may return high confidence
      // for a well-understood new type that simply has no static registration).
      if (classification.isNewType || classification.confidence < 0.4 || classification.type.startsWith("@cinatra-ai/dynamic:")) {
        // Build originContext from whatever provenance is available.
        // agentId/runId may be undefined for external callers. Conditionally
        // spread so the JSONB column stores a compact object (not
        // { agentId: undefined }).
        const originContext: Record<string, unknown> = {};
        if (actorExt.agentId) originContext.agentId = actorExt.agentId;
        if (actorExt.runId) originContext.runId = actorExt.runId;

        await ensureDynamicObjectType({
          type: classification.type,
          inferredName: classification.inferredTypeName ?? "unknown",
          inferredCategory: classification.inferredCategory ?? "report",
          createdBy: actorExt.userId,
          source: "classifier",
          confidence: classification.confidence >= 0.8 ? "high" : "low",
          canonicalKeys: classification.canonicalKeys ?? null,
          originContext,
          status: "proposed",
        });
      }

      // 3. Identity resolution — derive a stable object ID from identity hash.
      // This ID is stored in _cinatra.objectId and used as the public API identifier.
      // We do NOT pass it as the Graphiti episode UUID: knowledge-graph-mcp 1.0.x
      // rejects custom UUIDs for new episodes (the queue worker tries to find the node
      // before creating it). Graphiti assigns its own UUID; we locate episodes by
      // _cinatra.objectId on reads.
      //
      // `cinatraAgentRunId` is system-managed: injected from run context so
      // registered `identityKey` functions can use it for retry dedup without
      // LLMs needing to pass it explicitly. We do NOT overwrite an explicit
      // value if the LLM/agent supplied one. The enriched data flows through
      // identity resolution, the Graphiti episode body, and the shadow write,
      // keeping all three views consistent.
      const enrichedData: Record<string, unknown> =
        actorExt.runId && !("cinatraAgentRunId" in classification.normalizedData)
          ? { ...classification.normalizedData, cinatraAgentRunId: actorExt.runId }
          : { ...classification.normalizedData };

      // Layer 1+2: static registry identity resolution (external_id, identityKey fn).
      let identityHash = resolveIdentity(classification.type, enrichedData);

      // Layer 3: dynamic type identity_key field (only when static registry has no entry).
      if (identityHash === null && !objectTypeRegistry.resolve(classification.type)) {
        const dynType = await readDynamicObjectTypeByType(classification.type);
        if (dynType?.identityKey) {
          const fieldValue = enrichedData[dynType.identityKey];
          if (typeof fieldValue === "string" && fieldValue.trim() !== "") {
              identityHash = hashIdentity(classification.type, fieldValue.trim());
          }
        }
      }

      const groupId = resolveGroupId(orgId);
      const objectId = identityHash
        ? identityHashToUuid(identityHash, groupId)
        : randomUUID();

      // --- Postgres-primary write -------------------------------------------
      // A single atomic call to upsertObjectAndEnqueue inserts or updates the
      // row in cinatra.objects AND emits a graphiti_projection_outbox row in
      // the same transaction. The projector worker (graphiti-projector.ts)
      // picks up the outbox row within ~30 s and appends a new episode in
      // Graphiti.
      //
      // Append-only on update: on a re-save of an existing object, the
      // projector calls add_memory only — no deleteEpisode — so the bitemporal
      // trail in Graphiti is preserved.
      //
      // groupId / identityHashToUuid stay (they are still used for the
      // object's stable id) but are not passed to Graphiti from this hot
      // path.
      void groupId;
      const record = upsertObjectAndEnqueue({
        upsertInput: {
          id: objectId,
          type: classification.type,
          parentId: input.parentId ?? null,
          parentType: null,
          data: enrichedData,
          createdBy: actorExt.userId,
          orgId,
          source: actorExt.source ?? null,
          runId: actorExt.runId,
          agentId: actorExt.agentId,
          packageVersion: actorExt.packageVersion,
          agentSpecVersion: actorExt.agentSpecVersion,
          // Write the resolved ownership tuple.
          ownerLevel: normalizeOwnerLevel(ownership.ownerLevel),
          ownerId: ownership.ownerId,
          visibility: ownership.visibility,
        },
        operation: "upsert",
        payloadHash: identityHash ?? undefined,
      });

      // version === 1 means the INSERT path executed; version > 1 means the
      // ON CONFLICT DO UPDATE path executed (existing row was bumped).
      const isNew = record.version === 1;

      return {
        objectId: record.id,
        type: record.type,
        isNew,
        wasMerged: !isNew,
        confidence: classification.confidence,
        // Surface the change-set id (create + merge both produce one via the
        // canonical writer) so UI create actions can offer an Undo
        // (MutationResult).
        changeSetId: record.changeSetId,
      };
    },

    "objects_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsListSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "objects_list requires an authenticated org context (actor.orgId is null)",
        );
      }

      // Sealed-room read filter. When the caller supplies a projectId, 404-hide
      // if the actor has no read+ grant on it. The actor's projectGrants axis
      // is routed through the MCP registries (A2A path) and read here via the
      // ActorContext-shaped fields stamped on `request.actor`. Platform admins
      // bypass the grant check. The actual SQL `AND project_id = $projectId`
      // runs inside `listObjectsByFilter` (data layer); this preserves the
      // non-bypassable SQL re-filter.
      const projectId =
        typeof input.projectId === "string" && input.projectId.trim().length > 0
          ? input.projectId.trim()
          : null;
      if (projectId !== null) {
        const actorForGate = request.actor as unknown as Parameters<
          typeof assertProjectReadAccess
        >[0];
        assertProjectReadAccess(actorForGate, projectId);
      }

      const hasQuery =
        typeof input.query === "string" && input.query.trim().length > 0;

      // Common post-filter for the optional `category` enum. Type and runId
      // are pushed down into the SQL filter (listObjectsByFilter) so they hit
      // an index; category is resolved against the object-type registry which
      // lives client-side.
      const applyCategoryFilter = (
        items: ReturnType<typeof mapRowToObject>[],
      ) => {
        if (!input.category) return items;
        return items.filter((o) => {
          const def = objectTypeRegistry.resolve(o.type);
          return def?.category === input.category;
        });
      };

      // Authorization post-filter. Drop rows the actor cannot read; never
      // throw.
      //
      // The Graphiti search path below returns ranked object IDs only;
      // canonical rows are re-fetched from Postgres and run through
      // `filterByAuthz` here. This is the authorization boundary for the
      // derived Graphiti index.
      const filterByAuthz = async (
        rows: ObjectRecord[],
      ): Promise<ObjectRecord[]> => {
        const out: ObjectRecord[] = [];
        for (const r of rows) {
          try {
            await enforceResourceAccess(
              buildObjectResourceCheck(r),
              request.actor,
              "object.read",
            );
            out.push(r);
          } catch (err) {
            if (err instanceof AuthzError) continue;
            throw err;
          }
        }
        return out;
      };

      // -----------------------------------------------------------------
      // No query: Postgres-only listing — type / runId / org filtered in SQL.
      // -----------------------------------------------------------------
      if (!hasQuery) {
        const rows = listObjectsByFilter({
          orgId,
          type: input.type,
          runId: input.runId,
          limit: input.limit,
          // Pass projectId straight through; the store appends
          // `AND project_id = $projectId` when the per-table feature flag is
          // ON (default).
          projectId,
        });
        const visible = await filterByAuthz(rows);
        const items = applyCategoryFilter(visible.map(mapRowToObject));
        return { items, nextCursor: null };
      }

      // -----------------------------------------------------------------
      // With query: Graphiti for ranked IDs, Postgres for canonical rows.
      // searchNodes failure -> meta.semanticSearch="unavailable" +
      // meta.fallback="postgres_filter" + body from a Postgres-only list.
      // -----------------------------------------------------------------
      const groupId = resolveGroupId(orgId);
      let objectIds: string[] | null = null;
      let degraded = false;
      try {
        const res = await searchNodes({
          query: input.query!,
          group_ids: [groupId],
          max_nodes: input.limit ?? 50,
        });
        objectIds = extractObjectIds(res.nodes);
      } catch (err) {
        console.warn(
          "[objects_list] searchNodes failed; falling back to Postgres-only filter:",
          err,
        );
        degraded = true;
      }

      if (degraded || objectIds === null || objectIds.length === 0) {
        const rows = listObjectsByFilter({
          orgId,
          type: input.type,
          runId: input.runId,
          limit: input.limit,
          // Sealed-room filter applies on the Graphiti-fallback path too. The
          // user supplied a projectId; the result must stay inside the project
          // regardless of search path.
          projectId,
        });
        const visible = await filterByAuthz(rows);
        const items = applyCategoryFilter(visible.map(mapRowToObject));
        // Distinguish "Graphiti unavailable" from "Graphiti responded but
        // extracted no cinatra_object_id from the entity nodes". The latter
        // signals a field-path problem rather than a network error.
        const meta = degraded
          ? { semanticSearch: "unavailable" as const, fallback: "postgres_filter" as const }
          : objectIds !== null && objectIds.length === 0
            ? { semanticSearch: "no_ids_extracted" as const, fallback: "postgres_filter" as const }
            : undefined;
        return { items, nextCursor: null, ...(meta ? { meta } : {}) };
      }

      // Fetch canonical rows by ids — listObjectsByFilter suppresses ORDER BY
      // when `ids` is set so we can preserve the Graphiti rank ourselves.
      // Ranking is preserved via Map<string, ObjectRecord> — never rows.find()
      // (Pitfall §5: O(n²) and silently breaks on duplicate ids).
      //
      // Graphiti returned ranked candidate IDs that may include rows outside
      // the requested project. Passing `projectId` here means
      // `listObjectsByFilter` runs BOTH
      // `id = ANY($ids) AND project_id = $projectId` — the intersection drops
      // candidates from other projects or ambient scope. The re-filter is
      // non-bypassable because the AND-clause lives in the SQL store function,
      // NOT here. The UX caveat: when no candidate rows belong to the requested
      // project, the result is empty even though search returned hits — that is
      // the sealed-room contract, not a bug.
      const rows = listObjectsByFilter({
        orgId,
        ids: objectIds,
        type: input.type,
        runId: input.runId,
        projectId,
      });
      const byId = new Map<string, ObjectRecord>(rows.map((r) => [r.id, r]));
      const ordered = objectIds
        .map((id) => byId.get(id))
        .filter((r): r is ObjectRecord => r != null);
      const visible = await filterByAuthz(ordered);
      const items = applyCategoryFilter(visible.map(mapRowToObject));
      return { items, nextCursor: null };
    },

    "objects_get": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsGetSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error(
          "objects_get requires an authenticated org context (actor.orgId is null)",
        );
      }

      // Postgres-primary read.
      // getObjectById applies (org_id = $2 OR $2 IS NULL) and `deleted_at IS NULL`
      // in SQL, so wrong-tenant lookups and tombstoned rows return null.
      const row = getObjectById(input.objectId, { orgId });

      // Authorization gate. 404-hidden if denied. We only run the kernel when
      // the row actually exists; a missing row returns `{ object: null }` to
      // preserve the legacy contract (org_id scoping in the SQL already
      // prevents cross-tenant existence leaks via getObjectById).
      if (row) {
        await enforceResourceAccess(
          buildObjectResourceCheck(row),
          request.actor,
          "object.read",
        );
      }
      return { object: row ? mapRowToObject(row) : null };
    },

    "objects_update": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsUpdateSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error("objects_update requires an authenticated org context (actor.orgId is null)");
      }

      // --- Postgres-primary update ------------------------------------------
      // Read the existing row org-scoped via getObjectById — returns null for
      // wrong-tenant lookups. Merge incoming partial data on top of the stored
      // data, then atomically write+enqueue via upsertObjectAndEnqueue. The
      // projector will append a new episode in Graphiti (append-only — no
      // deleteEpisode + addEpisode pair here, the temporal trail is
      // preserved).
      const existing = getObjectById(input.objectId, { orgId });

      // Authorization gate before the not-found throw so unauthorized callers
      // get the same 404-hidden envelope as missing rows; never leak existence.
      await enforceResourceAccess(
        existing ? buildObjectResourceCheck(existing) : null,
        request.actor,
        "object.update",
      );
      if (!existing) {
        throw new Error(`Object not found: ${input.objectId}`);
      }

      // Project-move branch. Detect a change in `project_id`:
      //   - `input.projectId === undefined` → caller is not requesting
      //     a move; the row's project_id is preserved.
      //   - `input.projectId === existing.projectId` → no-op (don't
      //     write an audit row for a same-value move).
      //   - otherwise → run source authz (object.update already enforced
      //     above) and target authz (assertProjectWritable when moving to a
      //     non-null project), then transactional cascade (UPDATE
      //     objects.project_id + INSERT resource_project_moves audit).
      const wantsProjectMove =
        input.projectId !== undefined &&
        (input.projectId ?? null) !== (existing.projectId ?? null);
      if (wantsProjectMove) {
        const newProjectId = input.projectId ?? null;
        // Target-side authz for writes into a project. When moving INTO a
        // project (newProjectId !== null), require write on the target plus
        // archived check via assertProjectWritable. When moving OUT of a
        // project (newProjectId === null), no target authz is needed (ambient
        // writes are unscoped).
        if (newProjectId !== null) {
          await assertProjectWritable(
            request.actor as Parameters<typeof assertProjectWritable>[0],
            newProjectId,
            "write",
          );
        }
        // Cross-tenant guard: a move within objects_update can never
        // cross org boundaries (objects.org_id is preserved). The source
        // & target projects are both scoped to the actor's org via the
        // projects.organization_id boundary enforced in
        // packages/projects/src/mcp/handlers.ts buildProjectResourceCheck.
        // assertProjectWritable's grant-based check already implies the
        // actor has access to the target — and grants are tenant-scoped.
        const userId =
          (request.actor as PrimitiveActorContext).userId ?? actorExt.source ?? "system";
        runResourceProjectMove({
          table: "objects",
          resourceId: existing.id,
          resourceKind: "object",
          oldProjectId: existing.projectId ?? null,
          newProjectId,
          actorId: userId,
          sourceRunId: actorExt.runId ?? existing.runId ?? null,
          reason: input.reason ?? null,
        });
        // If the caller ONLY requested a project move (no data), return
        // early — no need to run the data upsert path.
        if (input.data === undefined) {
          return { ok: true as const };
        }
      }

      const incomingData =
        (input.data as Record<string, unknown> | undefined) ?? {};
      const mergedData = {
        ...((existing.data as Record<string, unknown> | null) ?? {}),
        ...incomingData,
      };

      const updated = upsertObjectAndEnqueue({
        upsertInput: {
          id: existing.id,
          type: existing.type,
          parentId: existing.parentId,
          parentType: existing.parentType,
          data: mergedData,
          createdBy: existing.createdBy,
          orgId,
          source: actorExt.source ?? existing.source,
          runId: actorExt.runId ?? existing.runId,
          agentId: actorExt.agentId ?? existing.agentId,
          packageVersion: actorExt.packageVersion ?? existing.packageVersion,
          agentSpecVersion:
            actorExt.agentSpecVersion ?? existing.agentSpecVersion,
          // Preserve the existing ownership tuple. Scope ratchet (promotion to
          // a higher tier) is handled by a dedicated path; objects_update never
          // demotes or sideways-shifts ownership.
          ownerLevel: existing.ownerLevel,
          ownerId: existing.ownerId,
          visibility: existing.visibility,
        },
        operation: "upsert",
      });

      // Surface the change-set id so UI write actions can offer an Undo
      // (MutationResult). The project-move-only early return above stays
      // `{ ok: true }` (no data write → no change-set).
      return { ok: true as const, changeSetId: updated.changeSetId };
    },

    "objects_delete": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsDeleteSchema.parse(request.input);
      const orgId = getActorExt(request.actor).orgId;
      if (!orgId && process.env.A2A_DEV_BYPASS !== "true") {
        throw new Error("objects_delete requires an authenticated org context (actor.orgId is null)");
      }

      // Authorization gate. Resolve the row first so the generic helper can
      // evaluate scope; 404-hidden when the row is absent or the actor cannot
      // see it.
      const existing = getObjectById(input.objectId, { orgId });
      await enforceResourceAccess(
        existing ? buildObjectResourceCheck(existing) : null,
        request.actor,
        "object.delete",
      );

      // --- Postgres-primary soft-delete -------------------------------------
      // softDeleteObject is an atomic CTE: UPDATE objects SET deleted_at = now()
      // (org-scoped — wrong-tenant calls update zero rows) AND insert a single
      // graphiti_projection_outbox row with operation='delete'. The projector
      // calls deleteEpisode against Graphiti async. The hot path no longer
      // touches Graphiti at all.
      // softDeleteObject returns the legacy change_set id it emits (NULL on a
      // no-op delete) so UI delete actions can offer an Undo (MutationResult).
      // Same legacy change_set the create/update path surfaces.
      const { changeSetId } = softDeleteObject(input.objectId, { orgId });

      return { ok: true as const, changeSetId: changeSetId ?? undefined };
    },

    "objects_classify": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsClassifySchema.parse(request.input);
      const actorExt = getActorExt(request.actor);
      const orgId = actorExt.orgId;

      // Authorization gate. When classify is invoked against an existing
      // object (input.objectId), evaluate object.read on the row before
      // classifying; otherwise it is a pure dry-run on caller-supplied rawData
      // and the gate is the caller's authenticated org context (already
      // enforced upstream by transport auth).
      let rawData = input.rawData ?? {};
      if (input.objectId) {
        const row = getObjectById(input.objectId, { orgId });
        await enforceResourceAccess(
          row ? buildObjectResourceCheck(row) : null,
          request.actor,
          "object.read",
        );
        if (row) {
          rawData = (row.data as Record<string, unknown> | null) ?? rawData;
        }
      }

      const classificationModel = readObjectsClassificationModelFromDatabase();
      const classification = await classifyObject(rawData, input.typeHint, { model: classificationModel });
      return classification; // dry-run — NO Graphiti write
    },

    "objects_types_list": async (_request: PrimitiveInvocationRequest<unknown>) => {
      const staticTypes = objectTypeRegistry.list().map((t) => ({
        type: t.type,
        category: t.category,
        description: `Registered type with identityKey=${t.identityKey ? "yes" : "no"}`,
        identityKey: t.identityKey ? "fn" : undefined,
      }));
      const dynamicTypes = (await readAllDynamicObjectTypes()).map((t) => ({
        type: t.type,
        category: t.inferredCategory,
        description: `Auto-registered dynamic type (${t.inferredName}) — status: ${t.status}`,
        identityKey: t.identityKey ?? undefined,
      }));
      return { types: [...staticTypes, ...dynamicTypes] };
    },

    // `objects_type_register` deliberately registers a new dynamic object type
    // as `active` (skips the proposed-review queue used by the classifier path
    // above). MCP-source registrations are explicit, structured acts; the
    // classifier path is autonomous and inherits the lower trust tier.
    // Namespace validation is enforced by `objectsTypeRegisterSchema`; never
    // check the regex inside this handler body.
    "objects_type_register": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.objectsTypeRegisterSchema.parse(request.input);
      const actorExt = getActorExt(request.actor);

      // Conditional spread; external callers may have no agentId/runId in the
      // actor extension.
      const originContext: Record<string, unknown> = {};
      if (actorExt.agentId) originContext.agentId = actorExt.agentId;
      if (actorExt.runId) originContext.runId = actorExt.runId;

      await ensureDynamicObjectType({
        type: input.typeId,
        inferredName: input.displayName,
        inferredCategory: input.category,
        createdBy: actorExt.userId,
        originContext,
        source: "mcp",
        canonicalKeys: input.canonicalKeys ?? null,
        identityKey: input.identityKey ?? null,
        status: "active",
      });

      // Idempotency: caller may invoke twice with the same typeId. Read the
      // current DB status rather than assuming "active" — admin may have
      // already archived this row, in which case the re-insert above is a
      // no-op (onConflictDoNothing) and the status stays "archived".
      const all = await readAllDynamicObjectTypes();
      const record = all.find((t) => t.type === input.typeId);
      return { type: input.typeId, status: record?.status ?? "active" };
    },
  } as const;
}

// ---------------------------------------------------------------------------
// Top-level `handlers` export.
//
// The authz test (`handlers-authz.test.ts`) imports the registry as
// `import { handlers } from "../handlers"`. The factory
// `createObjectsPrimitiveHandlers()` stays public for callers that want a fresh
// closure, and the singleton `handlers` supports unit tests and MCP-server
// registration paths that don't need the closure semantics.
// ---------------------------------------------------------------------------
export const handlers = createObjectsPrimitiveHandlers();

// ---------------------------------------------------------------------------
// Legacy episode-based read helpers removed.
//
// findEpisodeByObjectId, parseEpisodeContent, omitCinatraMeta,
// mapEpisodeToObject, and mapEntityNodeToSearchResult were the Graphiti-first
// read path. They are gone now: objects_get reads via getObjectById, and
// objects_list reads via listObjectsByFilter (with searchNodes used only for
// the optional semantic-rank ID list when input.query is set).
// ---------------------------------------------------------------------------

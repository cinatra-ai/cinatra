import "server-only";
import { randomUUID } from "crypto";
import type { PrimitiveInvocationRequest, PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// Value import: the structured, typed error the fail-closed write boundary
// throws. normalizePrimitiveError (@cinatra-ai/mcp-client) preserves its
// `code`/`details` onto the invocation failure, so the stable
// OBJECTS_TYPE_NOT_REGISTERED code + remediation detail reach the agent run's
// tool result (unlike a plain Error, which is flattened to `primitive_failed`).
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
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
// Substrate-exclusion predicate for the EXPLICIT project binding (cinatra#1377).
// The SAME rule the ambient write-time inheritance applies inside the store —
// imported here so an explicit binding of a substrate type is REFUSED rather
// than silently dropped. No new route-graph edge: `@/lib/objects-store` (already
// imported below, and reachable from every locked route these handlers serve)
// already pulls this module in for the ambient path.
import {
  resolveProjectInheritanceForType,
  shouldAutoTagProject,
} from "@/lib/project-inheritance";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { classifyObject } from "../classifier";
import type { ClassifierOutput } from "../classifier/schema";
import { resolveIdentity } from "../identity";
import {
  searchNodes,
  identityHashToUuid,
} from "../graphiti-client";
import type { EntityNode } from "../graphiti-client";
// Scope-recall lane entitlement (cinatra#1379 memory AC4, generalized to
// artifact rows in cinatra#1436 AC3). The lane math is shared with the
// projector (single source of truth for the nested-lane naming);
// `readTeamsForUser` resolves the actor's org-scoped team memberships. Both
// modules are already reachable from every locked route that reaches these
// handlers (measured: route-graph unchanged) — no new graph pressure.
// Artifact-scoped recall detection reads the type-driven disposition resolver
// (epic #1785), the SAME registry-backed rule the projector applies per-row and
// the rebuild driver uses, so a governed artifact-safe type surfaces its nested
// lanes on search and an uninstalled/ungoverned type never does.
import { deriveEntitledLanes } from "../graphiti-projection-policy";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { GENERIC_ARTIFACT_OBJECT_TYPE } from "../effective-identity";
// Connector dispatch is intentionally not active in this handler.
import {
  isDynamicObjectTypeId,
  isTombstonedObjectTypeId,
  OBJECT_TYPE_NAMESPACE_RE,
  GENERIC_OBJECT_TYPE_ID,
} from "../namespace";
import {
  objectTypeRegistry,
  isDispositionGovernedType,
  resolveTypeProjectionDisposition,
} from "../registry";
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
  resolveObjectIdsByAnchorNodeUuids,
  softDeleteObject,
} from "@/lib/objects-store";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import * as schemas from "./schemas";
// Every objects_* handler routes its CRUD decision through
// `enforceResourceAccess`. Imported via the direct sub-file path (NOT the
// @/lib/authz barrel) because the barrel pulls in `import "server-only"` from
// enforce.ts and the unit tests for these handlers run in a Node vitest
// environment that cannot resolve "server-only".
import {
  enforceResourceAccess,
  kernelActorForRead,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import type { ActorContext } from "@/lib/authz/actor-context";
import { AuthzError } from "@/lib/authz/errors";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
// Write-time scope-derived visibility (#1885 C1 / D10). The pure derivation is
// the sibling projection of the OBO ceiling chain — imported via the same
// pure-leaf subpath the kernel already uses, so no runtime graph pressure.
import {
  scopeOwnershipFromCeilingChain,
  type ScopeDerivedOwnership,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";
// Sealed-room read filter. `assertProjectReadAccess` 404-hides when the actor
// has no read+ grant on the supplied projectId; `listObjectsByFilter` then
// takes the projectId straight through and the SQL AND-clause enforces the
// canonical re-filter, including over Graphiti / semantic-search candidate
// sets.
//
// This file must NOT import the app-level resolver module from src/lib. The
// sealed-room path is independent of that resolver boundary.
import { assertProjectReadAccess } from "@/lib/sealed-room";

// ---------------------------------------------------------------------------
// Edge-bound object-type serve (cinatra#1392) — the CONSUME side.
//
// A dependent edge-bound to a NON-DEFAULT side-by-side version of an object-
// type-registering extension package must be served THAT version's retained
// object types instead of the default's, fail-closed. The serve machinery
// (trusted-identity resolution + version-keyed retention lookup) lives in the
// host lib `extension-edge-bound-serving.ts`, which publishes an
// `ExtensionObjectTypeServePort` on a globalThis singleton (via `Symbol.for`).
// This leaf package reads it OFF globalThis rather than importing it: the
// route-graph ratchet is shrink-only and these MCP handlers are reachable from
// the locked routes, so a static (or literal-dynamic) import of that host
// subgraph would grow those routes' reachable-module counts. Absent the port
// (its serve module never loaded — e.g. an in-process deterministic caller with
// no edge to bind anyway) BOTH consumers fall back to the DEFAULT behavior,
// which is the S7-consistent "no trusted identity ⇒ default serving" outcome.
// The Symbol key + these minimal shapes MUST match the publisher's port type.
const OBJECT_TYPE_SERVE_KEY = Symbol.for("@cinatra-ai/host:extension-object-type-serve/v1");

type RetainedObjectTypeDescriptor = { typeId: string; ioSpec?: unknown; [k: string]: unknown };

type EdgeBoundObjectTypePointDecision =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "versioned"; version: string; descriptor: RetainedObjectTypeDescriptor }
  | { kind: "refuse"; code: string; message: string };

type ObjectTypeServePort = {
  resolveObjectType(typeId: string): Promise<EdgeBoundObjectTypePointDecision>;
  planListing(): Promise<{
    substitutions: Array<{
      packageName: string;
      version: string;
      retainedTypes: readonly RetainedObjectTypeDescriptor[];
    }>;
    notes: string[];
  }>;
};

function readObjectTypeServePort(): ObjectTypeServePort | undefined {
  return (globalThis as unknown as { [k: symbol]: ObjectTypeServePort | undefined })[
    OBJECT_TYPE_SERVE_KEY
  ];
}

/**
 * Resolve the edge-bound object-type serve for a classified type on the SAVE
 * path (a POINT lookup). Returns the served NON-DEFAULT version when the caller
 * is edge-bound to it, else `null` (default / no pin / absent seam). FAIL-CLOSED:
 * a torn edge-bound retention (the caller pins a non-default version whose
 * serving state is unknown / not-servable, or that version registered no such
 * type) THROWS with evidence — the save never silently persists against the
 * default version's type.
 */
async function resolveEdgeBoundObjectTypeForSave(
  typeId: string,
): Promise<{ version: string } | null> {
  const port = readObjectTypeServePort();
  if (!port) return null;
  const decision = await port.resolveObjectType(typeId);
  if (decision.kind === "refuse") {
    throw new Error(`objects_save refused — edge-bound object-type serving: ${decision.message}`);
  }
  return decision.kind === "versioned" ? { version: decision.version } : null;
}

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
// Loud-drop diagnostics (D3 follow-up, cinatra#1948 (a)).
//
// `objects_list`'s authorization post-filter (`filterByAuthz`) drops rows the
// actor cannot read. For an INTERACTIVE caller (a UI user / an agent) that is
// the intended, silent behaviour — the caller simply cannot see some rows. For
// an INTERNAL / SYSTEM read (a background routing resolve, a worker) a drop
// means the internal read authority was MIS-SCOPED: the read returns `[]`
// indistinguishable from "no rows". That exact silence is what let the #1946
// send-routing defect (a role-less `System` actor denied `object.read`) hide
// across several verification rounds. So when the filter drops rows for an
// internal/system read we emit a structured `console.warn` (greppable,
// alertable) AND increment an in-process metric (scrapable by a metrics sink,
// deterministically observable in tests via the subscription hook).
//
// DELIBERATELY colocated in this already-route-reachable module rather than a
// new leaf file: `objects_list` is reachable from the locked FIXED_ROUTES and
// the route-graph ratchet (scripts/audit/route-graph-ratchet) is shrink-only —
// a NEW first-party module imported here would grow every locked route's
// reachable-module count. The metric state is `globalThis`-pinned (a single
// process-wide instance across module re-eval), mirroring the usage-event bus.
// ---------------------------------------------------------------------------

/** The minimal actor facets the internal/system-read predicate reads. */
export type InternalReadActorFacets = {
  actorType?: string | null;
  source?: string | null;
};

/**
 * Is this list read an INTERNAL / SYSTEM read (as opposed to an interactive
 * user / agent read)?
 *
 * True for exactly the two shapes the internal routing resolves produce:
 *   - `actorType === "system"` — a `System` / `InternalWorker` / service-account
 *     principal (the role-less-System silent-drop class), and
 *   - `source === "worker"` — a background/worker execution context (the
 *     `authSource:"worker"` the routing resolver stamps, including its
 *     HumanUser owner shape).
 *
 * Interactive callers — a UI user (`source:"ui"`, `actorType:"human"`) or an
 * agent (`source:"agent"`, `actorType:"model"`) — are NOT internal reads: a
 * dropped row there is the normal authorization post-filter, so the loud-drop
 * stays off for them (no noise).
 */
export function isInternalSystemRead(
  actor: InternalReadActorFacets | null | undefined,
): boolean {
  if (!actor) return false;
  return actor.actorType === "system" || actor.source === "worker";
}

/** Structured payload emitted when an internal/system read drops rows. */
export type InternalReadAuthzDrop = {
  /** The primitive that dropped rows (e.g. "objects_list"). */
  primitive: string;
  /** Number of rows the authz post-filter dropped. */
  droppedCount: number;
  /** Total rows considered before the post-filter. */
  totalCount: number;
  /** The dropped rows' distinct object types (for triage). */
  droppedTypes: string[];
  /** The read actor's tier — "system" / "human" / etc. */
  actorType: string | null;
  /** The read actor's source — "worker" / "scheduler" / etc. */
  source: string | null;
  /** The org the read was scoped to (mis-scoped reads still carry an org). */
  orgId: string | null;
};

type AuthzDropDiagnosticsState = {
  dropEvents: number;
  droppedRows: number;
  listeners: Set<(event: InternalReadAuthzDrop) => void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __cinatraObjectsInternalReadAuthzDrop: AuthzDropDiagnosticsState | undefined;
}

function authzDropState(): AuthzDropDiagnosticsState {
  if (!globalThis.__cinatraObjectsInternalReadAuthzDrop) {
    globalThis.__cinatraObjectsInternalReadAuthzDrop = {
      dropEvents: 0,
      droppedRows: 0,
      listeners: new Set(),
    };
  }
  return globalThis.__cinatraObjectsInternalReadAuthzDrop;
}

/** The stable diagnostic code — grep / alert on this. */
export const INTERNAL_READ_AUTHZ_DROP_CODE = "objects.filterByAuthz.internal_read_drop" as const;

/**
 * Record that an internal/system read dropped rows: a structured `console.warn`
 * (the loud, greppable line) + an in-process metric increment + listener
 * fan-out (the metric). Never throws — a diagnostic must never break a read.
 * Callers gate on `isInternalSystemRead(actor)` first.
 */
export function recordInternalReadAuthzDrop(event: InternalReadAuthzDrop): void {
  const state = authzDropState();
  state.dropEvents += 1;
  state.droppedRows += event.droppedCount;

  try {
    console.warn(
      `[${event.primitive}] filterByAuthz dropped ${event.droppedCount}/${event.totalCount} row(s) on an ` +
        `internal/system read — the internal read authority is likely MIS-SCOPED ` +
        `(a mis-scoped internal read returns [] indistinguishable from "no rows"; D3 follow-up cinatra#1948).`,
      {
        code: INTERNAL_READ_AUTHZ_DROP_CODE,
        primitive: event.primitive,
        droppedCount: event.droppedCount,
        totalCount: event.totalCount,
        droppedTypes: event.droppedTypes,
        actorType: event.actorType,
        source: event.source,
        orgId: event.orgId,
      },
    );
  } catch {
    // console failures must never break a read.
  }

  for (const listener of state.listeners) {
    try {
      listener(event);
    } catch {
      // A misbehaving metrics sink must never break a read.
    }
  }
}

/**
 * Subscribe to internal/system-read drop events (a metrics sink, or a test).
 * Returns an unsubscribe function.
 */
export function onInternalReadAuthzDrop(
  listener: (event: InternalReadAuthzDrop) => void,
): () => void {
  const state = authzDropState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/** Read the in-process metric counters (for a scrape endpoint / tests). */
export function getInternalReadAuthzDropMetric(): {
  dropEvents: number;
  droppedRows: number;
} {
  const { dropEvents, droppedRows } = authzDropState();
  return { dropEvents, droppedRows };
}

/** Reset the metric counters (test helper). Does not clear listeners. */
export function resetInternalReadAuthzDropMetric(): void {
  const state = authzDropState();
  state.dropEvents = 0;
  state.droppedRows = 0;
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
// AsyncLocalStorage fallback (populated by the MCP transport handler from the
// resolved run context — the signed agent-run OBO token or the durable
// run-token-keyed binding; cinatra#1195 deleted the in-process registry, and a
// run id claimed only by the caller-controlled `x-cinatra-run-id` header is
// REFUSED at the transport rather than landing here). Both fall back to null
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
// DETERMINISTIC FIRST, incidental second (cinatra#2591 deliverable 4).
//
// WHAT THIS USED TO BE. A chain of four probes that read a row id off whatever
// Graphiti's extraction model happened to put on an entity node. Three of them
// were measured INERT against Graphiti 0.28.2 (live verification 2026-04-30 —
// custom episode-body fields do not reach node attributes, and the `[oid:…]`
// name tag does not survive extraction). The fourth fired only when the model
// incidentally emitted the row UUID as an entity-node name. So a recall could
// report `no_ids_extracted` for a row that was definitely indexed, and the
// planned `memory_recall` semantic path (cinatra#1380) would have inherited
// that.
//
// WHAT IT IS NOW. Every projected row is seeded as a DETERMINISTIC anchor node
// whose UUID is a pure function of the row id and the lane
// (`graphiti-projector.ts` -> `anchorNodeUuidFor`), and the inverse map lives in
// Postgres (`objects.graphiti_anchor_node_uuid`). Ranked node UUIDs resolve
// through that column. Nothing depends on model whim.
//
// THE LEGACY PROBES ARE KEPT, DEMOTED. They are the ONLY recovery path for rows
// projected before this change (their anchor column is null until the next
// projection) and for adapter-owned rows that project through their own
// episode. They run second and only add ids the deterministic pass did not
// already produce. They are not the mechanism; they are the tail.
const OID_RE = /\[oid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pre-#2591 chain: ids read off model-produced node fields. Inert for most
 *  nodes by measurement; retained for rows with no anchor yet. */
function extractIncidentalObjectIds(nodes: EntityNode[]): string[] {
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

/**
 * Ranked entity nodes -> canonical object ids, RANK PRESERVED.
 *
 * Walks the nodes in the order Graphiti ranked them and emits, per node, the
 * deterministically-anchored row id when there is one, otherwise whatever the
 * incidental probes can recover. De-duplicated, because two ranked nodes can
 * legitimately resolve onto the same row (a merged anchor).
 */
function resolveObjectIds(nodes: EntityNode[], orgId: string | null): string[] {
  const byAnchor = resolveObjectIdsByAnchorNodeUuids(
    nodes.map((n) => n.uuid).filter((u): u is string => typeof u === "string"),
    orgId,
  );
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    // A merged anchor can name more than one row — take all of them.
    const deterministic = node.uuid ? byAnchor.get(node.uuid) : undefined;
    const candidates =
      deterministic && deterministic.length > 0
        ? deterministic
        : extractIncidentalObjectIds([node]);
    for (const id of candidates) {
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  return ordered;
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

/**
 * Actor-scoped READ context (cinatra#1428 RBAC matrix): the canonical read
 * surfaces (`objects_get` / `objects_list`) splice the SAME SQL ownership
 * filter the artifact read surface uses, by passing this kernel actor into
 * `getObjectById` / `listObjectsByFilter`. Without it, the objects surface
 * returned rows (e.g. another user's private rows within the org) that the
 * artifact surface's data layer denies — breaking the cross-surface
 * invariant: neither surface returns a row the other would deny.
 *
 * Returns `undefined` (no filter — legacy trusted read) ONLY for the
 * dev-bypass case (`A2A_DEV_BYPASS=true` with a sessionless model caller),
 * mirroring `objects_save`'s `isTrustedDevModelCall` posture.
 */
function readScopeActor(
  actor: PrimitiveActorContext,
  orgId: string | null,
): ActorContext | undefined {
  if (process.env.A2A_DEV_BYPASS === "true" && !(actor.userId ?? null)) {
    return undefined;
  }
  return kernelActorForRead(actor, orgId);
}

function buildObjectResourceCheck(row: ObjectRecord): ResourceForAccessCheck {
  return {
    resourceType: "object",
    resourceId: row.id,
    organizationId: row.orgId ?? null,
    ownerLevel: normalizeOwnerLevel(row.ownerLevel),
    ownerId: row.ownerId,
    visibility: normalizeObjectVisibility(row.visibility),
    // Project-axis identity for the OBO scope-ceiling gate (W2/#1051): an
    // object's `project_id` refinement (null for org-substrate objects). A
    // project-anchored agent is confined to objects tagged for its project.
    projectId: row.projectId,
  };
}

type SaveOwnership = {
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: "private" | "team" | "organization" | "public";
};

/**
 * Write-time scope-derived ownership default for an `agent_run`-delegated save
 * (#1885 C1 / D10). Keyed STRICTLY on the actor's OBO ceiling chain, which the
 * MCP registries stamp ONLY for `delegation === "agent_run"` (undefined for
 * chat-delegated / session / machine callers — those keep the human-user
 * defaults below). Reduces the run's carried (composed, verified) chain to the
 * row tuple via the single shared derivation, so an agent's outputs land no
 * wider than the agent's own anchored reach. Returns null for a non-agent-run
 * actor (no chain) → caller falls back to the human-user defaults.
 */
function deriveAgentRunScopeOwnership(
  actor: PrimitiveActorContext,
  orgId: string | null,
): ScopeDerivedOwnership | null {
  const chain = actor.oboCeiling;
  if (!chain || chain.length === 0 || !orgId) return null;
  return scopeOwnershipFromCeilingChain(chain as OboCeilingChain, orgId);
}

function deriveSaveDefaults(
  actor: PrimitiveActorContext,
  orgId: string | null,
  override?: {
    ownerLevel?: "user" | "team" | "organization" | "workspace";
    ownerId?: string;
    visibility?: "private" | "team" | "organization" | "public";
  },
  // When present (agent_run delegation), the scope-derived tuple is the write
  // DEFAULT in place of the human-user defaults; explicit tool-input overrides
  // still win (within the ceiling, enforced by the create probe below).
  scopeDefault?: ScopeDerivedOwnership | null,
): SaveOwnership {
  const userId = actor.userId ?? null;
  const defaultLevel: SaveOwnership["ownerLevel"] =
    scopeDefault?.ownerLevel ?? (userId ? "user" : "organization");
  const defaultOwnerId = scopeDefault?.ownerId ?? userId ?? orgId ?? "";
  const defaultVisibility: SaveOwnership["visibility"] =
    scopeDefault?.visibility ?? (userId ? "private" : "organization");

  return {
    ownerLevel: override?.ownerLevel ?? defaultLevel,
    ownerId: override?.ownerId ?? defaultOwnerId,
    visibility: override?.visibility ?? defaultVisibility,
  };
}

/**
 * Per-claim activation gate — NEW-write enforcement (cinatra#1429, epic #1424).
 * On the `objects_save` / `objects_update` write paths: when the resolved object
 * type carries an active DEDICATED claim AND a registered Zod schema, a write of
 * an invalid payload is REJECTED (`InvalidActivatedTypePayloadError`). No-op for
 * unclaimed types or types with no registered schema (substrate behavior
 * preserved) — the type's LEGACY rows are handled by the pre-activation
 * audit/quarantine, not here. The kill-switch
 * `CINATRA_DISABLE_ACTIVATED_TYPE_ENFORCEMENT=true` disables it for emergency
 * operability without a code change (default: enforced/on).
 *
 * The registered-schema lookup gates the claim DB probe: an unregistered type
 * can never carry a validator, so it short-circuits WITHOUT the
 * `typeHasActiveDedicatedClaim` query — only a registered type pays the probe.
 */
async function enforceActivatedTypePayload(
  objectTypeId: string,
  orgId: string | null,
  data: unknown,
): Promise<void> {
  // No org context (the A2A_DEV_BYPASS sessionless-model path) → no scope to
  // resolve an org/platform claim against; the dev bypass is already a trusted
  // write path, so skip enforcement rather than probe with a null scope.
  if (orgId == null) return;
  if (process.env.CINATRA_DISABLE_ACTIVATED_TYPE_ENFORCEMENT === "true") return;
  const def = objectTypeRegistry.resolve(objectTypeId);
  if (!def) return;
  // Lazy-import the app-layer gate so the objects_save handler graph gains NO
  // static edge to it — the route-graph budgets (and the in-flight #1473
  // route-graph baseline) stay untouched. Cached after first load; the
  // enforcement is still AWAITED before the write, so it can reject.
  const { assertActivatedTypePayloadValid, typeHasActiveDedicatedClaim } =
    await import("@/lib/objects/claim-activation-gate");
  assertActivatedTypePayloadValid({
    objectTypeId,
    data,
    hasActiveClaim: typeHasActiveDedicatedClaim(orgId, objectTypeId),
    validate: (d) => def.schema.safeParse(d).success,
  });
}

/**
 * Draftable mutability lock — write-path enforcement (cinatra#1449 forward
 * contract, wired for linkedin:post-draft, cinatra#1457). On the
 * `objects_save` / `objects_update` content-write paths: when the resolved type
 * carries a winning `mutability: "draftable"` claim AND the publication ledger
 * holds a locking operation (scheduled/published/failed) for the artifact, the
 * content write is REJECTED (`DraftLockedError`) BEFORE any commit — a draft is
 * editable only while a draft, then it locks. A no-op for non-draftable types
 * and for a draftable artifact with no live publication operation.
 *
 * Lazy-import of the app-layer gate so the objects_save handler graph gains NO
 * static edge to the app-layer ledger / claim store (the same discipline
 * `enforceActivatedTypePayload` uses). Still AWAITED before the write, so it can
 * reject. The null-org / kill-switch skips are ALSO applied inside the gate; the
 * early returns here avoid the dynamic import on the hot path when there is
 * nothing to enforce.
 */
async function enforceDraftableLock(
  objectTypeId: string,
  orgId: string | null,
  artifactId: string,
): Promise<void> {
  if (orgId == null) return;
  if (process.env.CINATRA_DISABLE_DRAFTABLE_LOCK_ENFORCEMENT === "true") return;
  const { assertDraftableWriteAllowed } = await import("@/lib/objects/draftable-lock-gate");
  await assertDraftableWriteAllowed({ orgId, objectTypeId, artifactId });
}

// The `@cinatra-ai/memory:concept` type id, inlined as a literal on purpose:
// importing it from `../integration/register-types` would add a static edge
// to the locked-route-reachable objects_save handler graph (same route-graph-
// budget reasoning as the lazy claim-gate import above). The source of truth
// is `MEMORY_CONCEPT_TYPE_ID` in
// `packages/objects/src/integration/register-types.ts`; the registration +
// handler tests exercise this literal against that constant.
const MEMORY_CONCEPT_TYPE_ID = "@cinatra-ai/memory:concept";

/**
 * Is `type` an ARTIFACT-scoped recall type (cinatra#1436 AC3)?
 * True for the generic artifact object type, and for any DISPOSITION-GOVERNED
 * type whose type-driven disposition resolves to 'artifact-safe' / faceted — the
 * same lane-eligible set the projector nests into per-scope lanes, so a recall
 * must search the caller's entitled lane set (not the ambient lane alone) or it
 * would miss the caller's own user-/team-lane artifacts. Memory is handled by
 * its own branch (never reaches here). The disposition is resolved through the
 * SAME shared registry-backed resolver the projector/rebuild use (epic #1785),
 * so the four surfaces agree. An ungoverned data type, or an uninstalled definer
 * (resolver → 'none'), is NOT artifact-scoped. The lane is relevance scoping
 * only — every candidate is still Postgres ownership-filtered + object.read-gated
 * after search.
 */
function isArtifactScopedRecallType(type: string): boolean {
  if (type === GENERIC_ARTIFACT_OBJECT_TYPE) return true;
  if (type === MEMORY_CONCEPT_TYPE_ID) return false;
  return (
    isDispositionGovernedType(type) &&
    resolveTypeProjectionDisposition(type) === "artifact-safe"
  );
}

/**
 * Fail-closed registration probe shared by the memory-envelope gate and the
 * objects_save pre-classification guard: a memory-typed write with no static
 * registration has no enforceable envelope schema — refuse rather than
 * persist unvalidated.
 */
function resolveMemoryConceptDefOrThrow() {
  const def = objectTypeRegistry.resolve(MEMORY_CONCEPT_TYPE_ID);
  if (!def) {
    throw new Error(
      `[objects:memory-concept] refusing to write "${MEMORY_CONCEPT_TYPE_ID}": the static type is not registered, so its envelope schema cannot be enforced`,
    );
  }
  return def;
}

/**
 * Memory-envelope enforcement (cinatra#1376, epic #1373). Memory rows take
 * the deterministic static-type path; this gate wires the type's REGISTERED
 * Zod schema (defined in `integration/register-types.ts`, resolved via the
 * registry — no new import edge) into the objects_save / objects_update write
 * paths so an invalid envelope is rejected BEFORE any commit.
 *
 * Scoped to `@cinatra-ai/memory:concept` in this slice (generalizing
 * registered-schema enforcement to other static types is separate follow-up
 * work — cinatra#1376 scope note). Unlike the per-claim activation gate above
 * it is unconditional and fail-closed: no claim probe, no org-context skip,
 * no kill-switch — memory files are untrusted input end-to-end, and a
 * memory-typed write whose schema cannot be resolved is refused outright.
 *
 * FAIL-CLOSED COVERAGE NOTE: this gate keys on the RESOLVED type id, which
 * on objects_save is `classifyObject`'s output. When the static registration
 * is missing, the classifier's static fast-path cannot fire and its LLM
 * output schema is enum-constrained to registered/dynamic ids — so the
 * memory id can never reach this gate from the save path. The save handler
 * therefore carries its own pre-classification guard on the DECLARED
 * `typeHint` (see objects_save) so a memory-declared save is refused before
 * classification instead of being misclassified and persisted unvalidated.
 * objects_update needs no such guard: it keys on the existing row's stored
 * type and always reaches this gate.
 *
 * Returns the data TO PERSIST. For a valid memory envelope this is the input
 * with the schema's `okfVersion` default ("0.1") materialized when the caller
 * omitted it — the parsed output itself is NOT stored because Zod's strip
 * mode would drop unknown top-level keys (the system-injected
 * `cinatraAgentRunId`). Non-memory types pass through untouched.
 */
function enforceMemoryConceptEnvelope(
  objectTypeId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (objectTypeId !== MEMORY_CONCEPT_TYPE_ID) return data;
  const def = resolveMemoryConceptDefOrThrow();
  const parsed = def.schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `[objects:memory-concept] invalid memory concept envelope: ${issues}`,
    );
  }
  if (data.okfVersion === undefined) {
    const parsedOkfVersion = (parsed.data as { okfVersion?: unknown }).okfVersion;
    return { ...data, okfVersion: parsedOkfVersion ?? "0.1" };
  }
  return data;
}

// ---------------------------------------------------------------------------
// Fail-closed writes (owner ruling 2026-07-18; epic cinatra#1785).
//
// "Types exist ONLY by installation." An `objects_save` whose content cannot be
// placed under a type an installed artifact extension DEFINES is REFUSED at the
// write boundary — never persisted under any fallback name. This supersedes the
// #1787 "lossless generic fallback" (which saved unclassifiable content as a
// `@cinatra-ai/objects:object` row): there is no untyped/catch-all object
// persistence any more. The refused payload never reaches the store; the run's
// structured error is ordinary run history, not an object row.
//
// The classifier still runs — it is how a save is matched to an installed type
// — and still never mints dynamic-type ids (see classifier/{prompt,schema}.ts).
// Only the write-path disposition of an UNMATCHED result changed: fall back →
// refuse.
// ---------------------------------------------------------------------------

// The retired generic host object type. Under the dependency model it is dead
// in every form: no save may ever land here again (the #1792 purge removes the
// historical rows). `GENERIC_OBJECT_TYPE_ID` is imported from `../namespace`
// (a dependency-free leaf, same route-graph-budget reasoning as
// MEMORY_CONCEPT_TYPE_ID above) — the SINGLE canonical declaration the
// classifier catalog (`../classifier/index.ts`) also reads, so the two
// surfaces can never diverge again (cinatra#2592).

/** Stable machine-readable code for the fail-closed write rejection. Surfaced
 *  on the run's tool result via PrimitiveInvocationError.code — bump/extend the
 *  code set only with a documented contract change (packages/objects/AGENTS.md). */
const OBJECTS_TYPE_NOT_REGISTERED = "OBJECTS_TYPE_NOT_REGISTERED" as const;

/** Stable codes for the explicit-project-binding refusals (cinatra#1377).
 *  Same contract as OBJECTS_TYPE_NOT_REGISTERED above: machine-readable, carried
 *  onto the run's tool result by normalizePrimitiveError, extended only with a
 *  documented contract change (packages/objects/AGENTS.md). */
const OBJECTS_SUBSTRATE_TYPE_NOT_PROJECT_SCOPED =
  "OBJECTS_SUBSTRATE_TYPE_NOT_PROJECT_SCOPED" as const;
const OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED =
  "OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED" as const;
const OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED =
  "OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED" as const;
const OBJECTS_COLLISION_ROW_DELETED = "OBJECTS_COLLISION_ROW_DELETED" as const;

/**
 * Derive the DEFINING extension package of a namespaced object-type id
 * (`@scope/pkg:local` → `@scope/pkg`). Under the dependency model exactly one
 * artifact extension defines a type, and the type id is namespaced under that
 * definer — so the package prefix names the definer. Returns null for a
 * non-namespaced / malformed id (nothing to suggest installing).
 */
function deriveDefinerExtension(typeId: string): string | null {
  if (!OBJECT_TYPE_NAMESPACE_RE.test(typeId)) return null;
  const colon = typeId.lastIndexOf(":");
  return colon > 0 ? typeId.slice(0, colon) : null;
}

/**
 * Refuse a save whose type has no installed definer (fail-closed write
 * boundary). Throws a structured PrimitiveInvocationError carrying the stable
 * OBJECTS_TYPE_NOT_REGISTERED code and the ratified message
 * ("no installed artifact extension defines <type>"). The install hint
 * ("install <extension>") is appended ONLY when a concrete, currently-uninstalled
 * definer is actually known — i.e. the caller named a namespaced type whose
 * defining package has registered no types in this process. When no concrete
 * type is known (a pure unclassifiable save), the message states that no
 * installed extension matched, with no fabricated install suggestion.
 *
 * @param attemptedType the concrete type id the save resolved to / named, or
 *   null when the classifier produced no installed-type id at all.
 */
function refuseUnregisteredWrite(attemptedType: string | null): never {
  const typePhrase = attemptedType ? `"${attemptedType}"` : "this content";
  // Only suggest an install when the definer is KNOWN-but-not-installed: a
  // namespaced type id whose defining package currently has zero registered
  // types (declared/named but not installed). Never invent a suggestion for a
  // type that is registered (that path never reaches here) or unknowable.
  let suggestedExtension: string | null = null;
  if (
    attemptedType &&
    attemptedType !== GENERIC_OBJECT_TYPE_ID &&
    !isTombstonedObjectTypeId(attemptedType) &&
    !objectTypeRegistry.resolve(attemptedType)
  ) {
    const definer = deriveDefinerExtension(attemptedType);
    if (definer && objectTypeRegistry.getTypesForPackage(definer).length === 0) {
      suggestedExtension = definer;
    }
  }
  const message = suggestedExtension
    ? `no installed artifact extension defines ${typePhrase}; install ${suggestedExtension}`
    : `no installed artifact extension defines ${typePhrase}`;
  throw new PrimitiveInvocationError({
    code: OBJECTS_TYPE_NOT_REGISTERED,
    message,
    // A refused write is a client/authoring error, not a transient failure —
    // retrying the identical save will fail identically.
    retryable: false,
    details: {
      attemptedType,
      ...(suggestedExtension ? { suggestedExtension } : {}),
    },
  });
}

/**
 * Stable machine-readable code for a save whose write PRECONDITION failed
 * (cinatra#1377): the writer's armed `collisionGuard` blocked the DO UPDATE arm
 * rather than write a row nobody authorized.
 *
 * The code and its message are CAUSE-NEUTRAL on purpose. Two predicates block
 * that arm — the collision guard (the row moved on since the handler's
 * `object.update` probe) and the cross-tenant `org_id` guard — and they produce
 * the same empty result. Nothing outside the failed statement can tell them
 * apart, so neither this error nor its message asserts which one fired.
 *
 * TERMINAL for the same reason: neither cause permits replaying this invocation
 * under the authorization it already carries. A caller that wants to try again
 * re-reads the row and re-authorizes against what is actually there, which is a
 * fresh save. Auto-retrying a write whose authorization could not be confirmed is
 * the thing the guard exists to prevent.
 */
const OBJECTS_WRITE_PRECONDITION_FAILED = "OBJECTS_WRITE_PRECONDITION_FAILED" as const;

/**
 * `upsertObjectAndEnqueue` for the objects_save path, translating the writer's
 * guard refusal into the structured primitive error. Any other failure
 * propagates untouched.
 */
function runGuardedSaveUpsert(
  input: Parameters<typeof upsertObjectAndEnqueue>[0],
): ReturnType<typeof upsertObjectAndEnqueue> {
  try {
    return upsertObjectAndEnqueue(input);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === OBJECTS_WRITE_PRECONDITION_FAILED) {
      throw new PrimitiveInvocationError({
        code: OBJECTS_WRITE_PRECONDITION_FAILED,
        message:
          "the write precondition failed; nothing was written; re-read this object and re-authorize before saving again",
        retryable: false,
        details: { objectId: input.upsertInput.id ?? null },
      });
    }
    throw err;
  }
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
      // Write-time scope-derived visibility (#1885 C1 / D10): for an agent_run
      // delegation the ownership DEFAULT is derived from the run's anchor (the
      // carried OBO ceiling chain), not the human-user default. Null for every
      // other caller (chat/session/machine) → human-user defaults preserved.
      const scopeDefault = deriveAgentRunScopeOwnership(request.actor, orgId);
      const ownership = deriveSaveDefaults(
        request.actor,
        orgId,
        {
          ownerLevel: input.ownerLevel,
          ownerId: input.ownerId,
          visibility: input.visibility,
        },
        scopeDefault,
      );

      // --- Explicit project binding (cinatra#1377, epic #1373) --------------
      //
      // An external (CLI) writer reaches this primitive over the authenticated
      // MCP transport and carries NO ambient `projectContext` frame, so it can
      // name the target project explicitly. Three-state precedence, keyed on
      // PRESENCE of the field:
      //   - omitted       → ambient inheritance, unchanged.
      //   - explicit null → substrate write; the ambient frame is IGNORED.
      //   - explicit id   → bind to that project; the ambient frame is IGNORED.
      //
      // The explicit path never reads the frame — that is what makes it usable
      // from outside a run, and it also means a stray ambient frame cannot
      // bleed into an explicitly-scoped write (AC4).
      const hasExplicitProjectBinding = input.projectId !== undefined;
      const explicitProjectId = input.projectId ?? null;

      // A caller-supplied project id is a REQUEST, never a grant. Authorize it
      // against the caller's own project axis before anything else, fail-closed
      // and in this order:
      //   1. `assertProjectReadAccess` — 404-hides a project the caller holds
      //      no grant on, so the gate is not an existence oracle. (Calling
      //      `assertProjectWritable` alone would answer 404 for an unknown
      //      project and 403 for a known one the caller cannot reach.)
      //   2. `assertProjectWritable(..., "write")` — existence, the archive
      //      gate (sealed/archived projects reject new writes), and the write
      //      role tier.
      // An unresolved `projectGrants` axis means "no grants" in both helpers,
      // so a legacy caller that never resolved the axis is denied, not passed.
      if (hasExplicitProjectBinding && explicitProjectId !== null) {
        const actorForProjectGate = request.actor as unknown as Parameters<
          typeof assertProjectReadAccess
        >[0];
        assertProjectReadAccess(actorForProjectGate, explicitProjectId);
        await assertProjectWritable(
          request.actor as Parameters<typeof assertProjectWritable>[0],
          explicitProjectId,
          "write",
        );
      }

      // Project refinement the row will carry, threaded into the create probe
      // so the OBO project-axis ceiling evaluates against the REAL project this
      // row lands in (#1885 C1: "the create probe carries real ownership +
      // projectId"). On the EXPLICIT branch the store writes from the same
      // resolution (the binding forwarded below), so probe and write cannot
      // disagree there. On the ambient branch they can: the probe carries the
      // frame's projectId unfiltered, while the writer runs the frame through
      // `resolveProjectInheritanceForType`, which drops it for a substrate
      // type — that row lands with `project_id` NULL after being probed
      // against the frame's project. Pre-existing ambient behaviour, unchanged
      // here.
      //
      // The frame is read INSIDE the ambient branch on purpose: on the explicit
      // path this handler must not so much as touch the request-scoped frame, so
      // no future edit can accidentally let it influence the outcome.
      const probeProjectId = hasExplicitProjectBinding
        ? explicitProjectId
        : (mcpRequestContextStorage.getStore()?.projectContext?.projectId ?? null);
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
            projectId: probeProjectId,
          },
          request.actor,
          "object.create",
        );
      }

      // Canonical `rawData` + `typeHint` only; legacy `payload` / `type`
      // aliases are intentionally not supported here.
      const rawData = input.rawData ?? {};

      // Fail-closed pre-classification guard (cinatra#1376): a save that
      // DECLARES the memory type must be refused HERE when the static
      // registration is missing. classifyObject's static fast-path requires a
      // registry hit, and its LLM output schema is enum-constrained to
      // registered/dynamic ids — so with the registration gone the memory id
      // can never come back as `classification.type`, the envelope gate below
      // would never fire, and the payload would be misclassified (or minted
      // as a dynamic type) and persisted with no envelope validation at all.
      if (input.typeHint === MEMORY_CONCEPT_TYPE_ID) {
        resolveMemoryConceptDefOrThrow();
      }

      // 1. Classify — used to MATCH the save to a type an installed artifact
      // extension defines. A classifier that throws (no LLM configured,
      // malformed output, or an LLM that tries to mint a now-rejected dynamic
      // id) leaves us with no installed-type match, so the fail-closed guard
      // below REFUSES the write (owner ruling 2026-07-18; epic cinatra#1785): there is no
      // longer any lossless generic fallback (#1787 reversed) — an
      // unclassifiable save is rejected, never persisted under a catch-all.
      let classification: ClassifierOutput | null = null;
      try {
        classification = await classifyObject(rawData, input.typeHint);
      } catch (err) {
        // Memory-concept saves MUST fail closed with their own envelope error
        // (cinatra#1376). A memory-declared save never actually reaches here —
        // the static fast-path can't throw and a missing registration already
        // threw in the pre-classification guard above — but re-throw to keep the
        // invariant explicit and robust to future fast-path changes.
        if (input.typeHint === MEMORY_CONCEPT_TYPE_ID) throw err;
        classification = null;
      }

      // 2. Fail-closed decision: the save persists ONLY when it confidently
      // matches a type an installed artifact extension DEFINES. Every other
      // outcome — classifier unavailable, an unmatched/new-type result, a
      // dynamic/tombstoned id, the retired generic type, low confidence, or a
      // resolved type that is not in the live registry — is REFUSED at the write
      // boundary. The refused payload is never persisted (we throw before the
      // upsert); the run's structured error is ordinary run history, not a row.
      // No approval/queue/warning-store/dead-letter path exists.
      //
      // `attemptedType` names the type in the error when the classifier produced
      // a concrete id (even an unmatched/dynamic one) or the caller named a
      // typeHint; null when nothing concrete is knowable.
      const namedTypeHint =
        typeof input.typeHint === "string" && input.typeHint.trim() !== ""
          ? input.typeHint.trim()
          : null;
      const classifiedTypeId =
        classification && !classification.isNewType ? classification.type : null;
      const attemptedType = classifiedTypeId ?? namedTypeHint;

      if (
        classification === null ||
        classification.isNewType ||
        isDynamicObjectTypeId(classification.type) ||
        isTombstonedObjectTypeId(classification.type) ||
        classification.type === GENERIC_OBJECT_TYPE_ID ||
        classification.confidence < 0.4 ||
        // Fail-closed registry check: even a "confident" match must resolve to a
        // type registered by an installed extension — otherwise there is no
        // defining extension and the write is refused.
        !objectTypeRegistry.resolve(classification.type)
      ) {
        refuseUnregisteredWrite(attemptedType);
      }

      // A confident match to an installed, registered type — persist it.
      const confidence = classification.confidence;
      const persistedType = classification.type;
      // `cinatraAgentRunId` is system-managed: injected from run context so
      // registered `identityKey` functions can use it for retry dedup without
      // LLMs passing it explicitly. We do NOT overwrite an explicit value the
      // agent supplied. The enriched data flows through identity resolution and
      // the persisted row, keeping both views consistent.
      const persistedData: Record<string, unknown> =
        actorExt.runId && !("cinatraAgentRunId" in classification.normalizedData)
          ? { ...classification.normalizedData, cinatraAgentRunId: actorExt.runId }
          : { ...classification.normalizedData };

      // 3. Edge-bound object-type serve (cinatra#1392) — resolved on the
      // persisted type. When the caller is edge-bound to a NON-DEFAULT version
      // of the type's owning extension package, that version's retained
      // registration governs this save. Fail-closed: a torn edge-bound retention
      // THROWS rather than persisting against the default version's type.
      const servedObjectType = await resolveEdgeBoundObjectTypeForSave(persistedType);

      // 4. Identity resolution — derive a stable object ID via the registry's
      // layered resolution (external id, then the type's identityKey fn). The
      // stable id is stored in _cinatra.objectId and used as the public API
      // identifier. We do NOT pass it as the Graphiti episode UUID:
      // knowledge-graph-mcp 1.0.x rejects custom UUIDs for new episodes;
      // Graphiti assigns its own and we locate episodes by _cinatra.objectId.
      const identityHash = resolveIdentity(persistedType, persistedData);

      const groupId = resolveGroupId(orgId);
      const objectId = identityHash
        ? identityHashToUuid(identityHash, groupId)
        : randomUUID();

      // --- Explicit binding vs substrate types (cinatra#1377) ---------------
      //
      // Substrate types (catalog / CRM rows) are NEVER project-scoped — the
      // ambient path drops the tag silently through
      // `resolveProjectInheritanceForType` because auto-tagging is an accident
      // of whichever project happened to run the write. An EXPLICIT binding is
      // not an accident, so silently dropping it would lie to the caller about
      // where the row landed. Refuse instead; the substrate rule itself is
      // unchanged and still enforced in the store for both paths.
      if (
        hasExplicitProjectBinding &&
        explicitProjectId !== null &&
        !shouldAutoTagProject(persistedType)
      ) {
        throw new PrimitiveInvocationError({
          code: OBJECTS_SUBSTRATE_TYPE_NOT_PROJECT_SCOPED,
          message: `"${persistedType}" is pan-project substrate and cannot be bound to a project`,
          retryable: false,
          details: { attemptedType: persistedType },
        });
      }

      // The project tag the WRITER will resolve on the ambient path: the frame
      // value run through the same pure helper the store uses, so the collision
      // rule below compares what the write actually does, not what the caller
      // said. `null` on the explicit path — that branch is compared against the
      // caller's own request instead.
      const ambientResolvedProjectId = hasExplicitProjectBinding
        ? null
        : resolveProjectInheritanceForType(probeProjectId, persistedType);

      // --- Collision semantics (cinatra#1377) -------------------------------
      //
      // Identity resolution can steer this save onto an EXISTING row (the
      // upsert's ON CONFLICT arm). That is an update of someone's row, so the
      // create probe above is not sufficient authorization on its own: probe
      // `object.update` against the row as it actually is. The read is org-
      // scoped but deliberately NOT ownership-filtered — a filtered read would
      // return null for a row the caller cannot see and the write would then be
      // authorized as a create against a row that does exist. `enforceResource
      // Access` with a null resource is the 404-hidden envelope, identical to
      // the shape `objects_update` uses, so nothing about the row leaks.
      //
      // A save with no identityKey mints a fresh random id and can never
      // collide, so the probe read is skipped for it.
      //
      // `allowDeleted` is ON: the writer's `ON CONFLICT (id)` arm hits a
      // SOFT-DELETED row too. It does NOT resurrect it — this writer's DO UPDATE
      // arm never clears `deleted_at` (only the canonical twin writer does) — but
      // it DOES rewrite the row's data, bump its version and re-evaluate its
      // `project_id`. Probing without tombstones would read null there, so the
      // write would be authorized as a CREATE against a row that does exist, and
      // an explicit binding could re-tag a tombstone with no move authorization
      // and no audit. Seeing the tombstone is what lets the refusals below fire.
      const existingRow = identityHash
        ? getObjectById(objectId, { orgId }, undefined, { allowDeleted: true })
        : null;
      if (existingRow && !isTrustedDevModelCall) {
        await enforceResourceAccess(
          buildObjectResourceCheck(existingRow),
          request.actor,
          "object.update",
        );
      }
      if (existingRow) {
        // A tombstoned row is refused outright. This writer's `ON CONFLICT` arm
        // would rewrite its data, bump its version and emit the outbox + change
        // events WITHOUT clearing `deleted_at`, so the caller would be told the
        // save succeeded while every ordinary read still cannot see the row —
        // an accept reported over a write that lands nowhere visible. Refuse
        // instead; undeleting is not something `objects_save` does.
        if (existingRow.deletedAt) {
          throw new PrimitiveInvocationError({
            code: OBJECTS_COLLISION_ROW_DELETED,
            message:
              "this save resolves to a deleted object; objects_save does not undelete, so the write would not be visible",
            retryable: false,
            details: { objectId },
          });
        }
        // A collision that REQUESTS a different project than the row already
        // carries is a project MOVE, and a move needs the move path's source-
        // side authorization plus its `resource_project_moves` audit row —
        // neither of which this handler runs. Refuse with the route to take.
        // This covers "bind an ambient row into a project", "rebind to another
        // project" and "explicit null on a project-tagged row" alike; the last
        // one would otherwise be silently swallowed by the writer's
        // `COALESCE(EXCLUDED.project_id, objects.project_id)` preserve arm.
        //
        // An OMITTED projectId requests nothing — but the writer's preserve arm
        // is `COALESCE(EXCLUDED.project_id, objects.project_id)`, so a resolved
        // ambient project does NOT preserve: it overwrites. The ambient half of
        // the rule is below.
        if (
          hasExplicitProjectBinding &&
          explicitProjectId !== (existingRow.projectId ?? null)
        ) {
          throw new PrimitiveInvocationError({
            code: OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED,
            message:
              "this save resolves to an existing object whose project differs from the requested projectId; move it with objects_update (projectId) instead",
            retryable: false,
            details: { objectId },
          });
        }
        // The AMBIENT half. A save with no `projectId`, made inside a frame that
        // resolves to project P, lands on a row already bound to project Q: the
        // COALESCE arm writes P over Q. That takes the row OUT of Q's sealed
        // room — with none of the move path's source-side authorization on Q
        // (which this caller may hold nothing on) and no `resource_project_moves`
        // audit row. Same defect the explicit refusal above prevents, so it gets
        // the same refusal and the same remedy.
        //
        // Deliberately NOT refused: an UNTAGGED row (`project_id` NULL) that
        // inherits the active frame. That is the documented write-time
        // inheritance, and it is purely additive — the row becomes visible in
        // P's project-mode reads and is removed from nobody's, because a NULL
        // tag was never inside any project's room. Only a change that DEPRIVES a
        // project of a row it holds needs the audited move path.
        if (
          !hasExplicitProjectBinding &&
          ambientResolvedProjectId !== null &&
          existingRow.projectId != null &&
          ambientResolvedProjectId !== existingRow.projectId
        ) {
          throw new PrimitiveInvocationError({
            code: OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED,
            message:
              "this save resolves to an existing object bound to a different project than the active project context; move it with objects_update (projectId) instead",
            retryable: false,
            details: { objectId },
          });
        }
        // Ownership/visibility are IMMUTABLE through this writer: the upsert's
        // ON CONFLICT arm does not list owner_level / owner_id / visibility, so
        // an existing row keeps its tuple and a default-scoped (user/private)
        // save can never narrow a wider row. Refuse a request that asks for a
        // DIFFERENT tuple rather than accepting it and silently not applying
        // it — a caller that believes it just widened a row is exactly the
        // false-accept this surface must not produce. Same-value fields, and
        // omitted fields, pass through as the no-ops they are.
        const requestedScopeChange =
          (input.ownerLevel !== undefined &&
            input.ownerLevel !== existingRow.ownerLevel) ||
          (input.ownerId !== undefined && input.ownerId !== existingRow.ownerId) ||
          (input.visibility !== undefined &&
            input.visibility !== existingRow.visibility);
        if (requestedScopeChange) {
          throw new PrimitiveInvocationError({
            code: OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED,
            message:
              "this save resolves to an existing object; objects_save never changes an existing row's ownership or visibility",
            retryable: false,
            details: { objectId },
          });
        }
      }

      // The tuple actually written. On a collision it is the EXISTING row's
      // tuple (the refusal above guarantees the caller asked for nothing else),
      // which states the preserve-the-wider-row intent in the handler instead
      // of leaving it implicit in the writer's ON CONFLICT column list.
      const ownershipForWrite: SaveOwnership = existingRow
        ? {
            ownerLevel: existingRow.ownerLevel,
            ownerId: existingRow.ownerId,
            visibility: existingRow.visibility,
          }
        : ownership;

      // --- Postgres-primary write -------------------------------------------
      // A single atomic call to upsertObjectAndEnqueue inserts or updates the
      // row in cinatra.objects AND emits a graphiti_projection_outbox row in
      // the same transaction. The projector worker (graphiti-projector.ts)
      // picks up the outbox row within ~30 s and appends a new episode in
      // Graphiti. Append-only on update: a re-save calls add_memory only (no
      // deleteEpisode), preserving the bitemporal trail.
      //
      // groupId / identityHashToUuid stay (they mint the object's stable id)
      // but are not passed to Graphiti from this hot path.
      void groupId;

      // Per-claim activation gate (cinatra#1429): reject a NEW write of an
      // invalid payload for an activated (dedicated-claimed + registered-schema)
      // type BEFORE it is persisted. No-op for the generic fallback type (its
      // schema accepts any object) and for unclaimed types.
      await enforceActivatedTypePayload(persistedType, orgId, persistedData);
      // Memory-envelope gate (cinatra#1376): validates the SAME shape that gets
      // stored; a no-op for any non-memory type (including the generic
      // fallback), which passes through untouched.
      const dataForWrite = enforceMemoryConceptEnvelope(
        persistedType,
        persistedData,
      );

      // Draftable lock (cinatra#1449/#1457): reject a content write to a draft
      // that the publication ledger has locked (scheduled/published/failed). A
      // no-op for non-draftable types and for an unlocked draft. The identity-
      // resolved objectId IS the artifact id the ledger keys on; a fresh create
      // (new id) can never be locked, so this only ever bites a re-save of an
      // already-scheduled/published draft.
      await enforceDraftableLock(persistedType, orgId, objectId);

      const record = runGuardedSaveUpsert({
        upsertInput: {
          id: objectId,
          type: persistedType,
          parentId: input.parentId ?? null,
          parentType: null,
          data: dataForWrite,
          createdBy: actorExt.userId,
          orgId,
          source: actorExt.source ?? null,
          runId: actorExt.runId,
          agentId: actorExt.agentId,
          packageVersion: actorExt.packageVersion,
          agentSpecVersion: actorExt.agentSpecVersion,
          // Write the resolved ownership tuple.
          ownerLevel: normalizeOwnerLevel(ownershipForWrite.ownerLevel),
          ownerId: ownershipForWrite.ownerId,
          visibility: ownershipForWrite.visibility,
        },
        operation: "upsert",
        payloadHash: identityHash ?? undefined,
        // Explicit project binding (cinatra#1377). Forwarded ONLY when the
        // caller actually supplied the field: its absence is what tells the
        // writer to fall back to ambient frame inheritance, so spreading an
        // `undefined` key would be indistinguishable but a `null` key would
        // not — pass the key or don't.
        ...(hasExplicitProjectBinding
          ? { explicitProjectBinding: explicitProjectId }
          : {}),
        // Make the collision authorization above BINDING rather than advisory.
        // The probe and this write are separate statements, so without a guard a
        // row inserted (or changed) in between would be written — and, with an
        // explicit binding, re-tagged — under an authorization that was never
        // evaluated against it. The guard pins the writer's DO UPDATE arm to the
        // exact row state the probe authorized; anything else refuses.
        collisionGuard: {
          expectedVersion: existingRow?.version ?? null,
          expectedProjectId: existingRow?.projectId ?? null,
        },
      });

      // version === 1 means the INSERT path executed; version > 1 means the
      // ON CONFLICT DO UPDATE path executed (existing row was bumped).
      const isNew = record.version === 1;

      return {
        objectId: record.id,
        type: record.type,
        isNew,
        wasMerged: !isNew,
        confidence,
        // Surface the change-set id (create + merge both produce one via the
        // canonical writer) so UI create actions can offer an Undo
        // (MutationResult).
        changeSetId: record.changeSetId,
        // Conditionally surface the edge-bound served object-type version
        // (cinatra#1392) — present ONLY when a NON-DEFAULT version's retained
        // type governed this save, so a default (non-edge-bound) caller's
        // response shape stays byte-identical.
        ...(servedObjectType ? { objectTypeServedVersion: servedObjectType.version } : {}),
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
      // is stamped by this package's MCP registry for the transport-resolved
      // identity pair (packages/objects/src/mcp/registry.ts) and by
      // `actorContextToObjectsEnvelope` for the in-process session client, and
      // is read here via the ActorContext-shaped fields stamped on
      // `request.actor`. An unresolved axis is NO grants. Platform admins
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

      // Actor-scoped ownership filter (cinatra#1428): the same SQL filter the
      // artifact read surface splices; the kernel post-filter below stays as
      // the role-permission axis. Both surfaces now scope reads identically.
      const scopeActor = readScopeActor(request.actor, orgId);

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
      //
      // LOUD-DROP (cinatra#1948 (a)): dropping a row is the intended, silent
      // behaviour for an INTERACTIVE caller (a UI user / an agent simply cannot
      // see some rows). For an INTERNAL / SYSTEM read a drop means the internal
      // read authority was mis-scoped — the read returns `[]` indistinguishable
      // from "no rows", which is exactly what let the #1946 send-routing defect
      // (a role-less `System` actor denied `object.read`) hide across several
      // verification rounds. So when this filter drops rows for an
      // internal/system read (`isInternalSystemRead`), we surface a structured
      // warn + a metric instead of staying silent. Interactive reads are
      // unaffected (the predicate is false for them).
      const filterByAuthz = async (
        rows: ObjectRecord[],
      ): Promise<ObjectRecord[]> => {
        const out: ObjectRecord[] = [];
        const droppedTypes = new Set<string>();
        for (const r of rows) {
          try {
            await enforceResourceAccess(
              buildObjectResourceCheck(r),
              request.actor,
              "object.read",
            );
            out.push(r);
          } catch (err) {
            if (err instanceof AuthzError) {
              droppedTypes.add(r.type);
              continue;
            }
            throw err;
          }
        }
        const droppedCount = rows.length - out.length;
        if (droppedCount > 0 && isInternalSystemRead(request.actor)) {
          recordInternalReadAuthzDrop({
            primitive: "objects_list",
            droppedCount,
            totalCount: rows.length,
            droppedTypes: Array.from(droppedTypes),
            actorType: (request.actor.actorType as string | null | undefined) ?? null,
            source: (request.actor.source as string | null | undefined) ?? null,
            orgId,
          });
        }
        return out;
      };

      // -----------------------------------------------------------------
      // No query: Postgres-only listing — type / runId / org filtered in SQL.
      // -----------------------------------------------------------------
      if (!hasQuery) {
        const rows = listObjectsByFilter(
          {
            orgId,
            type: input.type,
            runId: input.runId,
            // cinatra#1456: indexed data.* correlation filter (thread/campaign/
            // contact seam). Pushed into SQL; per-row object.read still gates below.
            dataEquals: input.dataEquals,
            limit: input.limit,
            // Pass projectId straight through; the store appends
            // `AND project_id = $projectId` when the per-table feature flag is
            // ON (default).
            projectId,
          },
          scopeActor,
        );
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

      // Scope-recall lane entitlement (cinatra#1379 memory AC4, generalized to
      // artifact rows in cinatra#1436 AC3). LANE-ELIGIBLE rows — memory concepts
      // and artifact-scoped rows (the generic artifact type OR a claimed type
      // resolving to an artifact-safe / faceted disposition) — project into
      // NESTED per-scope lanes (user / team / ambient, optionally
      // project-suffixed), so a recall over the ambient org lane alone would
      // miss the caller's own user-lane and team-lane rows. For a lane-eligible
      // query we pass the actor's SERVER-DERIVED entitled lane set — own user
      // lane + a lane for every team the actor is a member of + the org lane,
      // each also in its `-proj-<id>` form when a projectId is in the call
      // context. A lane the actor is not entitled to is never in the set, so an
      // unentitled team's / project's rows can never surface. Every other type
      // keeps the single ambient org lane (unchanged). The lane set is relevance
      // scoping only: each candidate is still re-fetched + object.read-gated.
      let searchGroupIds: string[] = [groupId];
      const wantsEntitledLanes =
        input.type != null &&
        orgId != null &&
        (input.type === MEMORY_CONCEPT_TYPE_ID || isArtifactScopedRecallType(input.type));
      if (wantsEntitledLanes) {
        const actorUserId = actorExt.userId;
        let teamIds: string[] = [];
        if (actorUserId && orgId) {
          const teams = await readTeamsForUser(actorUserId, orgId);
          teamIds = teams.map((t) => t.id);
        }
        searchGroupIds = deriveEntitledLanes({
          orgId,
          userId: actorUserId,
          teamIds,
          projectId,
        });
      }

      let objectIds: string[] | null = null;
      let degraded = false;
      try {
        const res = await searchNodes({
          query: input.query!,
          group_ids: searchGroupIds,
          max_nodes: input.limit ?? 50,
        });
        objectIds = resolveObjectIds(res.nodes, orgId);
      } catch (err) {
        console.warn(
          "[objects_list] searchNodes failed; falling back to Postgres-only filter:",
          err,
        );
        degraded = true;
      }

      if (degraded || objectIds === null || objectIds.length === 0) {
        const rows = listObjectsByFilter(
          {
            orgId,
            type: input.type,
            runId: input.runId,
            dataEquals: input.dataEquals, // cinatra#1456 (Graphiti-fallback path)
            limit: input.limit,
            // Sealed-room filter applies on the Graphiti-fallback path too. The
            // user supplied a projectId; the result must stay inside the project
            // regardless of search path.
            projectId,
          },
          scopeActor,
        );
        const visible = await filterByAuthz(rows);
        const items = applyCategoryFilter(visible.map(mapRowToObject));
        // Distinguish "Graphiti unavailable" from "Graphiti responded, and
        // none of its ranked nodes named a row we hold".
        //
        // Since cinatra#2591 that second state means something much sharper
        // than it used to. Recovery no longer depends on the extraction model
        // emitting an id: every projected row is seeded as a deterministic
        // anchor node and resolved through `objects.graphiti_anchor_node_uuid`.
        // So `no_ids_extracted` now says the hits were genuinely other nodes
        // (extracted entities from some row's episode, another tenant's lane
        // filtered out, or rows projected before the anchor existed) — not that
        // the id field path is broken. It stays classified as DEGRADATION
        // rather than an empty search result, which is the contract
        // cinatra#1380's `memory_recall` depends on.
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
      const rows = listObjectsByFilter(
        {
          orgId,
          ids: objectIds,
          type: input.type,
          runId: input.runId,
          dataEquals: input.dataEquals, // cinatra#1456 (Graphiti-ranked path)
          projectId,
        },
        scopeActor,
      );
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
      // The actor-scoped ownership filter (cinatra#1428) additionally hides
      // rows outside the actor's ownership/visibility reach — the same data
      // layer the artifact read surface uses.
      const row = getObjectById(
        input.objectId,
        { orgId },
        readScopeActor(request.actor, orgId),
      );

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
      // Per-claim activation gate (cinatra#1429): an update is also a NEW write
      // of a payload for the row's (possibly activated) type. Compute the merged
      // payload and reject an invalid one for a dedicated-claimed +
      // registered-schema type BEFORE ANY commit — so the project-move below
      // cannot commit ahead of a data rejection (codex Q3). Skipped for a
      // move-only update (input.data undefined). The type is fixed to the
      // existing row's type.
      const incomingData =
        (input.data as Record<string, unknown> | undefined) ?? {};
      let mergedData: Record<string, unknown> = {
        ...((existing.data as Record<string, unknown> | null) ?? {}),
        ...incomingData,
      };
      if (input.data !== undefined) {
        await enforceActivatedTypePayload(existing.type, orgId, mergedData);
        // Draftable lock (cinatra#1449/#1457): a content edit is the primary way
        // to mutate a locked draft, so reject it here BEFORE any commit (ahead of
        // the project-move branch, mirroring the activation gate's ordering
        // rationale) when the ledger holds a locking operation. A no-op for
        // non-draftable types and unlocked drafts. A move-only update (input.data
        // undefined) is metadata, not a content revision — never gated here.
        await enforceDraftableLock(existing.type, orgId, existing.id);
        // Memory-envelope gate (cinatra#1376): a partial update of a memory
        // row must still yield a VALID merged envelope — rejected before any
        // commit (ahead of the project-move branch below, mirroring the
        // activation gate's ordering rationale). The gate returns the data to
        // persist (`okfVersion` default materialized when absent).
        mergedData = enforceMemoryConceptEnvelope(existing.type, mergedData);
      }

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
        // Org-write kernel guard (cinatra#1939 wave 3 Stage D): the move is a
        // content.write on this object's org — the SAME `orgId` this handler
        // already scoped the read/authz on above. A frame lacking the
        // transport-minted authority fails closed rather than moving unguarded.
        if (!orgId) {
          throw new Error(
            "objects_update project move requires an authenticated org context (actor.orgId is null)",
          );
        }
        const moveAuthority = (request.actor as { orgWriteAuthority?: OrgWriteAuthority })
          .orgWriteAuthority;
        if (!moveAuthority) {
          throw new Error(
            "objects_update project move requires an org-write authority on the request frame",
          );
        }
        runResourceProjectMove({
          table: "objects",
          resourceId: existing.id,
          resourceKind: "object",
          oldProjectId: existing.projectId ?? null,
          newProjectId,
          actorId: userId,
          sourceRunId: actorExt.runId ?? existing.runId ?? null,
          reason: input.reason ?? null,
          orgId,
          authority: moveAuthority,
        });
        // If the caller ONLY requested a project move (no data), return
        // early — no need to run the data upsert path.
        if (input.data === undefined) {
          return { ok: true as const };
        }
      }

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

      const classification = await classifyObject(rawData, input.typeHint);
      return classification; // dry-run — NO Graphiti write
    },

    "objects_types_list": async (_request: PrimitiveInvocationRequest<unknown>) => {
      const staticTypes = objectTypeRegistry.list().map((t) => ({
        type: t.type,
        category: t.category,
        description: `Registered type with identityKey=${t.identityKey ? "yes" : "no"}`,
        identityKey: t.identityKey ? "fn" : undefined,
      }));

      // Edge-bound object-type serve (cinatra#1392) — type DISCOVERY. When the
      // caller is edge-bound to a NON-DEFAULT version of an object-type-
      // registering package, list THAT version's retained types for the package
      // instead of the default's. Absent seam / no pins ⇒ byte-identical default
      // listing. A torn retained lookup keeps the default listing for that
      // package (a note is recorded serve-side) — the write path (objects_save)
      // is where fail-closed enforcement bites, mirroring the S8 tool-discovery
      // union that keeps default names advertised on a torn lookup.
      const servePort = readObjectTypeServePort();
      if (!servePort) return { types: staticTypes };
      const { substitutions } = await servePort.planListing();
      if (substitutions.length === 0) return { types: staticTypes };

      // Suppress the DEFAULT-registered types of every pinned package (by
      // registration provenance) and append the pinned versions' retained types.
      const suppressedTypeIds = new Set<string>();
      for (const sub of substitutions) {
        for (const typeId of objectTypeRegistry.getTypesForPackage(sub.packageName)) {
          suppressedTypeIds.add(typeId);
        }
      }
      const baseStatic = staticTypes.filter((t) => !suppressedTypeIds.has(t.type));
      const servedTypes = substitutions.flatMap((sub) =>
        sub.retainedTypes.map((d) => ({
          type: String(d.typeId),
          category:
            (d.category as string | undefined) ??
            (d.inferredCategory as string | undefined) ??
            null,
          description: `Edge-bound served from ${sub.packageName}@${sub.version}`,
          identityKey: d.identityKey ? "fn" : undefined,
        })),
      );
      return { types: [...baseStatic, ...servedTypes] };
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

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
  kernelActorForRead,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import type { ActorContext } from "@/lib/authz/actor-context";
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

/**
 * The retired generic host object type. Under the dependency model it is dead
 * in every form: no save may ever land here again (the #1792 purge removes the
 * historical rows). Kept as a literal on purpose (same route-graph-budget
 * reasoning as MEMORY_CONCEPT_TYPE_ID above) so the fail-closed guard can
 * reject it by id without importing the register-types module.
 */
const GENERIC_OBJECT_TYPE_ID = "@cinatra-ai/objects:object" as const;

/** Stable machine-readable code for the fail-closed write rejection. Surfaced
 *  on the run's tool result via PrimitiveInvocationError.code — bump/extend the
 *  code set only with a documented contract change (packages/objects/AGENTS.md). */
const OBJECTS_TYPE_NOT_REGISTERED = "OBJECTS_TYPE_NOT_REGISTERED" as const;

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
      const classificationModel = readObjectsClassificationModelFromDatabase();
      let classification: ClassifierOutput | null = null;
      try {
        classification = await classifyObject(rawData, input.typeHint, { model: classificationModel });
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

      const record = upsertObjectAndEnqueue({
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
        const rows = listObjectsByFilter(
          {
            orgId,
            type: input.type,
            runId: input.runId,
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
        objectIds = extractObjectIds(res.nodes);
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
      const rows = listObjectsByFilter(
        {
          orgId,
          ids: objectIds,
          type: input.type,
          runId: input.runId,
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

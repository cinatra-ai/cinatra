/**
 * Explicit project binding + ownership for external memory writers
 * (cinatra#1377, epic #1373).
 *
 * `objects_save` accepts an optional `projectId` so a caller with NO ambient
 * `projectContext` frame (a coding agent's `memory` CLI, reaching the primitive
 * over the authenticated MCP transport) can name the target project. Every
 * assertion here is about the AUTHORIZATION seam, on both sides:
 *
 *   AC1  precedence — omitted / explicit null / explicit id — plus the refusal
 *        of a binding the caller cannot satisfy (no grant, read-only grant,
 *        archived project), with nothing leaked on the refusal path;
 *   AC2  the ownership + project fields flow end-to-end through the in-process
 *        deterministic client, which is NOT a privileged path;
 *   AC3  collision semantics — update authorization against the EXISTING row,
 *        wider scope preserved, a differing projectId routed to the move path;
 *   AC4  the explicit path never consults the ambient frame.
 *
 * The project gates are exercised for REAL: `assertProjectReadAccess` resolves
 * to the real `@/lib/sealed-room` source through the package vitest alias, and
 * `assertProjectWritable` is the real implementation with only its row reader
 * injected (the module's own `deps.readProjectRow` seam) so no Postgres is
 * needed. The stubbed alias would have no-opped both, which would have made
 * every refusal assertion vacuous.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";

vi.mock("server-only", () => ({}));

// --- store seam -------------------------------------------------------------

type UpsertCall = {
  ownerLevel: string;
  ownerId: string;
  visibility: string;
  explicitProjectBinding: string | null | undefined;
  hasExplicitKey: boolean;
  collisionGuard: { expectedVersion: number | null; expectedProjectId: string | null } | undefined;
};
const upsertCalls: UpsertCall[] = [];
/** When set, the writer mock throws it — used to drive the guard-refusal path. */
let upsertThrows: Error | null = null;
/** Rows the collision probe finds, keyed by object id. */
const existingRows = new Map<string, Record<string, unknown>>();
const getObjectByIdCalls: Array<{
  id: string;
  scope: { orgId: string | null };
  options: { allowDeleted?: boolean } | undefined;
}> = [];

vi.mock("@/lib/objects-store", () => ({
  upsertObjectAndEnqueue: vi.fn(
    (input: {
      upsertInput: Record<string, unknown>;
      explicitProjectBinding?: string | null;
      collisionGuard?: { expectedVersion: number | null; expectedProjectId: string | null };
    }) => {
      if (upsertThrows) throw upsertThrows;
      upsertCalls.push({
        ownerLevel: input.upsertInput.ownerLevel as string,
        ownerId: input.upsertInput.ownerId as string,
        visibility: input.upsertInput.visibility as string,
        explicitProjectBinding: input.explicitProjectBinding,
        hasExplicitKey: "explicitProjectBinding" in input,
        collisionGuard: input.collisionGuard,
      });
      return { ...input.upsertInput, id: "new-id", version: 1, changeSetId: "cs-1" };
    },
  ),
  getObjectById: vi.fn(
    (
      id: string,
      scope: { orgId: string | null },
      _actor: unknown,
      options?: { allowDeleted?: boolean },
    ) => {
      getObjectByIdCalls.push({ id, scope, options });
      return existingRows.get(id) ?? null;
    },
  ),
  listObjectsByFilter: vi.fn(() => []),
  softDeleteObject: vi.fn(),
}));

// --- ambient frame ----------------------------------------------------------
//
// `frameStore` stands in for the AsyncLocalStorage request frame. AC4 turns on
// being able to EMPTY it: `getStore()` returns undefined when `frameEmpty` is
// set, which is exactly the external-caller shape (no run, no frame at all).

let frameEmpty = true;
const frameStore: { projectContext?: { projectId: string | null } } = {};
/** A frame pushed by `mcpRequestContextStorage.run(...)` — the shape the real
 *  MCP transport hands the registry. Wins over `frameStore` while it is set. */
let runFrame: Record<string, unknown> | undefined;
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    getStore: () => runFrame ?? (frameEmpty ? undefined : frameStore),
    run: async (store: Record<string, unknown>, fn: () => Promise<unknown>) => {
      const previous = runFrame;
      runFrame = store;
      try {
        return await fn();
      } finally {
        runFrame = previous;
      }
    },
  },
}));

// --- the canonical grant assembly the registry resolves the actor's axis from -
//
// Captured so the identity-coherence assertion can check WHICH pair the
// registry asked about; the returned grants stand in for the caller's real
// project axis.

const grantResolverCalls: Array<{ userId: string; orgId: string }> = [];
let resolvedGrants: Array<{ projectId: string; effectiveRole: string; accessSource: string }> = [];
vi.mock("@/lib/auth-session", () => ({
  resolveActorGrantsForUserInOrg: async (userId: string, orgId: string) => {
    grantResolverCalls.push({ userId, orgId });
    return { projectGrants: resolvedGrants, teamIds: [] };
  },
}));

// --- classifier / identity --------------------------------------------------

const SUBSTRATE_TYPE = "@cinatra-ai/entity-contacts:contact";
const PROJECTABLE_TYPE = "@cinatra-ai/memory:concept-binding-fixture";
let classifiedType = PROJECTABLE_TYPE;

vi.mock("../../classifier", () => ({
  classifyObject: vi.fn(async () => ({
    type: classifiedType,
    confidence: 0.9,
    isNewType: false,
    normalizedData: { name: "x" },
    inferredTypeName: null,
    inferredCategory: null,
    canonicalKeys: null,
  })),
}));

vi.mock("../../graphiti-client", () => ({
  searchNodes: vi.fn(async () => ({ nodes: [] })),
  identityHashToUuid: (h: string) => `obj-${h}`,
}));

/** null → a fresh random id (no collision possible); a string → a stable id. */
let identityHash: string | null = null;
vi.mock("../../identity", () => ({
  resolveIdentity: vi.fn(() => identityHash),
  hashIdentity: vi.fn(() => "h"),
}));

// Lazy-imported app-layer gates (no-ops for this handler-focused suite).
vi.mock("@/lib/objects/claim-activation-gate", () => ({
  assertActivatedTypePayloadValid: () => {},
  typeHasActiveDedicatedClaim: async () => false,
}));
vi.mock("@/lib/objects/draftable-lock-gate", () => ({
  assertDraftableWriteAllowed: async () => {},
}));

// --- authorization probes ---------------------------------------------------
//
// Captured, always allowed: the kernel decision is not what this suite is
// about — the project gates below are. The `object.update` collision probe is
// asserted on by ACTION and by the resource it carries.

type Probe = {
  action: string;
  resourceId: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null | undefined;
};
const probes: Probe[] = [];
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: vi.fn(
    async (resource: Record<string, unknown> | null, _actor: unknown, action: string) => {
      probes.push({
        action,
        resourceId: (resource?.resourceId as string) ?? null,
        ownerLevel: (resource?.ownerLevel as string) ?? null,
        ownerId: (resource?.ownerId as string) ?? null,
        visibility: (resource?.visibility as string) ?? null,
        projectId: resource?.projectId as string | null | undefined,
      });
    },
  ),
  kernelActorForRead: vi.fn(() => ({})),
}));

// --- the REAL project write gate, with only its row reader injected ---------

const PROJECT_ROWS = new Map<string, { id: string; archivedAt: Date | null }>([
  ["prj-open", { id: "prj-open", archivedAt: null }],
  ["prj-readonly", { id: "prj-readonly", archivedAt: null }],
  ["prj-archived", { id: "prj-archived", archivedAt: new Date("2026-01-01") }],
  // Exists, but the caller below holds no grant on it: the gate must still
  // 404-hide, never confirm existence.
  ["prj-foreign", { id: "prj-foreign", archivedAt: null }],
]);

vi.mock("@/lib/project-writable", async () => {
  const real = (await vi.importActual(
    "../../../../../src/lib/project-writable",
  )) as typeof import("../../../../../src/lib/project-writable");
  return {
    ...real,
    assertProjectWritable: (
      actor: Parameters<typeof real.assertProjectWritable>[0],
      projectId: string,
      mode: "read" | "write" | "admin",
    ) =>
      real.assertProjectWritable(actor, projectId, mode, {
        readProjectRow: async (id: string) => PROJECT_ROWS.get(id) ?? null,
      }),
    assertProjectWritableSync: () => {},
  };
});

import { handlers } from "../handlers";
import { registerObjectsPrimitives } from "../registry";
import { objectTypeRegistry } from "../../registry";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { createDeterministicObjectsClient } from "../client/deterministic-client";

objectTypeRegistry.register(
  { type: PROJECTABLE_TYPE, category: "record", description: "Binding fixture" } as never,
  "@cinatra-ai/memory",
);
objectTypeRegistry.register(
  { type: SUBSTRATE_TYPE, category: "record", description: "Contact" } as never,
  "@cinatra-ai/entity-contacts",
);

const ORG = "org-1";

/** The external CLI caller: a real user, write on prj-open, read on prj-readonly
 *  and prj-archived, and NO grant at all on prj-foreign. */
const CLI_ACTOR = {
  actorType: "user",
  source: "cli",
  ...({
    orgId: ORG,
    userId: "usr-1",
    projectGrants: [
      { projectId: "prj-open", effectiveRole: "write" },
      { projectId: "prj-readonly", effectiveRole: "read" },
      { projectId: "prj-archived", effectiveRole: "write" },
    ],
  } as unknown as Record<string, unknown>),
} as never;

function save(input: Record<string, unknown>, actor: unknown = CLI_ACTOR) {
  return handlers["objects_save"]({
    primitiveName: "objects_save",
    input: { rawData: { name: "x" }, typeHint: classifiedType, ...input },
    actor: actor as never,
    mode: "agentic",
  } as never);
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "obj-stable",
    type: PROJECTABLE_TYPE,
    parentId: null,
    parentType: null,
    data: { name: "x" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdBy: "usr-other",
    orgId: ORG,
    source: null,
    runId: null,
    agentId: null,
    packageVersion: null,
    agentSpecVersion: null,
    version: 3,
    deletedAt: null,
    ownerLevel: "organization",
    ownerId: ORG,
    visibility: "organization",
    projectId: null,
    ...overrides,
  };
}

/** Run `fn` and return the thrown error (fails the test if nothing throws). */
async function captureThrow(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the save to be refused, but it resolved");
}

beforeEach(() => {
  upsertCalls.length = 0;
  upsertThrows = null;
  probes.length = 0;
  getObjectByIdCalls.length = 0;
  existingRows.clear();
  delete frameStore.projectContext;
  frameEmpty = true;
  runFrame = undefined;
  grantResolverCalls.length = 0;
  resolvedGrants = [];
  classifiedType = PROJECTABLE_TYPE;
  identityHash = null;
  (upsertObjectAndEnqueue as unknown as ReturnType<typeof vi.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// AC1 — precedence
// ---------------------------------------------------------------------------

describe("objects_save projectId precedence (cinatra#1377 AC1)", () => {
  it("explicit id: an authorized caller binds the row, and the create probe carries it", async () => {
    await save({ projectId: "prj-open" });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(true);
    expect(upsertCalls[0].explicitProjectBinding).toBe("prj-open");
    const createProbe = probes.find((p) => p.action === "object.create");
    expect(createProbe?.projectId).toBe("prj-open");
  });

  it("omitted: ambient inheritance is unchanged — no explicit binding reaches the writer", async () => {
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-ambient" };

    await save({});

    expect(upsertCalls).toHaveLength(1);
    // The key is ABSENT: its absence is what tells the writer to inherit.
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
    const createProbe = probes.find((p) => p.action === "object.create");
    expect(createProbe?.projectId).toBe("prj-ambient");
  });

  it("explicit null: a substrate write that bypasses an active ambient frame", async () => {
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-ambient" };

    await save({ projectId: null });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(true);
    expect(upsertCalls[0].explicitProjectBinding).toBeNull();
    const createProbe = probes.find((p) => p.action === "object.create");
    expect(createProbe?.projectId).toBeNull();
  });
});

describe("objects_save projectId authorization (cinatra#1377 AC1, refuse side)", () => {
  it("no grant on an EXISTING project: 404-hidden, nothing persisted, nothing leaked", async () => {
    const err = (await captureThrow(() => save({ projectId: "prj-foreign" }))) as Error & {
      statusCode?: number;
      reason?: string;
    };

    expect(err.statusCode).toBe(404);
    expect(err.reason).toBe("hidden");
    // The refusal must not confirm that prj-foreign exists, name its archive
    // state, or echo the requested id back — a caller with no grant learns
    // exactly what it would learn about a project that does not exist.
    expect(err.message).toBe("Project not found");
    expect(err.message).not.toContain("prj-foreign");
    expect(upsertCalls).toHaveLength(0);
  });

  it("no grant on a NON-EXISTENT project: the same 404-hidden envelope (no existence oracle)", async () => {
    const err = (await captureThrow(() => save({ projectId: "prj-nope" }))) as Error & {
      statusCode?: number;
    };

    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Project not found");
    expect(upsertCalls).toHaveLength(0);
  });

  it("read-only grant: refused for want of the write tier, nothing persisted", async () => {
    const err = (await captureThrow(() => save({ projectId: "prj-readonly" }))) as Error & {
      statusCode?: number;
      reason?: string;
    };

    expect(err.statusCode).toBe(403);
    expect(err.reason).toBe("forbidden");
    expect(upsertCalls).toHaveLength(0);
  });

  it("archived project: refused even with a write grant, nothing persisted", async () => {
    const err = (await captureThrow(() => save({ projectId: "prj-archived" }))) as Error & {
      statusCode?: number;
    };

    expect(err.statusCode).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  it("an unresolved projectGrants axis is treated as NO grants (fail closed)", async () => {
    const legacyActor = {
      actorType: "user",
      source: "cli",
      ...({ orgId: ORG, userId: "usr-legacy" } as unknown as Record<string, unknown>),
    };

    const err = (await captureThrow(() =>
      save({ projectId: "prj-open" }, legacyActor),
    )) as Error & { statusCode?: number };

    expect(err.statusCode).toBe(404);
    expect(upsertCalls).toHaveLength(0);
  });

  it("a blank projectId is a schema error, never silently read as ambient", async () => {
    await expect(save({ projectId: "" })).rejects.toThrow();
    expect(upsertCalls).toHaveLength(0);
  });

  it("a substrate type cannot be bound to a project — refused, not silently dropped", async () => {
    classifiedType = SUBSTRATE_TYPE;

    const err = (await captureThrow(() =>
      save({ projectId: "prj-open" }),
    )) as PrimitiveInvocationError;

    expect(err).toBeInstanceOf(PrimitiveInvocationError);
    expect(err.code).toBe("OBJECTS_SUBSTRATE_TYPE_NOT_PROJECT_SCOPED");
    expect(upsertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — end-to-end through the deterministic client
// ---------------------------------------------------------------------------

describe("ownership + project flow through the deterministic client (cinatra#1377 AC2)", () => {
  it("save() forwards ownerLevel / ownerId / visibility / projectId to the handler", async () => {
    const client = createDeterministicObjectsClient({ actor: CLI_ACTOR });

    await client.save({
      rawData: { name: "x" },
      typeHint: PROJECTABLE_TYPE,
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "organization",
      projectId: "prj-open",
    });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "organization",
      explicitProjectBinding: "prj-open",
    });
  });

  it("the in-process client is not a privileged path — the same binding is refused", async () => {
    const client = createDeterministicObjectsClient({ actor: CLI_ACTOR });

    await expect(
      client.save({
        rawData: { name: "x" },
        typeHint: PROJECTABLE_TYPE,
        projectId: "prj-readonly",
      }),
    ).rejects.toThrow();
    expect(upsertCalls).toHaveLength(0);
  });

  it("an omitted projectId through the client leaves ambient inheritance intact", async () => {
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-ambient" };
    const client = createDeterministicObjectsClient({ actor: CLI_ACTOR });

    await client.save({ rawData: { name: "x" }, typeHint: PROJECTABLE_TYPE });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — collision semantics
// ---------------------------------------------------------------------------

describe("objects_save collision semantics (cinatra#1377 AC3)", () => {
  beforeEach(() => {
    identityHash = "stable";
  });

  it("a collision is authorized as an UPDATE against the existing row, not only as a create", async () => {
    existingRows.set("obj-stable", makeRow());

    await save({});

    expect(getObjectByIdCalls).toHaveLength(1);
    expect(getObjectByIdCalls[0].id).toBe("obj-stable");
    expect(getObjectByIdCalls[0].scope).toEqual({ orgId: ORG });
    const updateProbe = probes.find((p) => p.action === "object.update");
    expect(updateProbe).toBeDefined();
    // The probe carries the row AS STORED — an org-wide row owned by someone
    // else — not the caller's user/private create defaults.
    expect(updateProbe).toMatchObject({
      resourceId: "obj-stable",
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "organization",
    });
  });

  it("a default-scoped save never narrows a wider existing row", async () => {
    existingRows.set("obj-stable", makeRow());

    // No ownership inputs at all: the caller is a user, so the create defaults
    // are user/private. The write must still carry the row's wider tuple.
    await save({});

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "organization",
    });
  });

  it("a collision requesting a DIFFERENT projectId is refused and routed to the move path", async () => {
    existingRows.set("obj-stable", makeRow({ projectId: "prj-other" }));

    const err = (await captureThrow(() =>
      save({ projectId: "prj-open" }),
    )) as PrimitiveInvocationError;

    expect(err).toBeInstanceOf(PrimitiveInvocationError);
    expect(err.code).toBe("OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED");
    expect(err.message).toContain("objects_update");
    expect(err.retryable).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  it("an explicit null on a project-tagged row is a move too — refused, not swallowed", async () => {
    existingRows.set("obj-stable", makeRow({ projectId: "prj-open" }));

    const err = (await captureThrow(() =>
      save({ projectId: null }),
    )) as PrimitiveInvocationError;

    expect(err.code).toBe("OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED");
    expect(upsertCalls).toHaveLength(0);
  });

  it("a collision requesting the SAME projectId is a no-op and proceeds", async () => {
    existingRows.set("obj-stable", makeRow({ projectId: "prj-open" }));

    await save({ projectId: "prj-open" });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].explicitProjectBinding).toBe("prj-open");
  });

  it("an OMITTED projectId with NO active frame preserves the row's tag", async () => {
    existingRows.set("obj-stable", makeRow({ projectId: "prj-other" }));

    // No frame → the writer resolves NULL → its COALESCE arm preserves the
    // row's project. Nothing changes, so nothing is refused.
    await save({});

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
  });

  it("an ambient frame naming a DIFFERENT project than the row is refused — the retag is a move", async () => {
    // The writer's `COALESCE(EXCLUDED.project_id, objects.project_id)` arm
    // writes the frame's project OVER the row's, which takes the row out of
    // prj-other's sealed room with no authorization on prj-other and no
    // `resource_project_moves` audit row.
    existingRows.set("obj-stable", makeRow({ projectId: "prj-other" }));
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-open" };

    const err = (await captureThrow(() => save({}))) as PrimitiveInvocationError;

    expect(err).toBeInstanceOf(PrimitiveInvocationError);
    expect(err.code).toBe("OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED");
    expect(err.message).toContain("objects_update");
    expect(err.retryable).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  it("an ambient frame naming the row's OWN project changes nothing and proceeds", async () => {
    existingRows.set("obj-stable", makeRow({ projectId: "prj-open" }));
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-open" };

    await save({});

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
  });

  it("an UNTAGGED row still inherits the active frame — inheritance is additive, not a move", async () => {
    existingRows.set("obj-stable", makeRow({ projectId: null }));
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-open" };

    await save({});

    // A NULL tag was inside no project's room, so tagging it deprives nobody.
    // This is the documented write-time inheritance and stays allowed.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
  });

  it("a SUBSTRATE type resolves to no tag, so an ambient frame cannot retag its row", async () => {
    classifiedType = SUBSTRATE_TYPE;
    existingRows.set("obj-stable", makeRow({ projectId: "prj-other" }));
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-open" };

    // The handler compares what the WRITE resolves to, and the writer runs the
    // frame through the same substrate filter — which drops it. Nothing is
    // retagged, so nothing is refused.
    await save({});

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
  });

  it("a collision requesting a different visibility is refused, not silently dropped", async () => {
    existingRows.set("obj-stable", makeRow());

    const err = (await captureThrow(() =>
      save({ visibility: "private" }),
    )) as PrimitiveInvocationError;

    expect(err.code).toBe("OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED");
    expect(upsertCalls).toHaveLength(0);
  });

  it("a collision restating the row's OWN tuple is a no-op and proceeds", async () => {
    existingRows.set("obj-stable", makeRow());

    await save({ ownerLevel: "organization", ownerId: ORG, visibility: "organization" });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ visibility: "organization" });
  });

  it("the collision probe INCLUDES soft-deleted rows, and a tombstone collision is refused", async () => {
    // Without `allowDeleted` a tombstoned row reads as null, so the write would
    // be authorized as a CREATE against a row that does exist and an explicit
    // binding could re-tag the tombstone with no move authorization and no audit
    // row. The probe must see it — and then refuse, because this writer's
    // ON CONFLICT arm never clears `deleted_at`: it would rewrite the row and
    // report success while every ordinary read still cannot see it.
    existingRows.set("obj-stable", makeRow({ deletedAt: "2026-02-01T00:00:00Z" }));

    const err = (await captureThrow(() =>
      save({ projectId: null }),
    )) as PrimitiveInvocationError;

    expect(err.code).toBe("OBJECTS_COLLISION_ROW_DELETED");
    expect(err.retryable).toBe(false);
    expect(getObjectByIdCalls[0].options).toEqual({ allowDeleted: true });
    expect(upsertCalls).toHaveLength(0);
  });

  it("a tombstone collision is refused on the AMBIENT path too — no silent invisible write", async () => {
    existingRows.set("obj-stable", makeRow({ deletedAt: "2026-02-01T00:00:00Z" }));

    const err = (await captureThrow(() => save({}))) as PrimitiveInvocationError;

    expect(err.code).toBe("OBJECTS_COLLISION_ROW_DELETED");
    expect(upsertCalls).toHaveLength(0);
  });

  it("the tombstone refusal precedes the move refusal — deleted is the more basic fact", async () => {
    existingRows.set(
      "obj-stable",
      makeRow({ deletedAt: "2026-02-01T00:00:00Z", projectId: "prj-other" }),
    );

    const err = (await captureThrow(() =>
      save({ projectId: "prj-open" }),
    )) as PrimitiveInvocationError;

    expect(err.code).toBe("OBJECTS_COLLISION_ROW_DELETED");
    expect(upsertCalls).toHaveLength(0);
  });

  it("a save with no identity key never probes for a collision", async () => {
    identityHash = null;

    await save({});

    expect(getObjectByIdCalls).toHaveLength(0);
    expect(probes.some((p) => p.action === "object.update")).toBe(false);
  });
});

describe("the collision probe is BINDING, not advisory (cinatra#1377 AC3)", () => {
  it("arms the writer's guard with the exact row state the probe authorized", async () => {
    identityHash = "stable";
    existingRows.set("obj-stable", makeRow({ version: 7, projectId: "prj-open" }));

    await save({ projectId: "prj-open" });

    expect(upsertCalls[0].collisionGuard).toEqual({
      expectedVersion: 7,
      expectedProjectId: "prj-open",
    });
  });

  it("arms the guard with a NULL version when the probe found no row — any conflict is a race", async () => {
    identityHash = "stable";

    await save({ projectId: "prj-open" });

    expect(upsertCalls[0].collisionGuard).toEqual({
      expectedVersion: null,
      expectedProjectId: null,
    });
  });

  it("a guard refusal surfaces as a structured, TERMINAL error", async () => {
    identityHash = "stable";
    const refusal = new Error("refused") as Error & { code: string };
    refusal.code = "OBJECTS_WRITE_PRECONDITION_FAILED";
    upsertThrows = refusal;

    const err = (await captureThrow(() =>
      save({ projectId: "prj-open" }),
    )) as PrimitiveInvocationError;

    expect(err).toBeInstanceOf(PrimitiveInvocationError);
    expect(err.code).toBe("OBJECTS_WRITE_PRECONDITION_FAILED");
    // Deliberately NOT retryable: the same empty result is also what a
    // cross-tenant collision produces, and the two are not separable from
    // outside the failed statement. A write whose authorization could not be
    // confirmed must not be auto-retried.
    expect(err.retryable).toBe(false);
    // CAUSE-NEUTRAL: two predicates block the same arm (the collision guard and
    // the cross-tenant org guard) and produce the same empty result, so the
    // message must not assert which one fired. It states only what is certain.
    expect(err.message).toContain("the write precondition failed");
    expect(err.message).toContain("nothing was written");
    expect(err.message).not.toMatch(/changed between/);
    expect(err.message).not.toMatch(/cross-tenant/);
  });

  it("any other writer failure propagates untouched", async () => {
    identityHash = "stable";
    upsertThrows = new Error("pg exploded");

    const err = await captureThrow(() => save({ projectId: "prj-open" }));

    expect(err).not.toBeInstanceOf(PrimitiveInvocationError);
    expect(err.message).toBe("pg exploded");
  });
});

describe("the dev bypass does not open the project gate (cinatra#1377)", () => {
  const prev = process.env.A2A_DEV_BYPASS;
  beforeEach(() => {
    process.env.A2A_DEV_BYPASS = "true";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.A2A_DEV_BYPASS;
    else process.env.A2A_DEV_BYPASS = prev;
  });

  it("a sessionless model caller still cannot bind a project it holds no grant on", async () => {
    // A2A_DEV_BYPASS skips the OBJECT authz probes for a sessionless model
    // caller. The PROJECT gate is deliberately outside that bypass: an explicit
    // binding is a new caller-supplied authorization input, so it is gated
    // unconditionally.
    const sessionlessModel = {
      actorType: "model",
      source: "agent",
      ...({ orgId: ORG } as unknown as Record<string, unknown>),
    };

    const err = (await captureThrow(() =>
      save({ projectId: "prj-foreign" }, sessionlessModel),
    )) as Error & { statusCode?: number };

    expect(err.statusCode).toBe(404);
    expect(upsertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — no ambient-context dependence in the explicit path
// ---------------------------------------------------------------------------

describe("the explicit path is frame-independent (cinatra#1377 AC4)", () => {
  it("binds with an EMPTY request context — the external-caller shape", async () => {
    frameEmpty = true;

    await save({ projectId: "prj-open" });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].explicitProjectBinding).toBe("prj-open");
    expect(probes.find((p) => p.action === "object.create")?.projectId).toBe("prj-open");
  });

  it("an ambient frame cannot bleed into an explicit binding", async () => {
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-ambient" };

    await save({ projectId: "prj-open" });

    expect(upsertCalls[0].explicitProjectBinding).toBe("prj-open");
    expect(probes.find((p) => p.action === "object.create")?.projectId).toBe("prj-open");
  });

  it("an ambient frame cannot resurrect a project on an explicit substrate write", async () => {
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-ambient" };

    await save({ projectId: null });

    expect(upsertCalls[0].explicitProjectBinding).toBeNull();
    expect(probes.find((p) => p.action === "object.create")?.projectId).toBeNull();
  });

  it("an ambient frame naming a project the caller cannot write is NOT gated by the explicit path", async () => {
    // Grounding assertion, not a wish: the explicit gate applies to the
    // EXPLICIT input only. An ambient frame is set by this host inside a run
    // that was already authorized for that project, so widening the gate to it
    // would be a behavior change this issue does not ask for.
    frameEmpty = false;
    frameStore.projectContext = { projectId: "prj-foreign" };

    await save({});

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The actor the MCP REGISTRY builds (cinatra#1377 AC1/AC2 — the named transport)
// ---------------------------------------------------------------------------
//
// Every assertion above drives `handlers.objects_save` with a hand-written
// actor. That proves the gate, not the transport: the gates read
// `actor.projectGrants`, and an actor assembled without that axis is refused
// for every caller that is not a platform admin. These tests therefore drive
// the SAME real handler through `registerObjectsPrimitives`, so the actor under
// test is the one the registry actually assembles from the request frame.

type RegisteredTool = { name: string; handler: (input: unknown) => Promise<unknown> };

function registerPrimitives(): Map<string, RegisteredTool["handler"]> {
  const tools = new Map<string, RegisteredTool["handler"]>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: (input: unknown) => Promise<unknown>) => {
      tools.set(name, handler);
    },
    registerResource: () => {},
    registerPrompt: () => {},
    registerScreen: () => {},
  };
  registerObjectsPrimitives(server as never);
  return tools;
}

/** Call `objects_save` the way the transport does: inside a request frame, with
 *  no actor of our own — the registry builds it. */
async function saveOverTransport(
  input: Record<string, unknown>,
  frame: Record<string, unknown>,
): Promise<unknown> {
  const tools = registerPrimitives();
  const saveTool = tools.get("objects_save");
  if (!saveTool) throw new Error("objects_save was not registered");
  const { mcpRequestContextStorage } = (await import("@cinatra-ai/mcp-server")) as unknown as {
    mcpRequestContextStorage: {
      run: (store: Record<string, unknown>, fn: () => Promise<unknown>) => Promise<unknown>;
    };
  };
  return mcpRequestContextStorage.run(frame, () =>
    saveTool({ rawData: { name: "x" }, typeHint: classifiedType, ...input }),
  );
}

describe("the registry-built actor carries the project axis (cinatra#1377 AC1/AC2)", () => {
  it("a caller holding write on the project binds the row over the MCP transport", async () => {
    resolvedGrants = [
      { projectId: "prj-open", effectiveRole: "write", accessSource: "user" },
    ];

    await saveOverTransport({ projectId: "prj-open" }, { userId: "usr-1", orgId: ORG });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].explicitProjectBinding).toBe("prj-open");
  });

  it("resolves the axis for the frame's OWN identity pair — no other id is consulted", async () => {
    resolvedGrants = [
      { projectId: "prj-open", effectiveRole: "write", accessSource: "user" },
    ];

    await saveOverTransport({ projectId: "prj-open" }, { userId: "usr-1", orgId: ORG });

    expect(grantResolverCalls).toEqual([{ userId: "usr-1", orgId: ORG }]);
  });

  it("a caller holding only READ on the project is refused over the same transport", async () => {
    resolvedGrants = [
      { projectId: "prj-readonly", effectiveRole: "read", accessSource: "user" },
    ];

    const err = await captureThrow(() =>
      saveOverTransport({ projectId: "prj-readonly" }, { userId: "usr-1", orgId: ORG }),
    );

    expect((err as { statusCode?: number }).statusCode).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  it("a caller holding NO grant is 404-hidden, and the project id is not echoed", async () => {
    resolvedGrants = [];

    const err = await captureThrow(() =>
      saveOverTransport({ projectId: "prj-foreign" }, { userId: "usr-1", orgId: ORG }),
    );

    expect((err as { statusCode?: number }).statusCode).toBe(404);
    expect(err.message).toBe("Project not found");
    expect(upsertCalls).toHaveLength(0);
  });

  it("a frame with no user identity resolves no axis at all — fail closed", async () => {
    resolvedGrants = [
      { projectId: "prj-open", effectiveRole: "write", accessSource: "user" },
    ];

    const err = await captureThrow(() =>
      saveOverTransport({ projectId: "prj-open" }, { orgId: ORG }),
    );

    expect((err as { statusCode?: number }).statusCode).toBe(404);
    expect(grantResolverCalls).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("an omitted projectId needs no axis — ambient inheritance is untouched", async () => {
    resolvedGrants = [];

    await saveOverTransport(
      {},
      { userId: "usr-1", orgId: ORG, projectContext: { projectId: "prj-ambient" } },
    );

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].hasExplicitKey).toBe(false);
    expect(probes.find((p) => p.action === "object.create")?.projectId).toBe("prj-ambient");
  });
});

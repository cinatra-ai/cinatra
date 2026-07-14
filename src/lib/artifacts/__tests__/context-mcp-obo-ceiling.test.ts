/**
 * cinatra#1430 follow-up — root-suite (CI gate-of-record) pin for the MCP
 * `context_resolve` OBO-ceiling carry and snapshot-pin pass-through.
 *
 * The end-to-end behavior (an out-of-ceiling org-visible claimed row is
 * excluded AND unminted against a real DB) lives in
 * context-mcp-resolve-capture.integration.test.ts — which the root CI vitest
 * run EXCLUDES (the `*.integration.test.ts` tier; the invariants job has no
 * DB service). Without THIS suite, silently dropping the ceiling carry in
 * `resolveActorAndOrg` would produce zero automated CI signal. With the
 * DB/composition seams mocked, this pins the handler wiring itself:
 *
 *   1. the transport-verified `ctx.oboCeiling` is carried onto the ONE actor
 *      object handed to BOTH `captureSnapshotsForContextSlot` and
 *      `resolveContextSlot` (drop the carry → this fails in CI);
 *   2. narrow-only — an MCP frame without a ceiling (or with `oboCeiling:
 *      null`, the persisted-run idle value) adds NO ceiling key;
 *   3. capture runs BEFORE resolve and `capture.pins` feeds through as
 *      `snapshotPins` (claimed rows resolve only through capture-time pins);
 *   4. fail-closed: no active organization rejects BEFORE any capture work.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

vi.mock("server-only", () => ({}));
// Real AsyncLocalStorage with the identical run/getStore contract (the
// package facade drags the MCP SDK transport graph this suite doesn't use).
vi.mock("@cinatra-ai/mcp-server", async () => {
  const { AsyncLocalStorage: ALS } = await import("node:async_hooks");
  return { mcpRequestContextStorage: new ALS() };
});
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));
vi.mock("@cinatra-ai/objects/registry", () => ({
  objectTypeRegistry: { listArtifacts: () => [] },
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: () => {
    throw new Error("unit suite — no DB access expected on this path");
  },
}));
vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "",
  ensurePostgresSchema: () => {},
  postgresSchema: "public",
}));
vi.mock("../artifact-service", () => ({ getArtifact: () => null }));

const builtActors: Array<Record<string, unknown>> = [];
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: (
    _primitive: unknown,
    organizationId: string,
  ) => {
    const actor = { sub: "user-1430", organizationId };
    builtActors.push(actor);
    return actor;
  },
}));

const captureSnapshotsForContextSlot = vi.fn();
vi.mock("../object-content-snapshot", () => ({
  captureSnapshotsForContextSlot: (...a: unknown[]) =>
    captureSnapshotsForContextSlot(...a),
}));
const resolveContextSlot = vi.fn();
vi.mock("../context-resolver", () => ({
  resolveContextSlot: (...a: unknown[]) => resolveContextSlot(...a),
}));

const { registerContextPrimitives } = await import("../context-mcp");
const { mcpRequestContextStorage } = (await import(
  "@cinatra-ai/mcp-server"
)) as unknown as { mcpRequestContextStorage: AsyncLocalStorage<unknown> };

// -- harness (the authoring-mcp-primitives captureTools pattern) -------------

type Tool = { name: string; handler: (input: unknown) => Promise<unknown> };

function resolveTool(): Tool {
  const tools: Tool[] = [];
  registerContextPrimitives({
    registerTool: (name: string, _meta: unknown, handler: Tool["handler"]) => {
      tools.push({ name, handler });
    },
  } as never);
  const t = tools.find((x) => x.name === "context_resolve");
  if (!t) throw new Error("context_resolve not registered");
  return t;
}

const ORG = "org-1430-unit";
const CEILING = [
  { tier: "organization", id: ORG },
  { tier: "user", id: "delegating-user" },
];
const OAS = {
  metadata: {
    cinatra: {
      contextSlots: [
        {
          slotId: "slot-unit",
          acceptedArtifactExtensions: ["@cinatra-ai/unit-artifact"],
          selectionMode: "autonomous",
          resolutionMode: "accumulate",
        },
      ],
    },
  },
};
const INPUT = {
  parentAgentOas: OAS,
  slotId: "slot-unit",
  projectId: "proj-unit-1430",
};

function callResolve(ctx: Record<string, unknown>): Promise<unknown> {
  const tool = resolveTool();
  return mcpRequestContextStorage.run(ctx, () => tool.handler(INPUT));
}

type CaptureArgs = {
  actor: Record<string, unknown>;
  slot: { slotId: string };
  projectId?: string;
  installedExtensions: unknown[];
};
type ResolverArgs = CaptureArgs & { snapshotPins: unknown };

const PINS = [
  {
    objectId: "obj-1",
    representationRevisionId: "rep-1",
    semanticAssertionId: "sa-1",
  },
];
const REFS = [{ artifactId: "obj-1" }];

/** Actor state RECORDED SYNCHRONOUSLY at the moment capture is invoked —
 * asserting on `cap.actor` after the handler completes would also pass if a
 * regression attached the ceiling BETWEEN capture and resolve (the mock
 * retains the mutable actor reference). */
const actorAtCaptureCall: Array<{
  hasCeilingKey: boolean;
  oboCeiling: unknown;
  organizationId: unknown;
}> = [];

beforeEach(() => {
  vi.clearAllMocks();
  builtActors.length = 0;
  actorAtCaptureCall.length = 0;
  captureSnapshotsForContextSlot.mockImplementation(async (...a: unknown[]) => {
    const { actor } = a[0] as CaptureArgs;
    actorAtCaptureCall.push({
      hasCeilingKey: "oboCeiling" in actor,
      oboCeiling: structuredClone(actor.oboCeiling),
      organizationId: actor.organizationId,
    });
    return { attempted: 1, captured: 1, reused: 0, pins: PINS };
  });
  resolveContextSlot.mockReturnValue(REFS);
});

describe("context_resolve MCP handler — OBO-ceiling carry + pin pass-through", () => {
  it("carries ctx.oboCeiling onto the ONE actor handed to both capture and resolve", async () => {
    await callResolve({ orgId: ORG, userId: "user-1430", oboCeiling: CEILING });

    expect(captureSnapshotsForContextSlot).toHaveBeenCalledTimes(1);
    expect(resolveContextSlot).toHaveBeenCalledTimes(1);
    const cap = captureSnapshotsForContextSlot.mock.calls[0][0] as CaptureArgs;
    const res = resolveContextSlot.mock.calls[0][0] as ResolverArgs;

    // The ceiling was on the actor AT THE MOMENT CAPTURE RAN (recorded
    // synchronously inside the mock — not after the handler completed) …
    expect(actorAtCaptureCall).toHaveLength(1);
    expect(actorAtCaptureCall[0].oboCeiling).toEqual(CEILING);
    // … and BOTH sides see the same actor object, so capture and resolve
    // cannot diverge on scope.
    expect(cap.actor.oboCeiling).toEqual(CEILING);
    expect(res.actor).toBe(cap.actor);
    // The actor is the built actor-context (ceiling attached, not replaced).
    expect(builtActors).toHaveLength(1);
    expect(cap.actor).toBe(builtActors[0]);
    expect(cap.actor.organizationId).toBe(ORG);
    // projectId refinement reaches both compositions.
    expect(cap.projectId).toBe(INPUT.projectId);
    expect(res.projectId).toBe(INPUT.projectId);
  });

  it("narrow-only: no ceiling in the MCP frame (absent or null) adds NO ceiling key", async () => {
    await callResolve({ orgId: ORG, userId: "user-1430" });
    await callResolve({ orgId: ORG, userId: "user-1430", oboCeiling: null });
    expect(actorAtCaptureCall).toHaveLength(2);
    expect(actorAtCaptureCall[0].hasCeilingKey).toBe(false);
    expect(actorAtCaptureCall[1].hasCeilingKey).toBe(false);
  });

  it("A2A branch: the carry also rides an a2a-resolved identity (capture-time)", async () => {
    // The request-context type does not enforce A2A/OBO mutual exclusion —
    // a frame can carry BOTH an a2aActorContext (which wins identity
    // resolution) and a transport-verified ceiling. A regression narrowing
    // the carry to the non-A2A branch must fail here.
    await callResolve({
      orgId: "org-decoy", // decoy top-level identity — a2a must win
      userId: "user-decoy",
      oboCeiling: CEILING,
      a2aActorContext: { orgId: ORG, userId: "a2a-user-1430" },
    });
    expect(actorAtCaptureCall).toHaveLength(1);
    expect(actorAtCaptureCall[0].organizationId).toBe(ORG); // a2a org won
    expect(actorAtCaptureCall[0].oboCeiling).toEqual(CEILING); // carry intact
  });

  it("captures BEFORE resolving and feeds capture.pins through as snapshotPins", async () => {
    const out = (await callResolve({ orgId: ORG, userId: "user-1430" })) as {
      structuredContent: { refs: unknown; slotId: string };
    };

    const capOrder = captureSnapshotsForContextSlot.mock.invocationCallOrder[0];
    const resOrder = resolveContextSlot.mock.invocationCallOrder[0];
    expect(capOrder).toBeLessThan(resOrder);

    const res = resolveContextSlot.mock.calls[0][0] as ResolverArgs;
    expect(res.snapshotPins).toEqual(PINS);
    expect(res.slot.slotId).toBe("slot-unit");
    // The resolver's refs are what the envelope returns.
    expect(out.structuredContent.refs).toEqual(REFS);
    expect(out.structuredContent.slotId).toBe("slot-unit");
  });

  it("fail-closed: no active organization rejects BEFORE any capture work", async () => {
    await expect(callResolve({ userId: "user-1430" })).rejects.toThrow(
      /no active organization/,
    );
    expect(captureSnapshotsForContextSlot).not.toHaveBeenCalled();
    expect(resolveContextSlot).not.toHaveBeenCalled();
  });
});

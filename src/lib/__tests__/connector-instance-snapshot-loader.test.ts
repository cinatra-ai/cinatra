import { describe, expect, it, vi } from "vitest";
import {
  classifyExposureModeFromWireTools,
  createConnectorInstanceSnapshotLoader,
  type ConnectorInstanceSnapshotLoaderDeps,
} from "@/lib/connector-instance-snapshot-loader";
import { CATALOG_DEFAULT_SERVER_ID } from "@/lib/connector-instance-catalog-cache";
import {
  TRIAD_DISCOVER_ABILITIES,
  TRIAD_EXECUTE_ABILITY,
  TRIAD_GET_ABILITY_INFO,
} from "@/lib/connector-instance-mcp-transport";

// cinatra#2018 S3 — exposure-mode dispatch: classification from the wire
// tools/list, write-back on first classification, flip → invalidate + audit,
// default server pinned triad-only (no classification traffic at all).

const TRIAD_ROWS = [
  { name: TRIAD_DISCOVER_ABILITIES, inputSchema: {} },
  { name: TRIAD_GET_ABILITY_INFO, inputSchema: {} },
  { name: TRIAD_EXECUTE_ABILITY, inputSchema: {} },
];

const NATIVE_ROWS = [
  { name: "vendor_tool_a", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "vendor_tool_b", inputSchema: {} },
];

function makeDeps(overrides: Partial<ConnectorInstanceSnapshotLoaderDeps> = {}) {
  const listTools = vi.fn(async () => NATIVE_ROWS as Array<Record<string, unknown>>);
  // Triad wire behavior: discover returns one ability; get-info hydrates it.
  const callWireTool = vi.fn(async (input: { name: string }) => {
    if (input.name === TRIAD_DISCOVER_ABILITIES) return { abilities: [{ name: "ewpa/one" }] };
    if (input.name === TRIAD_GET_ABILITY_INFO) return { input_schema: {}, meta: { annotations: {} } };
    return {};
  });
  const readExposureMode = vi.fn(async () => null as "triad-only" | "first-class" | null);
  const recordExposureMode = vi.fn(async () => {});
  const invalidateSnapshot = vi.fn();
  const audit = vi.fn(async () => {});
  const deps: ConnectorInstanceSnapshotLoaderDeps = {
    callWireTool: callWireTool as unknown as ConnectorInstanceSnapshotLoaderDeps["callWireTool"],
    listTools,
    readExposureMode,
    recordExposureMode,
    invalidateSnapshot,
    audit,
    ...overrides,
  };
  return { deps, listTools, callWireTool, readExposureMode, recordExposureMode, invalidateSnapshot, audit };
}

const LOAD_INPUT = {
  connectorKey: "wordpress",
  instanceId: "inst-1",
  serverId: "wps-0123456789abcdef",
  endpoint: "https://site.test/index.php?rest_route=/mcp/vendor",
  authHeader: "Basic zzz",
};

describe("classifyExposureModeFromWireTools (pure)", () => {
  it("all three triad wire names ⇒ triad-only", () => {
    expect(classifyExposureModeFromWireTools(TRIAD_ROWS)).toBe("triad-only");
  });
  it("a partial trio or native tools ⇒ first-class (empty set included)", () => {
    expect(classifyExposureModeFromWireTools(TRIAD_ROWS.slice(0, 2))).toBe("first-class");
    expect(classifyExposureModeFromWireTools(NATIVE_ROWS)).toBe("first-class");
    expect(classifyExposureModeFromWireTools([])).toBe("first-class");
  });
});

describe("createConnectorInstanceSnapshotLoader — default server pinned", () => {
  it("expands the triad directly: no tools/list, no classification write, no audit", async () => {
    const { deps, listTools, recordExposureMode, audit } = makeDeps();
    const load = createConnectorInstanceSnapshotLoader(deps);
    const snap = await load({ ...LOAD_INPUT, serverId: CATALOG_DEFAULT_SERVER_ID });
    expect(snap.exposureMode).toBe("triad-only");
    expect(snap.serverId).toBe(CATALOG_DEFAULT_SERVER_ID);
    expect(snap.tools.map((t) => t.name)).toEqual(["ewpa/one"]);
    expect(listTools).not.toHaveBeenCalled();
    expect(recordExposureMode).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("createConnectorInstanceSnapshotLoader — dedicated servers", () => {
  it("first-class: snapshot built from the SAME tools/list rows (one wire round-trip), mode written back", async () => {
    const { deps, listTools, callWireTool, recordExposureMode, audit } = makeDeps();
    const load = createConnectorInstanceSnapshotLoader(deps);
    const snap = await load(LOAD_INPUT);
    expect(snap.exposureMode).toBe("first-class");
    expect(snap.tools.map((t) => t.name)).toEqual(["vendor_tool_a", "vendor_tool_b"]);
    expect(snap.tools[0]!.rawAnnotations).toEqual({ readOnlyHint: true });
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(callWireTool).not.toHaveBeenCalled(); // no triad expansion
    expect(recordExposureMode).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      serverId: LOAD_INPUT.serverId,
      exposureMode: "first-class",
    });
    // First classification is NOT a flip — no audit, no invalidation.
    expect(audit).not.toHaveBeenCalled();
  });

  it("triad-only: the trio in tools/list dispatches to triad expansion", async () => {
    const { deps, callWireTool, recordExposureMode } = makeDeps({
      listTools: vi.fn(async () => TRIAD_ROWS as Array<Record<string, unknown>>),
    });
    const load = createConnectorInstanceSnapshotLoader(deps);
    const snap = await load(LOAD_INPUT);
    expect(snap.exposureMode).toBe("triad-only");
    expect(snap.tools.map((t) => t.name)).toEqual(["ewpa/one"]);
    expect(callWireTool).toHaveBeenCalled(); // discover → get-info ran
    expect(recordExposureMode).toHaveBeenCalledWith(
      expect.objectContaining({ exposureMode: "triad-only" }),
    );
  });

  it("stored mode matches the wire ⇒ no write-back, no invalidation, no audit", async () => {
    const { deps, recordExposureMode, invalidateSnapshot, audit } = makeDeps({
      readExposureMode: vi.fn(async () => "first-class" as const),
    });
    const load = createConnectorInstanceSnapshotLoader(deps);
    await load(LOAD_INPUT);
    expect(recordExposureMode).not.toHaveBeenCalled();
    expect(invalidateSnapshot).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a FLIP re-writes the row, invalidates the cached snapshot and audits (never silent)", async () => {
    const { deps, recordExposureMode, invalidateSnapshot, audit } = makeDeps({
      readExposureMode: vi.fn(async () => "triad-only" as const),
    });
    const load = createConnectorInstanceSnapshotLoader(deps);
    const snap = await load(LOAD_INPUT); // wire says first-class now
    expect(snap.exposureMode).toBe("first-class");
    expect(recordExposureMode).toHaveBeenCalledWith(
      expect.objectContaining({ exposureMode: "first-class" }),
    );
    expect(invalidateSnapshot).toHaveBeenCalledWith("inst-1", LOAD_INPUT.serverId);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      operation: "server_exposure_mode_changed",
      resourceId: "inst-1",
      metadata: {
        connectorKey: "wordpress",
        serverId: LOAD_INPUT.serverId,
        from: "triad-only",
        to: "first-class",
      },
    });
  });

  it("a wire failure propagates (the invoker's acquire loop owns the fallout)", async () => {
    const wireErr = new Error("boom");
    const { deps, recordExposureMode } = makeDeps({
      listTools: vi.fn(async () => {
        throw wireErr;
      }),
    });
    const load = createConnectorInstanceSnapshotLoader(deps);
    await expect(load(LOAD_INPUT)).rejects.toBe(wireErr);
    expect(recordExposureMode).not.toHaveBeenCalled();
  });
});

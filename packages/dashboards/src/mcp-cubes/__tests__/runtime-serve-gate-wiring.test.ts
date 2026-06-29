/**
 * CG-5 MCP serve-gate WIRING test (cinatra#660). Proves the MCP handler:
 *   1. extracts the cube id from `input.query` (NOT the top-level input) — the
 *      drizzle-cube MCP shape is `{ query: <CubeQuery> }`; reading the wrong
 *      object would make the gate never find a cube id and silently pass-through
 *      (a CG-5 bypass — the bug a review caught);
 *   2. blocks a denied runtime cube with the gate's error envelope BEFORE
 *      dispatching to drizzle-cube;
 *   3. lets an allowed cube through to `tools.handle`.
 *
 * The serve-host is mocked per-test here (the global stub allows everything;
 * this file overrides it to assert the cube id + force a denial).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordedCalls, handleStub, serveCalls, discoverPayload } = vi.hoisted(() => {
  const recordedCalls: Array<{ name: string; input: unknown }> = [];
  const serveCalls: string[] = [];
  const discoverPayload: { value: unknown } = { value: {} };
  const handleStub = vi.fn(async (name: string, input: unknown) => {
    recordedCalls.push({ name, input });
    if (name === "dashboards_cube_discover") {
      const sc = discoverPayload.value as Record<string, unknown>;
      return { content: [{ type: "text", text: JSON.stringify(sc) }], structuredContent: sc, isError: false };
    }
    return { content: [{ type: "text", text: "{}" }], structuredContent: {}, isError: false };
  });
  return { recordedCalls, handleStub, serveCalls, discoverPayload };
});

vi.mock("../cubes-singleton", () => ({
  getMcpCubeTools: () => ({ definitions: [], handle: handleStub, handles: () => true, toolNames: [], resources: [] }),
  __resetMcpCubeToolsForTests: () => {},
}));
vi.mock("@/lib/better-auth-db", () => ({ listAccessibleOrgIdsForUser: async () => [] }));
// Mock the runtime registry so the ext_* ids are runtime cubes, agent_runs is not.
vi.mock("@cinatra-ai/dashboards/runtime-cube-registry", () => ({
  isRuntimeCube: (id: string) => id === "ext_denied" || id === "ext_allowed",
}));
// Mock the serve-host: record the cube id it is asked about; deny "ext_denied".
vi.mock("@/lib/dashboards/runtime-cube-serve-host", () => ({
  assertMcpRuntimeCubeServeable: async (cubeId: string) => {
    serveCalls.push(cubeId);
    if (cubeId === "ext_denied") return { ok: false, code: "cube_not_active", reason: "not active" };
    return { ok: true };
  },
  filterMcpCubeIdsForActor: async (ids: string[]) => ids.filter((id) => id !== "ext_denied"),
}));

import { createDashboardCubeMcpHandlers } from "../handlers";

beforeEach(() => {
  recordedCalls.length = 0;
  serveCalls.length = 0;
  handleStub.mockClear();
});

describe("MCP serve-gate wiring (CG-5)", () => {
  it("extracts the cube id from input.query and BLOCKS a denied runtime cube before dispatch", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    const result = await handlers.dashboards_cube_load({ query: { measures: ["ext_denied.count"] } });
    // The gate was asked about the cube id extracted from input.query.
    expect(serveCalls).toEqual(["ext_denied"]);
    // drizzle-cube was NOT reached (gate blocked first).
    expect(handleStub).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code?: string }).code).toBe("cube_not_active");
  });

  it("lets an ALLOWED runtime cube through to tools.handle", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    await handlers.dashboards_cube_load({ query: { measures: ["ext_allowed.count"] } });
    expect(serveCalls).toEqual(["ext_allowed"]);
    expect(handleStub).toHaveBeenCalledTimes(1);
  });

  it("does NOT gate a bundled cube against the runtime serve-host (isRuntimeCube=false), but still calls the gate which allows it", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    await handlers.dashboards_cube_load({ query: { measures: ["agent_runs.count"] } });
    // assertMcpRuntimeCubeServeable is called for every query; for a bundled cube
    // it returns ok (the real impl short-circuits via isRuntimeCube).
    expect(serveCalls).toEqual(["agent_runs"]);
    expect(handleStub).toHaveBeenCalledTimes(1);
  });

  it("chart + validate are gated the same way", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    const chart = await handlers.dashboards_cube_chart({ query: { measures: ["ext_denied.count"] } });
    expect(chart.isError).toBe(true);
    const validate = await handlers.dashboards_cube_validate({ query: { measures: ["ext_denied.count"] } });
    expect(validate.isError).toBe(true);
    expect(handleStub).not.toHaveBeenCalled();
  });

  it("discover catalog filter removes a denied runtime cube (array-of-entries shape)", async () => {
    discoverPayload.value = {
      cubes: [
        { name: "agent_runs", measures: [] },
        { name: "ext_allowed", measures: [] },
        { name: "ext_denied", measures: [] },
      ],
    };
    const handlers = createDashboardCubeMcpHandlers();
    const result = await handlers.dashboards_cube_discover({});
    const cubes = (result.structuredContent as { cubes: Array<{ name: string }> }).cubes;
    expect(cubes.map((c) => c.name)).toEqual(["agent_runs", "ext_allowed"]);
    // The text block is rebuilt to the filtered list too.
    const parsed = JSON.parse(result.content[0].text) as { cubes: Array<{ name: string }> };
    expect(parsed.cubes.map((c) => c.name)).toEqual(["agent_runs", "ext_allowed"]);
  });

  it("discover catalog filter handles the `cube`-keyed entry shape", async () => {
    discoverPayload.value = { cubes: [{ cube: "ext_denied" }, { cube: "agent_runs" }] };
    const handlers = createDashboardCubeMcpHandlers();
    const result = await handlers.dashboards_cube_discover({});
    const cubes = (result.structuredContent as { cubes: Array<{ cube: string }> }).cubes;
    expect(cubes.map((c) => c.cube)).toEqual(["agent_runs"]);
  });

  it("discover catalog filter handles an object-keyed-by-cube-id map", async () => {
    discoverPayload.value = { cubes: { agent_runs: {}, ext_denied: {}, ext_allowed: {} } };
    const handlers = createDashboardCubeMcpHandlers();
    const result = await handlers.dashboards_cube_discover({});
    const cubes = (result.structuredContent as { cubes: Record<string, unknown> }).cubes;
    expect(Object.keys(cubes).sort()).toEqual(["agent_runs", "ext_allowed"]);
  });
});

/**
 * Vanilla-strictness regression test. The Cinatra-side pre-flight
 * auth check in `createDashboardCubeMcpHandlers().dispatch()` must stay
 * absent so the cube handlers behave exactly like vanilla drizzle-cube/mcp:
 *
 *   - `discover` returns the cube catalog regardless of identity
 *     (catalog is not tenant-scoped).
 *   - `validate` parses queries regardless of identity (drizzle-cube
 *     silently catches identity errors).
 *   - `load` / `chart` surface identity failures via the cube tools'
 *     own `MCPToolResult.isError` envelope.
 *
 * This test asserts the handlers ARE a pure pass-through to
 * `tools.handle()`. If a future change reintroduces a Cinatra-side
 * early-return on missing identity, this test will fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

// `vi.hoisted` is the canonical way to share state between a `vi.mock`
// factory (which Vitest hoists to the top of the file BEFORE other
// top-level declarations) and the test bodies. Without it, the
// `recordedCalls` / `handleStub` references would dangle at hoist time
// and the mock could silently desynchronize from the assertions.
// See https://vitest.dev/api/vi.html#vi-hoisted.
const { recordedCalls, handleStub } = vi.hoisted(() => {
  const recordedCalls: Array<{ name: string; input: unknown }> = [];
  const handleStub = vi.fn(async (name: string, input: unknown) => {
    recordedCalls.push({ name, input });
    return {
      content: [{ type: "text", text: '{"data":[]}' }],
      structuredContent: { data: [] },
      isError: false,
    };
  });
  return { recordedCalls, handleStub };
});

vi.mock("../cubes-singleton", () => ({
  getMcpCubeTools: () => ({
    definitions: [],
    handle: handleStub,
    handles: () => true,
    toolNames: [],
    resources: [],
  }),
  __resetMcpCubeToolsForTests: () => {},
}));

vi.mock("@/lib/better-auth-db", () => ({
  listAccessibleOrgIdsForUser: async () => [],
}));

import { createDashboardCubeMcpHandlers } from "../handlers";

beforeEach(() => {
  recordedCalls.length = 0;
  handleStub.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDashboardCubeMcpHandlers — vanilla pass-through to drizzle-cube", () => {
  it("dispatches `dashboards_cube_discover` to tools.handle even when ALS has no identity", async () => {
    const handlers = createDashboardCubeMcpHandlers();

    // No ALS context → identity is null.
    const result = await handlers.dashboards_cube_discover({ topic: "agents" });

    // Vanilla pass-through — `tools.handle()` was called, NOT short-circuited.
    expect(handleStub).toHaveBeenCalledTimes(1);
    expect(recordedCalls[0]).toEqual({
      name: "dashboards_cube_discover",
      input: { topic: "agents" },
    });
    // An auth short-circuit would return
    // {isError:true, error:{code:"unauthorized"}} here. This path must
    // forward drizzle-cube's response as-is.
    expect(result.isError).toBe(false);
  });

  it("dispatches `dashboards_cube_validate` to tools.handle even with no identity", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    await handlers.dashboards_cube_validate({ query: { measures: ["agent_runs.count"] } });
    expect(handleStub).toHaveBeenCalledTimes(1);
    expect(recordedCalls[0].name).toBe("dashboards_cube_validate");
  });

  it("dispatches `dashboards_cube_load` to tools.handle regardless of identity (drizzle-cube handles the auth failure)", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    await handlers.dashboards_cube_load({ query: { measures: ["agent_runs.count"] } });
    expect(handleStub).toHaveBeenCalledTimes(1);
    expect(recordedCalls[0].name).toBe("dashboards_cube_load");
  });

  it("dispatches `dashboards_cube_chart` to tools.handle", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    await handlers.dashboards_cube_chart({ query: { measures: ["agent_runs.count"] } });
    expect(handleStub).toHaveBeenCalledTimes(1);
    expect(recordedCalls[0].name).toBe("dashboards_cube_chart");
  });

  it("still pass-through when ALS context IS populated — no special-casing either way", async () => {
    const handlers = createDashboardCubeMcpHandlers();
    await mcpRequestContextStorage.run(
      { userId: "user-1", orgId: "org-1" } as never,
      async () => {
        await handlers.dashboards_cube_load({ query: { measures: ["agent_runs.count"] } });
      },
    );
    expect(handleStub).toHaveBeenCalledTimes(1);
  });
});

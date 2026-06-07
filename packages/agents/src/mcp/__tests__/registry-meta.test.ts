import { describe, it, expect, vi, beforeEach } from "vitest";

type Captured = {
  name: string;
  meta: Record<string, unknown>;
  // The registry casts the callback `as any` (registry.ts:36); we accept the loose shape.
  callback: (input: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }>;
};

const captured: Captured[] = [];
const handlersMap = new Map<string, (req: unknown) => Promise<unknown>>();

vi.mock("../handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => {
    const obj: Record<string, (req: unknown) => Promise<unknown>> = {};
    for (const [k, fn] of handlersMap.entries()) obj[k] = fn;
    return obj;
  },
  // registry.ts also calls createAgentsPrimitiveHandlers(); include it
  // because registration expects the agents primitive factory to exist
  // at registration time.
  createAgentsPrimitiveHandlers: () => ({}),
}));
vi.mock("../agent-tools-registry", () => ({
  registerPublishedAgentTools: vi.fn().mockResolvedValue(undefined),
}));
// FIX: path is `../discovery` (relative to src/mcp/__tests__/), NOT `./discovery`.
// discovery.ts lives at src/mcp/discovery.ts — one directory up from __tests__/.
vi.mock("../discovery", () => ({
  registerAgentBuilderDiscovery: vi.fn(),
}));

function makeMockServer() {
  return {
    registerTool: (name: string, meta: Record<string, unknown>, cb: any) => {
      captured.push({ name, meta, callback: cb });
    },
    registerResource: vi.fn(),
    registerPrompt: vi.fn(),
    registerScreen: vi.fn(),
  } as any;
}

async function setup(handlerEntries: Array<[string, unknown]>) {
  captured.length = 0;
  handlersMap.clear();
  for (const [n, ret] of handlerEntries) {
    handlersMap.set(n, vi.fn().mockResolvedValue(ret));
  }
  const { registerAgentBuilderPrimitives } = await import("../registry");
  await registerAgentBuilderPrimitives(makeMockServer());
}

describe("registry _meta enrichment", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("META-01: agent_run with runId attaches render hint", async () => {
    await setup([["agent_run", { runId: "run-123", status: "queued" }]]);
    const tool = captured.find((c) => c.name === "agent_run");
    expect(tool).toBeDefined();
    const res = await tool!.callback({});
    expect(res._meta).toEqual({
      "io.cinatra.render": {
        type: "agent-run",
        runId: "run-123",
        protocols: ["ag-ui", "a2ui"],
      },
    });
  });

  it("P8: agent_run with error result does NOT attach _meta", async () => {
    await setup([["agent_run", { error: "boom" }]]);
    const tool = captured.find((c) => c.name === "agent_run")!;
    const res = await tool.callback({});
    expect(res._meta).toBeUndefined();
  });

  it("P8: agent_run with non-string runId does NOT attach _meta", async () => {
    await setup([["agent_run", { runId: 42, status: "queued" }]]);
    const tool = captured.find((c) => c.name === "agent_run")!;
    const res = await tool.callback({});
    expect(res._meta).toBeUndefined();
  });

  it("META-02: agent_run_get pending_approval sets approvalRequired=true", async () => {
    await setup([["agent_run_get", { id: "run-9", status: "pending_approval" }]]);
    const tool = captured.find((c) => c.name === "agent_run_get")!;
    const res = await tool.callback({});
    expect(res._meta).toEqual({
      "io.cinatra.render": {
        type: "agent-run-status",
        runId: "run-9",
        status: "pending_approval",
        approvalRequired: true,
      },
    });
  });

  it("META-02: agent_run_get completed sets approvalRequired=false", async () => {
    await setup([["agent_run_get", { id: "run-9", status: "completed" }]]);
    const tool = captured.find((c) => c.name === "agent_run_get")!;
    const res = await tool.callback({});
    expect((res._meta as any)["io.cinatra.render"].approvalRequired).toBe(false);
  });

  it("P8: agent_run_get with error does NOT attach _meta", async () => {
    await setup([["agent_run_get", { error: "x" }]]);
    const tool = captured.find((c) => c.name === "agent_run_get")!;
    const res = await tool.callback({});
    expect(res._meta).toBeUndefined();
  });

  it("META-03: agent_run_messages_list attaches render hint", async () => {
    await setup([["agent_run_messages_list", { runId: "r", runStatus: "completed", messages: [] }]]);
    const tool = captured.find((c) => c.name === "agent_run_messages_list")!;
    const res = await tool.callback({});
    expect(res._meta).toEqual({
      "io.cinatra.render": {
        type: "agent-run-messages",
        runId: "r",
        runStatus: "completed",
      },
    });
  });

  it("P8: agent_run_messages_list with error does NOT attach _meta", async () => {
    await setup([["agent_run_messages_list", { error: "x" }]]);
    const tool = captured.find((c) => c.name === "agent_run_messages_list")!;
    const res = await tool.callback({});
    expect(res._meta).toBeUndefined();
  });

  it("non-targeted tool (agent_list) does NOT attach _meta", async () => {
    await setup([["agent_list", { items: [], total: 0, nextCursor: null }]]);
    const tool = captured.find((c) => c.name === "agent_list")!;
    const res = await tool.callback({});
    expect(res._meta).toBeUndefined();
  });

  it("P2 guard: tool DEFINITION meta does not contain _meta key", async () => {
    await setup([["agent_run", { runId: "r", status: "queued" }]]);
    const tool = captured.find((c) => c.name === "agent_run")!;
    // The 2nd arg to registerTool is the tool DEFINITION — _meta must NOT live here.
    expect(tool.meta).not.toHaveProperty("_meta");
  });
});

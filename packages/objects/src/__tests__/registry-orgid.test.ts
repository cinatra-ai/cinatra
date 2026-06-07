// MIG-01 registry-level wiring test.
// Status: RED on main (registry.ts:58 hardcodes actor with no orgId).
// Turns GREEN once registry.ts is rewritten to read
// mcpRequestContextStorage and extend mcpRequestContextStorage's type
// in packages/mcp-server/src/index.tsx to include orgId.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Capture registered tool callbacks so tests can drive them synthetically.
const registeredTools: Array<{ name: string; handler: (input: unknown) => Promise<unknown> }> = [];

const mockServer = {
  registerTool: vi.fn((name: string, _meta: unknown, handler: (input: unknown) => Promise<unknown>) => {
    registeredTools.push({ name, handler });
  }),
  registerResource: vi.fn(),
  registerPrompt: vi.fn(),
  registerScreen: vi.fn(),
};

// Spy on the underlying handler so we can inspect what actor was passed.
const handlerSpy = vi.fn(async () => ({ objectId: "obj-1", type: "@cinatra-ai/entity-contacts:contact", isNew: true, wasMerged: false, confidence: 1 }));
vi.mock("../mcp/handlers", () => ({
  createObjectsPrimitiveHandlers: () => ({
    objects_save: handlerSpy,
    objects_list: vi.fn(async () => ({ items: [], nextCursor: null })),
    objects_get: vi.fn(async () => null),
    objects_update: vi.fn(async () => ({ ok: true })),
    objects_delete: vi.fn(async () => ({ ok: true })),
    objects_classify: vi.fn(async () => ({ type: "@cinatra-ai/dynamic:x", confidence: 0.5, normalizedData: {}, isNewType: true, inferredTypeName: null, inferredCategory: null })),
    objects_types_list: vi.fn(async () => ({ items: [] })),
  }),
}));

describe("registerObjectsPrimitives actor.orgId threading (MIG-01)", () => {
  beforeEach(() => {
    registeredTools.length = 0;
    handlerSpy.mockClear();
    mockServer.registerTool.mockClear();
  });

  it("reads orgId from mcpRequestContextStorage and passes it to the handler as actor.orgId", async () => {
    const mcpServerModule = await import("@cinatra-ai/mcp-server");
    const { mcpRequestContextStorage } = mcpServerModule as unknown as {
      mcpRequestContextStorage: { run: (store: Record<string, unknown>, fn: () => Promise<unknown>) => Promise<unknown> };
    };
    const { registerObjectsPrimitives } = await import("../mcp/registry");
    registerObjectsPrimitives(mockServer as any);
    const saveTool = registeredTools.find((t) => t.name === "objects_save");
    expect(saveTool).toBeDefined();

    await mcpRequestContextStorage.run({ orgId: "org-abc" } as any, async () => {
      await saveTool!.handler({ rawData: { name: "x" }, typeHint: "@cinatra-ai/entity-contacts:contact" });
    });

    expect(handlerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ orgId: "org-abc" }),
      }),
    );
  });

  it("passes actor WITHOUT orgId when no request context is active", async () => {
    const { registerObjectsPrimitives } = await import("../mcp/registry");
    registerObjectsPrimitives(mockServer as any);
    const saveTool = registeredTools.find((t) => t.name === "objects_save");
    expect(saveTool).toBeDefined();

    await saveTool!.handler({ rawData: { name: "x" }, typeHint: "@cinatra-ai/entity-contacts:contact" });

    expect(handlerSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.not.objectContaining({ orgId: "org-abc" }),
      }),
    );
  });
});

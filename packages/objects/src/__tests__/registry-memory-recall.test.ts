// `memory_recall` discoverability over MCP (cinatra#1380 AC3).
//
// FAIL-FIRST: captured RED before the TOOL_META entry existed (the registry
// falls back to `{ description: name, inputSchema: passthrough }` for an
// unlisted name, so an unregistered tool is not merely absent — it advertises a
// PASSTHROUGH schema, which is exactly the shape that would let a forged
// `group_ids` reach a handler on a less strict day).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// The registry is the unit under test; the handler module pulls the host-app
// graph (classifier -> @cinatra-ai/llm -> the generated extension manifest), so
// stub it exactly as registry-orgid.test.ts does. AC3 is about what the server
// ADVERTISES, not about what the handler computes.
vi.mock("../mcp/handlers", () => ({
  createObjectsPrimitiveHandlers: () => ({
    objects_save: vi.fn(),
    objects_list: vi.fn(),
    objects_get: vi.fn(),
    objects_update: vi.fn(),
    objects_delete: vi.fn(),
    objects_classify: vi.fn(),
    objects_types_list: vi.fn(),
    memory_recall: vi.fn(async () => ({ items: [], mode: "semantic" })),
  }),
}));

const registered: Array<{
  name: string;
  meta: { title: string; description: string; inputSchema: unknown };
}> = [];

const mockServer = {
  registerTool: vi.fn((name: string, meta: never) => {
    registered.push({ name, meta });
  }),
  registerResource: vi.fn(),
  registerPrompt: vi.fn(),
  registerScreen: vi.fn(),
};

beforeEach(() => {
  registered.length = 0;
  mockServer.registerTool.mockClear();
});

describe("memory_recall is discoverable over MCP (AC3)", () => {
  it("registers with a tool-calling-grade description and its OWN strict schema", async () => {
    const { registerObjectsPrimitives } = await import("../mcp/registry");
    const schemas = await import("../mcp/schemas");
    registerObjectsPrimitives(mockServer as never);

    const tool = registered.find((t) => t.name === "memory_recall");
    expect(tool).toBeDefined();

    // Not the `description: name` fallback, and long enough to tell a
    // tool-calling agent what it does and what `mode` means.
    expect(tool!.meta.description).not.toBe("memory_recall");
    expect(tool!.meta.description.length).toBeGreaterThan(80);
    expect(tool!.meta.description).toMatch(/degraded-recent/);
    expect(tool!.meta.description).toMatch(/mode/);

    // The advertised schema is the strict recall schema, not the passthrough
    // fallback: an unknown key must be REJECTED at the advertised boundary.
    expect(tool!.meta.inputSchema).toBe(schemas.memoryRecallSchema);
    expect(
      (tool!.meta.inputSchema as typeof schemas.memoryRecallSchema).safeParse({
        query: "q",
        group_ids: ["forged"],
      }).success,
    ).toBe(false);
    expect(
      (tool!.meta.inputSchema as typeof schemas.memoryRecallSchema).safeParse({
        query: "q",
      }).success,
    ).toBe(true);
  });

  it("advertises the documented request shape (query required; kind/projectId/limit optional)", async () => {
    const schemas = await import("../mcp/schemas");
    const s = schemas.memoryRecallSchema;

    expect(s.safeParse({}).success).toBe(false);
    const ok = s.safeParse({ query: "q" });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.limit).toBe(schemas.MEMORY_RECALL_DEFAULT_LIMIT);
    expect(s.safeParse({ query: "q", kind: "decision" }).success).toBe(true);
    expect(s.safeParse({ query: "q", projectId: "p1" }).success).toBe(true);
    expect(s.safeParse({ query: "q", projectId: null }).success).toBe(true);
    expect(s.safeParse({ query: "q", limit: schemas.MEMORY_RECALL_MAX_LIMIT }).success).toBe(true);
  });
});

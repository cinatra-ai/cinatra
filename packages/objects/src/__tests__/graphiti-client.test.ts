// Structure tests — no live Graphiti or MCP service required
// MCP Client is mocked so tests run offline

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock server-only so imports don't throw in test environment
vi.mock("server-only", () => ({}));

// Mock the MCP SDK client so no network is required
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // Arrow functions cannot be constructors — use a regular function so `new` works.
  Client: vi.fn().mockImplementation(function () {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  // Arrow functions cannot be constructors — use a regular function so `new` works.
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

function mcpText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

describe("graphiti-client (MCP)", () => {
  beforeEach(() => {
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    mockCallTool.mockReset();
  });

  it("addEpisode resolves with result object", async () => {
    mockCallTool.mockResolvedValue(mcpText({ message: "Episode added", episode_id: "ep-123" }));
    const { addEpisode } = await import("../graphiti-client");
    const result = await addEpisode({
      name: "Test Entity",
      episode_body: '{"name":"Test"}',
      source: "json",
      group_id: "cinatra-default",
    });
    expect(typeof result).toBe("object");
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_memory" }),
    );
  });

  it("searchNodes returns nodes array", async () => {
    mockCallTool.mockResolvedValue(mcpText({ nodes: [{ uuid: "n1", name: "Acme Corp" }] }));
    const { searchNodes } = await import("../graphiti-client");
    const result = await searchNodes({ query: "acme", group_ids: ["cinatra-default"] });
    expect(Array.isArray(result.nodes)).toBe(true);
  });

  it("getEpisodes returns episodes array", async () => {
    mockCallTool.mockResolvedValue(mcpText({ episodes: [{ uuid: "ep1", name: "test", content: "{}" }] }));
    const { getEpisodes } = await import("../graphiti-client");
    const result = await getEpisodes({ group_ids: ["cinatra-default"] });
    expect(Array.isArray(result.episodes)).toBe(true);
  });

  it("getStatus returns connected when MCP call succeeds", async () => {
    mockCallTool.mockResolvedValue(mcpText({ status: "ok" }));
    const { getStatus } = await import("../graphiti-client");
    const result = await getStatus();
    expect(result).toHaveProperty("status");
    expect(["connected", "not_connected"]).toContain(result.status);
  });

  it("getStatus returns not_connected when MCP call fails", async () => {
    mockCallTool.mockRejectedValue(new Error("connection refused"));
    const { getStatus } = await import("../graphiti-client");
    const result = await getStatus();
    expect(result.status).toBe("not_connected");
    expect(result.detail).toContain("connection refused");
  });

  it("identityHashToUuid produces consistent UUIDs", async () => {
    const { identityHashToUuid } = await import("../graphiti-client");
    const id1 = identityHashToUuid("hash-abc", "group-1");
    const id2 = identityHashToUuid("hash-abc", "group-1");
    const id3 = identityHashToUuid("hash-xyz", "group-1");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  });
});

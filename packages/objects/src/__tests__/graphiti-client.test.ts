// Structure tests — no live Graphiti or MCP service required
// MCP Client is mocked so tests run offline

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetch as undiciFetch } from "undici";

// Mock server-only so imports don't throw in test environment
vi.mock("server-only", () => ({}));

// Mock the MCP client package so no network is required
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();
const clientCtor = vi.fn();
const transportCtor = vi.fn();

vi.mock("@modelcontextprotocol/client", () => ({
  // Arrow functions cannot be constructors — use a regular function so `new` works.
  Client: vi.fn().mockImplementation(function (...args: unknown[]) {
    clientCtor(...args);
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function (...args: unknown[]) {
    transportCtor(...args);
    return {};
  }),
}));

function mcpText(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

describe("graphiti-client (MCP)", () => {
  beforeEach(() => {
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    mockCallTool.mockReset();
    clientCtor.mockReset();
    transportCtor.mockReset();
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

  // -------------------------------------------------------------------------
  // cinatra#2218 L2a — protocol-revision negotiation.
  //
  // `versionNegotiation` is an OPTIONS OBJECT. A bare string leaves
  // `options?.mode` undefined and the client silently falls back to its
  // default (which is also legacy), producing a working client whose era was
  // never actually chosen. These assertions make the object shape AND the
  // explicit legacy mode load-bearing, so a refactor cannot regress this
  // surface to accidental legacy.
  // -------------------------------------------------------------------------
  describe("protocol-revision negotiation", () => {
    it("constructs the Client with versionNegotiation as an OBJECT (not a bare string)", async () => {
      mockCallTool.mockResolvedValue(mcpText({ status: "ok" }));
      const { getStatus } = await import("../graphiti-client");
      await getStatus();

      expect(clientCtor).toHaveBeenCalled();
      const options = clientCtor.mock.calls[0]?.[1] as
        | { versionNegotiation?: unknown }
        | undefined;
      expect(options).toBeDefined();

      const negotiation = options?.versionNegotiation;
      expect(typeof negotiation).toBe("object");
      expect(negotiation).not.toBeNull();
      // The trap this guards: `versionNegotiation: "legacy"` would type-error
      // and, if it ever reached runtime, would read as `mode: undefined`.
      expect(typeof negotiation).not.toBe("string");
    });

    it("selects legacy mode EXPLICITLY, not by omission", async () => {
      mockCallTool.mockResolvedValue(mcpText({ status: "ok" }));
      const { getStatus } = await import("../graphiti-client");
      await getStatus();

      const options = clientCtor.mock.calls[0]?.[1] as {
        versionNegotiation?: { mode?: unknown };
      };
      // Not just "the default happens to be legacy" — the mode is present.
      expect(options.versionNegotiation).toHaveProperty("mode");
      expect(options.versionNegotiation?.mode).toBe("legacy");
    });

    it("passes no `pin` and does not request the modern era", async () => {
      mockCallTool.mockResolvedValue(mcpText({ status: "ok" }));
      const { getStatus } = await import("../graphiti-client");
      await getStatus();

      const negotiation = (
        clientCtor.mock.calls[0]?.[1] as { versionNegotiation?: { mode?: unknown } }
      ).versionNegotiation;
      // `{ pin: '<revision>' }` is the modern-era-or-fail shape; legacy mode
      // must not carry one, and must not be `auto` while the pinned graphiti
      // image is unprobed for 2026-07-28.
      expect(negotiation?.mode).not.toBe("auto");
      expect(typeof negotiation?.mode).toBe("string");
    });
  });

  // -------------------------------------------------------------------------
  // cinatra#2218 L2a — behaviour parity with the pre-migration client.
  // Each case below reproduces an error path the SDK-v1 implementation had, so
  // the package migration is provably CONSUMER-CONTRACT-preserving rather than
  // merely compiling. (The library's own error taxonomy deliberately DID
  // change — see the table in graphiti-client.ts. What is preserved is what
  // callers actually read.)
  // -------------------------------------------------------------------------
  describe("behaviour parity", () => {
    it("keeps the undici fetch + 30s timeout transport wiring", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      mockCallTool.mockResolvedValue(mcpText({ status: "ok" }));
      const { getStatus } = await import("../graphiti-client");
      await getStatus();

      expect(transportCtor).toHaveBeenCalled();
      const [url, opts] = transportCtor.mock.calls[0] as [
        URL,
        { fetch?: unknown; requestInit?: { signal?: unknown } },
      ];
      expect(url.toString()).toMatch(/\/mcp$/);
      // undici's fetch BY IDENTITY, not merely "a function" — global fetch is
      // patched by Next.js and would propagate the request-lifecycle
      // AbortSignal into the MCP stream, aborting it when the render completes.
      expect(opts.fetch).toBe(undiciFetch);
      expect(opts.requestInit?.signal).toBeInstanceOf(AbortSignal);
      // The exact budget, not just "some signal".
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      timeoutSpy.mockRestore();
    });

    // codex round 2 gap: the cases below inject through `callTool`, but an HTTP
    // handshake failure normally arises inside `connect`. Both share one
    // try/finally, so both must reach the caller unchanged — proven separately
    // so a future connect-specific wrapper cannot slip through.
    it("propagates a connect-time failure to the caller unchanged", async () => {
      class SdkHttpErrorLike extends Error {
        constructor(message: string) {
          super(message);
          this.name = "SdkHttpError";
        }
      }
      const thrown = new SdkHttpErrorLike("Error POSTing to endpoint: refused");
      mockConnect.mockRejectedValue(thrown);
      const { searchNodes } = await import("../graphiti-client");
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toBe(thrown);
      // The client is still closed on the connect-failure path.
      expect(mockClose).toHaveBeenCalled();
      // ...and the call is never attempted.
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it("maps a connect-time failure into getStatus's not_connected detail", async () => {
      mockConnect.mockRejectedValue(new Error("fetch failed"));
      const { getStatus } = await import("../graphiti-client");
      const result = await getStatus();
      expect(result.status).toBe("not_connected");
      expect(result.detail).toContain("fetch failed");
    });

    it("throws the unexpected-response-format error when no text content is returned", async () => {
      mockCallTool.mockResolvedValue({ content: [{ type: "image", data: "…" }] });
      const { searchNodes } = await import("../graphiti-client");
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toThrow(/unexpected response format \(no text content\)/);
    });

    it("throws the unexpected-response-format error when content is absent entirely", async () => {
      mockCallTool.mockResolvedValue({});
      const { searchNodes } = await import("../graphiti-client");
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toThrow(/unexpected response format \(no text content\)/);
    });

    it("propagates a JSON parse failure rather than swallowing it", async () => {
      mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "not json" }] });
      const { searchNodes } = await import("../graphiti-client");
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toThrow(SyntaxError);
    });

    it("propagates a schema mismatch as a validation error", async () => {
      mockCallTool.mockResolvedValue(mcpText({ nodes: "not-an-array" }));
      const { searchNodes } = await import("../graphiti-client");
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toThrow();
    });

    it("closes the client even when the call throws, and swallows close failures", async () => {
      mockCallTool.mockRejectedValue(new Error("boom"));
      mockClose.mockRejectedValue(new Error("close failed"));
      const { searchNodes } = await import("../graphiti-client");
      // The close rejection must NOT replace the original error.
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toThrow("boom");
      expect(mockClose).toHaveBeenCalled();
    });

    // The client migration CHANGED the library's error classes:
    // `StreamableHTTPError` (name "Error", message prefixed "Streamable HTTP
    // error: ") became `SdkHttpError` (name "SdkHttpError", unprefixed). That
    // is deliberate and documented in graphiti-client.ts rather than
    // normalized, because every consumer of this module reads only
    // `instanceof Error` and `.message`. These two cases lock exactly that
    // contract, so a future change that breaks it fails here.
    it("surfaces a transport error's message regardless of its error class", async () => {
      class SdkHttpErrorLike extends Error {
        constructor(message: string) {
          super(message);
          this.name = "SdkHttpError";
        }
      }
      mockCallTool.mockRejectedValue(new SdkHttpErrorLike("Error POSTing to endpoint: boom"));
      const { getStatus } = await import("../graphiti-client");
      const result = await getStatus();
      expect(result.status).toBe("not_connected");
      expect(result.detail).toContain("Error POSTing to endpoint: boom");
    });

    it("surfaces a non-Error throw via String() rather than losing it", async () => {
      mockCallTool.mockRejectedValue("bare string failure");
      const { getStatus } = await import("../graphiti-client");
      const result = await getStatus();
      expect(result.status).toBe("not_connected");
      expect(result.detail).toContain("bare string failure");
    });

    it("re-throws transport errors to callers untouched (no wrapping, no swallowing)", async () => {
      class SdkHttpErrorLike extends Error {
        constructor(message: string) {
          super(message);
          this.name = "SdkHttpError";
        }
      }
      const thrown = new SdkHttpErrorLike("upstream 503");
      mockCallTool.mockRejectedValue(thrown);
      const { searchNodes } = await import("../graphiti-client");
      // graphiti-projector / graphiti-rebuild / objects_list all rely on the
      // original error reaching their catch blocks with its message intact.
      await expect(
        searchNodes({ query: "acme", group_ids: ["cinatra-default"] }),
      ).rejects.toBe(thrown);
    });

    it("deleteEpisode and clearGraph resolve void without parsing the payload", async () => {
      mockCallTool.mockResolvedValue(mcpText({ anything: true }));
      const { deleteEpisode, clearGraph } = await import("../graphiti-client");
      await expect(deleteEpisode({ uuid: "ep-1" })).resolves.toBeUndefined();
      await expect(clearGraph({ group_ids: ["cinatra-default"] })).resolves.toBeUndefined();
    });
  });
});

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";

// Minimal fake Transport satisfying the SDK's Transport interface
// (defined at packages/mcp-server/vendor/.../dist/index-Df8mSdyO.d.mts:4500).
// We only need start/send/close to be no-ops; the SDK attaches on* callbacks
// during connect(). Used to drive the AlreadyConnected branch (vendor index.mjs:651).
function createFakeTransport() {
  const transport: any = {
    async start() {},
    async send(_message: unknown) {},
    async close() {
      this.onclose?.();
    },
  };
  return transport;
}

describe("initialize handshake — vendored SDK direct", () => {
  it("McpServer constructor stores `instructions` on the low-level Server", () => {
    const server = new McpServer(
      { name: "cinatra-mcp", version: "0.2.0" },
      { instructions: "PLACEHOLDER" },
    );
    // The SDK stores the instructions on Server._instructions (vendored
    // index.mjs:587 assigns it; index.mjs:763 reads it back into the initialize response).
    expect((server.server as any)._instructions).toBe("PLACEHOLDER");
  });

  it("empty-string instructions are stored verbatim even though runtime instructions must be non-empty", () => {
    const server = new McpServer(
      { name: "x", version: "0.0.0" },
      { instructions: "" },
    );
    // The SDK accepts "" at construction (index.mjs:587); the silent-drop happens at
    // _oninitialize because of `..._instructions && { instructions }` (index.mjs:763).
    // The runtime mcp-instructions.ts helper must guarantee the string is non-empty in
    // practice. This test pins the SDK behavior so a future SDK upgrade that changes
    // truthiness handling does not silently break instruction delivery.
    expect((server.server as any)._instructions).toBe("");
  });

  it("registerCapabilities merges experimental block before connect", () => {
    const server = new McpServer(
      { name: "cinatra-mcp", version: "0.2.0" },
      { instructions: "PLACEHOLDER" },
    );
    expect(() =>
      server.server.registerCapabilities({ experimental: {} }),
    ).not.toThrow();
    server.server.registerCapabilities({
      experimental: {
        "io.cinatra.protocols": { protocolRevision: "1" },
      },
    });
    const caps = (server.server as any)._capabilities;
    expect(caps.experimental?.["io.cinatra.protocols"]?.protocolRevision).toBe("1");
  });

  it("serverInfo.version is reported on the low-level Server", () => {
    const server = new McpServer(
      { name: "cinatra-mcp", version: "0.2.0" },
      { instructions: "PLACEHOLDER" },
    );
    expect((server.server as any)._serverInfo.version).toBe("0.2.0");
  });

  it("registerCapabilities after connect throws AlreadyConnected", async () => {
    const server = new McpServer(
      { name: "cinatra-mcp", version: "0.2.0" },
      { instructions: "PLACEHOLDER" },
    );
    const fakeTransport = createFakeTransport();
    // Pre-connect call must succeed.
    server.server.registerCapabilities({
      experimental: { "io.cinatra.protocols": { protocolRevision: "1" } },
    });
    await server.server.connect(fakeTransport);
    // Post-connect call must throw — vendored Server.registerCapabilities
    // checks `if (this.transport) throw ...` (vendor index.mjs:651).
    expect(() =>
      server.server.registerCapabilities({
        experimental: { another: { added: "later" } },
      }),
    ).toThrow(/AlreadyConnected|Cannot register capabilities after connecting/);
    // Cleanup
    await server.server.close();
  });
});

describe("runtime instructions contract", () => {
  it("the server reports the real instructions body and experimental block", async () => {
    // This dynamic import resolves to <repo-root>/src/lib/mcp-instructions.ts.
    // From this test file (packages/mcp-server/src/__tests__/) the canonical
    // workspace path is "../../../../src/lib/mcp-instructions".
    // We use a runtime-string import so vitest does not statically resolve
    // (and fail-collect) the module before it exists.
    const target = "../../../../src/lib/mcp-instructions";
    const mod: any = await import(/* @vite-ignore */ target);
    expect(typeof mod.CINATRA_MCP_INSTRUCTIONS).toBe("string");
    expect(mod.CINATRA_MCP_INSTRUCTIONS.length).toBeGreaterThan(100);
    expect(mod.CINATRA_MCP_INSTRUCTIONS.startsWith("---")).toBe(false);

    const server = new McpServer(
      { name: "cinatra-mcp", version: "0.2.0" },
      { instructions: mod.CINATRA_MCP_INSTRUCTIONS },
    );
    server.server.registerCapabilities({
      experimental: mod.CINATRA_MCP_EXPERIMENTAL,
    });
    const caps = (server.server as any)._capabilities;
    expect(caps.experimental["io.cinatra.protocols"].agUi.version).toBe("0.1");
    expect(caps.experimental["io.cinatra.protocols"].a2ui.version).toBe("0.9");
    expect(caps.experimental["io.cinatra.protocols"].a2a.version).toBe("0.3");
  });
});

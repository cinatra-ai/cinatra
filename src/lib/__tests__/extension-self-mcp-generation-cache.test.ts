import { describe, it, expect, vi, beforeEach } from "vitest";

// The self-MCP handler cache is keyed on the extension control-plane generation
// (#310): it rebuilds the host primitive map iff the generation it was built at
// differs from the current generation. We prove that by counting how many times
// the (mocked) `buildHostSelfPrimitiveHandlers` is invoked across calls, bumping
// the generation between them.

const buildSpy = vi.fn();

// Mock the heavy MCP server module — we only need the build function + a no-op
// AsyncLocalStorage-shaped request-context store + the delegated-chat allowlist so
// `callHostPrimitive` runs without pulling the real transport.
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: () => {
    buildSpy();
    // A map with one always-allowed primitive that echoes its input.
    return new Map<string, (...args: unknown[]) => unknown>([
      ["echo_primitive", (input: unknown) => ({ structuredContent: input })],
    ]);
  },
}));

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    getStore: () => undefined,
    run: (_ctx: unknown, fn: () => unknown) => fn(),
  },
  isDelegatedChatMcpToolAllowed: () => true,
}));

// Boundary always allows for this test (we're testing cache keying, not authz).
vi.mock("@/lib/authz/mcp-boundary", () => ({
  enforceMcpBoundary: async () => ({ allowed: true }),
}));

import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";
import {
  bumpActivationGeneration,
  __resetActivationGenerationForTests,
} from "@/lib/extension-activation-generation";

beforeEach(() => {
  buildSpy.mockClear();
  __resetHostSelfPrimitiveHandlers();
  __resetActivationGenerationForTests();
});

describe("self-MCP handler cache keyed by control-plane generation", () => {
  it("builds the handler map ONCE while the generation is unchanged", async () => {
    await callHostPrimitive("echo_primitive", { a: 1 });
    await callHostPrimitive("echo_primitive", { a: 2 });
    await callHostPrimitive("echo_primitive", { a: 3 });
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("REBUILDS the handler map after the generation is bumped (a lifecycle transition)", async () => {
    await callHostPrimitive("echo_primitive", { a: 1 });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // A lifecycle transition (e.g. an activate) bumps the generation.
    bumpActivationGeneration("activate", "@cinatra-ai/foo");

    await callHostPrimitive("echo_primitive", { a: 2 });
    expect(buildSpy).toHaveBeenCalledTimes(2);

    // No further transition → no further rebuild.
    await callHostPrimitive("echo_primitive", { a: 3 });
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("returns the primitive's structuredContent through the cached handler", async () => {
    const out = await callHostPrimitive("echo_primitive", { hello: "world" });
    expect(out).toEqual({ hello: "world" });
  });
});

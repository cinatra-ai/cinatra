import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The in-process self-invocation hands the boundary the outward declaration of
// the captured primitive's planned entry (cinatra#3745): a primitive planned
// with an outward declaration reaches `enforceMcpBoundary` with
// `declaresOutward: true`, and a primitive planned without one proceeds as
// before. The host's primitive map, the request-context store and the boundary
// are replaced here; `callHostPrimitive` itself is the real one. Every
// replacement is lifted after the file's cases.

const hoisted = vi.hoisted(() => ({
  boundary: vi.fn<(request: Record<string, unknown>) => Promise<{ allowed: boolean }>>(async () => ({
    allowed: true,
  })),
  frame: { orgId: "org-1", userId: "user-1", runId: "run-1" } as Record<string, unknown>,
}));

function planned(name: string, declaredOutward: { subject: null } | null) {
  return {
    name,
    registeredName: name,
    order: 0,
    declaredClass: undefined,
    declarationMalformed: false,
    declaredOutward,
    ownerPackage: "@example-org/host",
    resolvedVersion: "1.0.0",
    capabilityKey: null,
    dispatchTarget: { kind: "host", packageName: "@example-org/host", version: "1.0.0", name },
    identityFailure: null,
    reserved: false,
  };
}

vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: () =>
    new Map<string, { handler: (...args: unknown[]) => unknown; planned: unknown }>([
      [
        "example_outward_tool",
        { handler: (input: unknown) => ({ structuredContent: input }), planned: planned("example_outward_tool", { subject: null }) },
      ],
      [
        "example_plain_tool",
        { handler: (input: unknown) => ({ structuredContent: input }), planned: planned("example_plain_tool", null) },
      ],
    ]),
}));

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    getStore: () => hoisted.frame,
    run: (_ctx: unknown, fn: () => unknown) => fn(),
  },
}));

vi.mock("@/lib/authz/mcp-boundary", () => ({
  enforceMcpBoundary: hoisted.boundary,
}));

import { callHostPrimitive, __resetHostSelfPrimitiveHandlers } from "@/lib/extension-self-mcp";

beforeEach(() => {
  hoisted.boundary.mockClear();
  __resetHostSelfPrimitiveHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  __resetHostSelfPrimitiveHandlers();
  vi.doUnmock("@/lib/mcp-server");
  vi.doUnmock("@cinatra-ai/mcp-server");
  vi.doUnmock("@/lib/authz/mcp-boundary");
  vi.resetModules();
});

describe("the in-process self-invocation hands the boundary the planned outward declaration", () => {
  it("hands the boundary declaresOutward true for a primitive planned with an outward declaration", async () => {
    await callHostPrimitive("example_outward_tool", { a: 1 });
    expect(hoisted.boundary).toHaveBeenCalledTimes(1);
    expect(hoisted.boundary).toHaveBeenCalledWith(
      expect.objectContaining({ primitiveName: "example_outward_tool", declaresOutward: true }),
    );
  });

  it("proceeds as before for a primitive planned without an outward declaration", async () => {
    const out = await callHostPrimitive("example_plain_tool", { a: 2 });
    expect(out).toEqual({ a: 2 });
    expect(hoisted.boundary).toHaveBeenCalledTimes(1);
    const request = hoisted.boundary.mock.calls[0]?.[0];
    expect(request?.primitiveName).toBe("example_plain_tool");
    expect(request?.declaresOutward).not.toBe(true);
  });
});

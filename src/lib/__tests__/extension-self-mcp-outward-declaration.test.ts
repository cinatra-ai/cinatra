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
  // The caller's edge to an extension package (the real resolution reads the run's dependency edges).
  edge: { kind: "none" } as Record<string, unknown>,
  resolve: vi.fn(),
  dispatch: vi.fn(),
  captured: vi.fn(),
}));

type Subject = { artifactId: string; representationRevisionId: string };
type Owner = { kind: "host" | "extension-default" | "extension-versioned"; packageName: string; version: string };
const HOST_OWNER: Owner = { kind: "host", packageName: "@example-org/host", version: "1.0.0" };
const PACKAGE = "@example-org/outreach";
const DEFAULT_A: Owner = { kind: "extension-default", packageName: PACKAGE, version: "1.0.0" };
const RETAINED_B: Owner = { kind: "extension-versioned", packageName: PACKAGE, version: "2.0.0" };
const SUBJECT_FIELDS: Subject = { artifactId: "postId", representationRevisionId: "postRevision" };

function planned(name: string, declaredOutward: { subject: Subject | null } | null, owner: Owner = HOST_OWNER) {
  return {
    name,
    registeredName: name,
    order: 0,
    declaredClass: undefined,
    declarationMalformed: false,
    declaredOutward,
    ownerPackage: owner.packageName,
    resolvedVersion: owner.version,
    capabilityKey: null,
    dispatchTarget: { ...owner, name },
    identityFailure: null,
    reserved: false,
  };
}

const capturedEntry = (name: string, declaredOutward: { subject: Subject | null } | null, owner?: Owner) => ({
  handler: (input: unknown) => { hoisted.captured(name); return { structuredContent: input }; },
  planned: planned(name, declaredOutward, owner),
});

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
      // The union winner of a name that version A (the default) and version B (retained) both register: A's entry,
      // which declares nothing outward.
      ["example_shared_tool", capturedEntry("example_shared_tool", null, DEFAULT_A)],
      // The default version's outward tool, with its subject fields.
      ["example_default_outward", capturedEntry("example_default_outward", { subject: SUBJECT_FIELDS }, DEFAULT_A)],
      // A name only the retained version B registers, declared outward.
      ["example_retained_outward", capturedEntry("example_retained_outward", { subject: null }, RETAINED_B)],
    ]),
}));

vi.mock("@/lib/extension-edge-bound-serving", () => ({
  resolveEdgeBoundExtensionVersion: (...args: unknown[]) => hoisted.resolve(...args),
}));

vi.mock("@/lib/extension-authorized-dispatch", () => ({
  dispatchAuthorizedExtensionPrimitive: (...args: unknown[]) => hoisted.dispatch(...args),
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
  hoisted.edge = { kind: "none" };
  hoisted.resolve.mockReset().mockImplementation(async () => hoisted.edge);
  hoisted.dispatch.mockReset().mockImplementation(async (_target: unknown, input: unknown) => ({ structuredContent: input }));
  hoisted.captured.mockReset();
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
  vi.doUnmock("@/lib/extension-edge-bound-serving");
  vi.doUnmock("@/lib/extension-authorized-dispatch");
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

  // cinatra#3745: a call on a run frame is the inner call of the step's offered tool, which the boundary refuses when it
  // is outward; it names no owner, so it can never take the guarded outward run action and use the person's decision.
  it("marks a run frame's call as an inner call and names no owner for the guarded outward run action", async () => {
    await callHostPrimitive("example_outward_tool", { a: 3 });
    expect(hoisted.boundary).toHaveBeenCalledTimes(1);
    const request = hoisted.boundary.mock.calls[0]?.[0];
    // red-first-expect: expected undefined to be true
    expect(request?.innerRunCall).toBe(true);
    expect(request).not.toHaveProperty("outwardOwner");
  });

  it("off a run frame, the call is no inner call", async () => {
    const saved = hoisted.frame;
    hoisted.frame = { orgId: "org-1", userId: "user-1" };
    try {
      await callHostPrimitive("example_plain_tool", { a: 8 });
    } finally {
      hoisted.frame = saved;
    }
    expect(hoisted.boundary.mock.calls[0]?.[0]).not.toHaveProperty("innerRunCall");
  });
});

// cinatra#3745: on a run frame the boundary reads the outward declaration of the version that will actually execute for
// this caller. The caller's edge is resolved first; the captured entry is used only when it is that version's
// registration, and the call is then dispatched pinned to it. When it is not, the call is refused.
describe("on a run frame, the declaration is that of the version that executes", () => {
  it("refuses, before the boundary and the handler, a call whose run pins a version the union entry does not describe", async () => {
    // Version A's entry declares nothing outward; the run pins retained version B.
    hoisted.edge = { kind: "versioned", version: "2.0.0", resolvedInstallId: "install-b" };
    const error = await callHostPrimitive("example_shared_tool", { a: 4 }).catch((e: unknown) => e);
    // red-first-expect: expected { a: 4 } to match object { code: 'action_owner_unresolved' }
    expect(error).toMatchObject({ code: "action_owner_unresolved" });
    expect(hoisted.boundary).not.toHaveBeenCalled();
    expect(hoisted.captured).not.toHaveBeenCalled();
    expect(hoisted.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a retained version's entry when the run pins another version", async () => {
    hoisted.edge = { kind: "versioned", version: "3.0.0", resolvedInstallId: "install-c" };
    const error = await callHostPrimitive("example_retained_outward", { a: 5 }).catch((e: unknown) => e);
    // red-first-expect: expected { a: 5 } to match object { code: 'action_owner_unresolved' }
    expect(error).toMatchObject({ code: "action_owner_unresolved" });
    expect(hoisted.boundary).not.toHaveBeenCalled();
    expect(hoisted.dispatch).not.toHaveBeenCalled();
  });

  it("hands the boundary the retained version's own declaration, and dispatches pinned to that version", async () => {
    hoisted.edge = { kind: "versioned", version: "2.0.0", resolvedInstallId: "install-b" };
    const out = await callHostPrimitive("example_retained_outward", { a: 6 });
    expect(out).toEqual({ a: 6 });
    const request = hoisted.boundary.mock.calls[0]?.[0];
    // red-first-expect: expected { …(4) } to match object { declaresOutward: true, …(1) }
    expect(request).toMatchObject({ declaresOutward: true, innerRunCall: true });
    expect(hoisted.dispatch).toHaveBeenCalledTimes(1);
    expect(hoisted.dispatch.mock.calls[0]?.[0]).toEqual({ ...RETAINED_B, name: "example_retained_outward" });
    expect(hoisted.captured).not.toHaveBeenCalled();
  });

  it("hands the boundary the default version's declaration, pinned to it", async () => {
    await callHostPrimitive("example_default_outward", { postId: "artifact-1", postRevision: "revision-1" });
    const request = hoisted.boundary.mock.calls[0]?.[0];
    // red-first-expect: expected { …(4) } to match object { declaresOutward: true, …(1) }
    expect(request).toMatchObject({ declaresOutward: true, innerRunCall: true });
    expect(hoisted.dispatch.mock.calls[0]?.[0]).toEqual({ ...DEFAULT_A, name: "example_default_outward" });
    expect(hoisted.captured).not.toHaveBeenCalled();
  });

  it("off a run frame, an unrestricted call keeps the captured wrapper and resolves no edge here", async () => {
    const saved = hoisted.frame;
    hoisted.frame = { orgId: "org-1", userId: "user-1" };
    try {
      await callHostPrimitive("example_shared_tool", { a: 7 });
    } finally {
      hoisted.frame = saved;
    }
    expect(hoisted.resolve).not.toHaveBeenCalled();
    expect(hoisted.captured).toHaveBeenCalledWith("example_shared_tool");
    expect(hoisted.dispatch).not.toHaveBeenCalled();
  });
});

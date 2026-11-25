// ---------------------------------------------------------------------------
// THE PINNED DISPATCH (cinatra#2817 slice 3).
//
// A delegated-restricted self-invocation authorizes an EXACT identity — one
// package at one resolved version — and then has to actually run THAT. The
// captured wrapper it used to run is drift-tolerant on purpose, so an
// activation landing between the decision and the call could execute a version
// the admission never covered.
//
// Two ways that can happen, and both are pinned below:
//   · the caller's EDGE re-resolves to a pin (caught inside
//     `dispatchPlannedExtensionMcpTool`, which refuses on plan drift);
//   · the DEFAULT registration is replaced in place by a hot update, so the
//     name now resolves to a different version while the edge stays unpinned.
//     Nothing downstream compares versions in that case, so this module does.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const listed: { packageName: string; name: string; resolvedVersion: string | null; handler: () => unknown }[] = [];
const planned: unknown[] = [];

vi.mock("@/lib/extension-mcp-registry", () => ({
  listExtensionMcpTools: () => listed,
  UNRESOLVED_EXTENSION_VERSION: "0.0.0-unresolved",
}));
vi.mock("@/lib/extension-edge-bound-serving", () => ({
  dispatchPlannedExtensionMcpTool: async (p: unknown) => {
    planned.push(p);
    return { ok: true };
  },
  dispatchExtensionMcpToolEdgeBound: async () => ({ ok: true }),
  dispatchVersionedOnlyExtensionMcpTool: async () => ({ ok: true }),
  planExtensionToolDiscovery: async () => ({ register: [], skipped: [] }),
  planSelfInvokerRetainedUnion: () => ({ register: [], dedupedExtensionNames: [] }),
  // The result envelope moved into this module so
  // `src/lib/mcp-server.ts` stops reaching the pinned-dispatch graph for one
  // pure function. This suite mocks the module wholesale, so the envelope has
  // to be restated here. These tests never inspect the envelope (they assert
  // the PLANNED dispatch and the drift refusals), so this only has to exist and
  // match the production shape.
  wrapExtensionToolResult: (raw: unknown) => {
    const resolved = raw === undefined ? null : raw;
    return {
      content: [{ type: "text", text: JSON.stringify(resolved) }],
      structuredContent: Array.isArray(resolved)
        ? { items: resolved }
        : typeof resolved === "object" && resolved !== null
          ? (resolved as Record<string, unknown>)
          : { result: resolved },
    };
  },
}));

const PKG = "@cinatra-ai/acme";

describe("dispatchAuthorizedExtensionPrimitive", () => {
  beforeEach(() => {
    listed.length = 0;
    planned.length = 0;
  });

  const registration = (resolvedVersion: string | null, tag = "a") => ({
    packageName: PKG, name: "acme_thing_list", resolvedVersion, handler: () => tag,
  });

  it("dispatches a VERSIONED identity through the drift-refusing planned dispatch, with the authorized entry", async () => {
    const authorized = registration("2.4.0");
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await dispatchAuthorizedExtensionPrimitive(
      { kind: "extension-versioned", packageName: PKG, version: "2.4.0", name: "acme_thing_list",
        registration: authorized },
      {},
    );
    // The AUTHORIZED version and entry are carried in, not re-derived — that is what makes
    // the downstream drift check a check and not a re-decision.
    expect(planned).toEqual([
      { expected: "versioned", packageName: PKG, name: "acme_thing_list", version: "2.4.0", registration: authorized },
    ]);
    expect((planned[0] as { registration: unknown }).registration).toBe(authorized);
  });

  it("REFUSES when the authorized DEFAULT registration resolves to another version than the target", async () => {
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await expect(
      dispatchAuthorizedExtensionPrimitive(
        { kind: "extension-default", packageName: PKG, version: "2.4.0", name: "acme_thing_list",
          registration: registration("2.5.0") },
        {},
      ),
    ).rejects.toThrow(/admitted at .*2\.4\.0 but the default registration now resolves to 2\.5\.0/);
    expect(planned).toEqual([]); // refused BEFORE anything could run
  });

  // cinatra#3745: the registration that was authorized is the one that runs; a same-version replacement in the
  // registry is never looked up.
  it("dispatches the authorized DEFAULT registration, never a same-version replacement in the registry", async () => {
    const authorized = registration("2.4.0", "a");
    listed.push(registration("2.4.0", "b"));
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await dispatchAuthorizedExtensionPrimitive(
      { kind: "extension-default", packageName: PKG, version: "2.4.0", name: "acme_thing_list", registration: authorized },
      {},
    );
    expect(planned).toHaveLength(1);
    // red-first-expect: expected { …(4) } to be { …(4) }
    expect((planned[0] as { tool: unknown }).tool).toBe(authorized);
  });

  it("REFUSES a target that carries no authorized registration (it never looks one up)", async () => {
    listed.push(registration("2.4.0"));
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await expect(
      dispatchAuthorizedExtensionPrimitive(
        { kind: "extension-default", packageName: PKG, version: "2.4.0", name: "acme_thing_list" },
        {},
      ),
    ).rejects.toThrow(/carries no authorized registration/);
    expect(planned).toEqual([]);
  });
});

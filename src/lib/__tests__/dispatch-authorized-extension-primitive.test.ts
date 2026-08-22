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
}));

const PKG = "@cinatra-ai/acme";

describe("dispatchAuthorizedExtensionPrimitive", () => {
  beforeEach(() => {
    listed.length = 0;
    planned.length = 0;
  });

  it("dispatches a VERSIONED identity through the drift-refusing planned dispatch", async () => {
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await dispatchAuthorizedExtensionPrimitive(
      { kind: "extension-versioned", packageName: PKG, version: "2.4.0", name: "acme_thing_list" },
      {},
    );
    // The AUTHORIZED version is carried in, not re-derived — that is what makes
    // the downstream drift check a check and not a re-decision.
    expect(planned).toEqual([
      { expected: "versioned", packageName: PKG, name: "acme_thing_list", version: "2.4.0" },
    ]);
  });

  it("REFUSES when the DEFAULT registration moved to another version", async () => {
    // Authorized at 2.4.0; a hot update replaced the default with 2.5.0 under
    // the same name. The edge is still unpinned, so nothing else would notice.
    listed.push({ packageName: PKG, name: "acme_thing_list", resolvedVersion: "2.5.0", handler: () => null });
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await expect(
      dispatchAuthorizedExtensionPrimitive(
        { kind: "extension-default", packageName: PKG, version: "2.4.0", name: "acme_thing_list" },
        {},
      ),
    ).rejects.toThrow(/admitted at .*2\.4\.0 but the default registration now resolves to 2\.5\.0/);
    expect(planned).toEqual([]); // refused BEFORE anything could run
  });

  it("dispatches the DEFAULT when the version still matches", async () => {
    listed.push({ packageName: PKG, name: "acme_thing_list", resolvedVersion: "2.4.0", handler: () => null });
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await dispatchAuthorizedExtensionPrimitive(
      { kind: "extension-default", packageName: PKG, version: "2.4.0", name: "acme_thing_list" },
      {},
    );
    expect(planned).toHaveLength(1);
  });

  it("REFUSES when the default registration is gone entirely", async () => {
    const { dispatchAuthorizedExtensionPrimitive } = await import("@/lib/extension-authorized-dispatch");
    await expect(
      dispatchAuthorizedExtensionPrimitive(
        { kind: "extension-default", packageName: PKG, version: "2.4.0", name: "acme_thing_list" },
        {},
      ),
    ).rejects.toThrow(/no longer registered/);
  });
});

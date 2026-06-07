import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Golden conformance test for the true-IoC discovery contract.
//
// CANONICAL RUNTIME CONTRACT. This test IS the executable definition of the
// runtime half of "extensible" (the structural half = the three scripts/audit
// ratchet gates: import-ban, instance-coupling-ban, discovery-bypass-ban). See
// https://docs.cinatra.ai/references/platform/extension-ioc-safeguards/.
//
// This is THE template every extension kind must satisfy. It exercises the
// full vertical through the PUBLIC host dispatcher
// (`discoverActiveExtensionCapabilities`) — the coarse lifecycle gate
// (`installed_extension` via `listInstalledExtensions`) + a conformant per-kind
// reader facet — across the install -> archive/uninstall LIFECYCLE, and locks
// the two guarantees that make the system genuinely install/uninstall-aware:
//
//   1. Lifecycle suppression (split-brain guard): when the gate stops reporting
//      a package live (archive/uninstall), the capability DISAPPEARS from
//      discovery EVEN IF the per-kind native store would still return its row.
//      The gate is the lifecycle authority; a stale native read can never
//      re-expose an uninstalled capability.
//   2. Visibility authority: the per-kind reader owns "may this actor see this
//      row?". A package the gate reports live but the reader's scoped native
//      read excludes is NOT discovered. Discovery is the INTERSECTION of the two.
//
// Per-kind readers each have their OWN intersection unit test (agent:
// `packages/agents/src/__tests__/extension-handler-list-active.test.ts`). This
// golden test is kind-agnostic: it uses an `agent` fixture + a reader that
// faithfully implements the documented `visibleNativeRows(scope) ∩ manifests`
// contract, so it pins the dispatcher-level lifecycle behavior every conformant
// kind inherits — without dragging the real handler's server-only/@/lib/fs
// transitive imports into the extensions package test context.
// ---------------------------------------------------------------------------

// index.ts (extensionRegistry) transitively imports @cinatra-ai/agents — stub it
// (same reason as runtime-discovery-host.test.ts) so the registry loads with no
// real infra. The golden reader below is registered explicitly; we do not use
// the real agent handler here (its intersection is unit-tested separately).
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
}));

// The host wiring reads the canonical store — mock it to drive the lifecycle gate.
vi.mock("../canonical-store", () => ({
  listInstalledExtensions: vi.fn(),
}));

import { extensionRegistry } from "../index";
import { listInstalledExtensions } from "../canonical-store";
import { discoverActiveExtensionCapabilities } from "../runtime-discovery-host";
import type { ExtensionTypeHandler } from "@cinatra-ai/extension-types";

const actor = { actorType: "human", source: "route" } as never;
function scopeWith(vendorScope: string | null) {
  return { userId: "u1", organizationId: null, teamIds: [], vendorScope } as never;
}

// A canonical-store row (the coarse lifecycle gate input). `status` drives the
// lifecycle; only active|locked rows are live candidates.
function row(over: Record<string, unknown>) {
  return {
    id: over.id,
    packageName: over.packageName ?? `@x/${over.id}`,
    ownerLevel: over.ownerLevel ?? "platform",
    ownerId: over.ownerId ?? null,
    organizationId: over.organizationId ?? null,
    kind: over.kind ?? "agent",
    status: over.status ?? "active",
    source: {},
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// A CONFORMANT agent-shaped reader. It mirrors the real agent handler's
// contract exactly: ask the (controllable) visibility-correct native store for
// the rows this actor's scope may see, then keep ONLY those whose package is
// lifecycle-live per the dispatcher's `manifests`. The two failure modes this
// guards — over-exposure (reading another owner's row by package name) and
// under-exposure (dropping private/vendor rows) — are the same the agent reader
// guards. `nativeVisibleRows` is the test's stand-in for
// `readActiveExtensionTemplates(scope.vendorScope)`.
// ---------------------------------------------------------------------------
let nativeVisibleRows: (vendorScope: string | null) => Array<{ packageName: string }> = () => [];

const conformantAgentReader: ExtensionTypeHandler = {
  typeId: "agent",
  install: vi.fn(),
  update: vi.fn(),
  uninstall: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  async listActive({ scope, manifests }) {
    const livePackageNames = new Set(manifests.map((m) => m.packageName));
    const visible = nativeVisibleRows((scope as { vendorScope: string | null }).vendorScope);
    return visible.filter((r) => livePackageNames.has(r.packageName));
  },
};

function names(byKind: Record<string, unknown[]>): string[] {
  return (byKind.agent ?? [])
    .map((d) => (d as { packageName: string }).packageName)
    .sort();
}

describe("golden extension-discovery conformance (true-IoC contract template)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nativeVisibleRows = () => [];
    extensionRegistry.registerIfAbsent(conformantAgentReader);
  });
  afterEach(() => vi.resetAllMocks());

  it("INSTALLED + native-visible -> discovered PRESENT", async () => {
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/alpha", status: "active" }),
    ] as never);
    nativeVisibleRows = () => [{ packageName: "@x/alpha" }];

    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(res.byKind)).toEqual(["@x/alpha"]);
    expect(res.all).toHaveLength(1);
    expect(res.unmigratedKinds).toEqual([]);
  });

  it("ARCHIVE -> discovered ABSENT even though the native store still returns the row (split-brain guard)", async () => {
    // Gate no longer reports it live (archived), but the native visibility read
    // is STALE and still returns it. Discovery must suppress it: the lifecycle
    // gate wins. This is the core uninstall-awareness guarantee.
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/alpha", status: "archived" }),
    ] as never);
    nativeVisibleRows = () => [{ packageName: "@x/alpha" }]; // stale native authority

    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(res.byKind)).toEqual([]);
    expect(res.all).toHaveLength(0);
  });

  it("UNINSTALL (row deleted -> no rows at all) -> discovered ABSENT even with a stale native read", async () => {
    // The most faithful uninstall fixture: the installed_extension row is gone
    // entirely. A stale native read still returns it; discovery must suppress it.
    vi.mocked(listInstalledExtensions).mockResolvedValue([] as never);
    nativeVisibleRows = () => [{ packageName: "@x/alpha" }];

    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(res.byKind)).toEqual([]);
  });

  it("a tombstoned 'uninstalled' status row (not yet purged) is ALSO absent", async () => {
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/alpha", status: "uninstalled" }),
    ] as never);
    nativeVisibleRows = () => [{ packageName: "@x/alpha" }];

    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(res.byKind)).toEqual([]);
  });

  it("LOCKED is a discoverable status: a locked (e.g. required-in-prod) package IS discovered", async () => {
    // The gate's discoverable set is {active, locked}. A locked package — pinned
    // by an admin / required in prod — must still surface; locked blocks
    // archive/uninstall, not discovery.
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/locked-agent", status: "locked" }),
    ] as never);
    nativeVisibleRows = () => [{ packageName: "@x/locked-agent" }];

    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(res.byKind)).toEqual(["@x/locked-agent"]);
  });

  it("full lifecycle on ONE fixture: active -> present, then archived -> absent", async () => {
    nativeVisibleRows = () => [{ packageName: "@x/alpha" }];

    vi.mocked(listInstalledExtensions).mockResolvedValueOnce([
      row({ id: "a", packageName: "@x/alpha", status: "active" }),
    ] as never);
    const live = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(live.byKind)).toEqual(["@x/alpha"]);

    vi.mocked(listInstalledExtensions).mockResolvedValueOnce([
      row({ id: "a", packageName: "@x/alpha", status: "archived" }),
    ] as never);
    const gone = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(gone.byKind)).toEqual([]);
  });

  it("VISIBILITY AUTHORITY: gate reports live but the scoped native read excludes it -> ABSENT", async () => {
    // The package is lifecycle-live, but the reader's visibility-correct native
    // read returns nothing for this actor's scope (e.g. a private vendor row the
    // actor may not see). The reader is the visibility authority -> not discovered.
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "p", packageName: "@private/vendor-agent", status: "active" }),
    ] as never);
    nativeVisibleRows = (vendorScope) =>
      vendorScope === "@private" ? [{ packageName: "@private/vendor-agent" }] : [];

    const denied = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null), // no vendor scope -> cannot see the private row
    });
    expect(names(denied.byKind)).toEqual([]);

    const allowed = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith("@private"), // vendor scope grants visibility
    });
    expect(names(allowed.byKind)).toEqual(["@private/vendor-agent"]);
  });

  it("NO over-exposure: a native row the gate does NOT report live is excluded (intersection, not union)", async () => {
    // The native read leaks an extra package the actor could technically see,
    // but it is not in the live manifest set -> the intersection drops it. This
    // is the guard against reading another owner's row by package name.
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/alpha", status: "active" }),
    ] as never);
    nativeVisibleRows = () => [
      { packageName: "@x/alpha" },
      { packageName: "@x/not-installed-here" },
    ];

    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    expect(names(res.byKind)).toEqual(["@x/alpha"]);
  });

  it("UNMIGRATED kind: a live manifest whose kind has no reader facet contributes nothing and is recorded", async () => {
    // Discover across ALL kinds (no kind filter). The gate reports a `workflow`
    // package live, but no workflow reader is registered in this test -> it is
    // recorded in unmigratedKinds, never silently dropped or crashed.
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/alpha", kind: "agent", status: "active" }),
      row({ id: "w", packageName: "@x/flow", kind: "workflow", status: "active" }),
    ] as never);
    nativeVisibleRows = () => [{ packageName: "@x/alpha" }];

    const res = await discoverActiveExtensionCapabilities({ actor, scope: scopeWith(null) });
    expect(names(res.byKind)).toEqual(["@x/alpha"]);
    expect(res.unmigratedKinds).toContain("workflow");
    expect(res.unmigratedKinds).not.toContain("agent");
  });

  it("a reader that THROWS is isolated: that kind yields [] and discovery does not crash", async () => {
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/alpha", status: "active" }),
    ] as never);
    nativeVisibleRows = () => {
      throw new Error("native read blew up");
    };

    const errors: Array<{ kind: string }> = [];
    const res = await discoverActiveExtensionCapabilities({
      kind: "agent",
      actor,
      scope: scopeWith(null),
    });
    // discoverActiveExtensionCapabilities swallows reader errors into [] (the
    // dispatcher's onError is optional and not wired by the host entry); the
    // contract is "never crash discovery for one bad kind".
    expect(res.byKind.agent ?? []).toEqual([]);
    expect(res.all).toEqual([]);
    void errors;
  });
});

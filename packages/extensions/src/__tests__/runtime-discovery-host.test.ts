import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// index.ts (extensionRegistry) transitively imports @cinatra-ai/agents — mock it
// like registry.test.ts so the registry loads without real infra.
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
}));

// The host wiring reads the canonical store — mock it to control the manifest set.
vi.mock("../canonical-store", () => ({
  listInstalledExtensions: vi.fn(),
}));

import { extensionRegistry } from "../index";
import { listInstalledExtensions } from "../canonical-store";
import {
  readActiveManifestsFromStore,
  discoverActiveExtensionCapabilities,
} from "../runtime-discovery-host";
import type { ExtensionTypeHandler } from "@cinatra-ai/extension-types";

const actor = { actorType: "human", source: "route" } as never;
const scope = { userId: "u1", organizationId: null, teamIds: [], vendorScope: null } as never;

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

describe("readActiveManifestsFromStore (coarse lifecycle status-candidate gate)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns one live candidate per (kind, packageName); excludes archived/uninstalled-only", async () => {
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "1", packageName: "@x/a", status: "active" }),
      row({ id: "2", packageName: "@x/b", status: "locked" }),
      row({ id: "3", packageName: "@x/c", status: "archived" }),
      row({ id: "4", packageName: "@x/d", status: "uninstalled" }),
    ] as never);
    const out = await readActiveManifestsFromStore({ kind: "agent" });
    expect(out.map((m) => m.packageName).sort()).toEqual(["@x/a", "@x/b"]);
  });

  it("SURFACES every distinct owner identity of the same package (no cross-owner hiding)", async () => {
    // Two DISTINCT install identities (platform vs org) of the same package must
    // BOTH survive the coarse gate so the per-kind reader can OR owner visibility
    // across them — collapsing to one row would let an out-of-scope install hide
    // an in-scope one.
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "plat", packageName: "@x/shared", ownerLevel: "platform", ownerId: "__platform__", organizationId: null, status: "active" }),
      row({ id: "org", packageName: "@x/shared", ownerLevel: "organization", ownerId: null, organizationId: "org-1", status: "active" }),
    ] as never);
    const out = await readActiveManifestsFromStore({ kind: "agent" });
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.ownerLevel).sort()).toEqual(["organization", "platform"]);
  });

  it("collapses rows of the SAME install identity to one (active wins over locked)", async () => {
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a", packageName: "@x/shared", ownerLevel: "platform", ownerId: "__platform__", organizationId: null, status: "locked" }),
      row({ id: "b", packageName: "@x/shared", ownerLevel: "platform", ownerId: "__platform__", organizationId: null, status: "active" }),
    ] as never);
    const out = await readActiveManifestsFromStore({ kind: "agent" });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("active");
  });

  it("returns [] for an unknown/invalid kind (no unfiltered scan)", async () => {
    const out = await readActiveManifestsFromStore({ kind: "not-a-kind" });
    expect(out).toEqual([]);
    expect(listInstalledExtensions).not.toHaveBeenCalled();
  });
});

describe("discoverActiveExtensionCapabilities", () => {
  // The reader facet is the visibility authority — it receives the scope.
  const seenScopes: unknown[] = [];
  const handler: ExtensionTypeHandler = {
    typeId: "agent",
    install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
    async listActive({ scope: s, manifests }) {
      seenScopes.push(s);
      return manifests.map((m) => ({ template: m.packageName }));
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    seenScopes.length = 0;
    extensionRegistry.registerIfAbsent(handler);
  });
  afterEach(() => vi.resetAllMocks());

  it("reads live candidates, threads the SCOPE to the reader facet, and dispatches", async () => {
    vi.mocked(listInstalledExtensions).mockResolvedValue([
      row({ id: "a1", packageName: "@x/a1", status: "active" }),
    ] as never);
    const res = await discoverActiveExtensionCapabilities({ kind: "agent", actor, scope });
    expect(res.byKind.agent).toEqual([{ template: "@x/a1" }]);
    expect(res.unmigratedKinds).toEqual([]);
    expect(seenScopes).toEqual([scope]); // the reader received the resolved scope
  });
});

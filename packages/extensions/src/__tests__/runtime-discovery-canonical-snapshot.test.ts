// cinatra#2539 — the canonical snapshot seam.
//
// `installed_extension` is the SAME input for every reader in this module, so a
// caller that renders several of them in one request used to issue the
// identical full-table read once per reader. The installed-extension catalog
// did it FIVE times per render (one direct, one per coarse connector-manifest
// read, one inside each discovery dispatcher) — measured at ~1.3 s each on an
// 89-row instance, ~6.8 s of duplicated database work for one page.
//
// The contract these tests pin:
//   - a reader given `canonicalRows` performs NO store read at all,
//   - in-memory kind filtering returns exactly what the SQL predicate returned,
//   - omitting `canonicalRows` still reads the store (every existing call site
//     is unchanged).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
}));

vi.mock("../canonical-store", () => ({
  listInstalledExtensions: vi.fn(),
}));

import { listInstalledExtensions } from "../canonical-store";
import {
  readActiveManifestsFromStore,
  readArchivedManifestsFromStore,
  discoverActiveExtensionCapabilities,
  discoverArchivedExtensionCapabilities,
} from "../runtime-discovery-host";

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
    version: "1.0.0",
    isDefault: true,
    requiredInProd: false,
    dependencies: [],
    dependencyEdges: [],
    manifestHash: null,
    accessDeclaration: null,
    widgetAuthTokenKeys: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

const SNAPSHOT = [
  row({ id: "a1", kind: "agent", status: "active" }),
  row({ id: "c1", kind: "connector", status: "active" }),
  row({ id: "c2", kind: "connector", status: "archived" }),
  row({ id: "s1", kind: "skill", status: "archived" }),
];

const listInstalled = vi.mocked(listInstalledExtensions);

beforeEach(() => {
  listInstalled.mockReset();
});

describe("canonical snapshot threading (cinatra#2539)", () => {
  it("performs NO store read when the caller supplies the snapshot", async () => {
    await readActiveManifestsFromStore({ kind: "connector", canonicalRows: SNAPSHOT });
    await readArchivedManifestsFromStore({ kind: "connector", canonicalRows: SNAPSHOT });
    expect(listInstalled).not.toHaveBeenCalled();
  });

  it("still reads the store when no snapshot is supplied (existing call sites unchanged)", async () => {
    listInstalled.mockResolvedValue(SNAPSHOT as never);
    await readActiveManifestsFromStore({ kind: "connector" });
    expect(listInstalled).toHaveBeenCalledTimes(1);
    expect(listInstalled).toHaveBeenCalledWith({ kind: "connector" });
  });

  it("in-memory kind filtering equals the SQL-filtered read", async () => {
    // Arm A: the store applies the kind predicate (the pre-#2539 path).
    listInstalled.mockImplementation((async (filters: { kind?: string } = {}) =>
      filters.kind ? SNAPSHOT.filter((r) => (r as { kind: string }).kind === filters.kind) : SNAPSHOT) as never);
    const fromStore = await readActiveManifestsFromStore({ kind: "connector" });

    // Arm B: the caller passes the UNFILTERED snapshot and the reader filters.
    listInstalled.mockReset();
    const fromSnapshot = await readActiveManifestsFromStore({
      kind: "connector",
      canonicalRows: SNAPSHOT,
    });

    expect(fromSnapshot).toEqual(fromStore);
    expect(fromSnapshot.map((m) => m.id)).toEqual(["c1"]);
    expect(listInstalled).not.toHaveBeenCalled();
  });

  it("archived reads agree between the two arms too", async () => {
    listInstalled.mockImplementation((async (filters: { kind?: string } = {}) =>
      filters.kind ? SNAPSHOT.filter((r) => (r as { kind: string }).kind === filters.kind) : SNAPSHOT) as never);
    const fromStore = await readArchivedManifestsFromStore({ kind: "connector" });
    listInstalled.mockReset();
    const fromSnapshot = await readArchivedManifestsFromStore({
      kind: "connector",
      canonicalRows: SNAPSHOT,
    });
    expect(fromSnapshot).toEqual(fromStore);
    expect(fromSnapshot.map((m) => m.id)).toEqual(["c2"]);
  });

  it("the discovery dispatchers read the store ZERO times with a snapshot, once each without", async () => {
    // With the snapshot: the dispatcher's manifest read is snapshot-backed.
    await discoverActiveExtensionCapabilities({ actor, scope, canonicalRows: SNAPSHOT });
    await discoverArchivedExtensionCapabilities({ actor, scope, canonicalRows: SNAPSHOT });
    expect(listInstalled).not.toHaveBeenCalled();

    // Without it: one read per dispatcher — the duplication this seam removes.
    listInstalled.mockResolvedValue(SNAPSHOT as never);
    await discoverActiveExtensionCapabilities({ actor, scope });
    await discoverArchivedExtensionCapabilities({ actor, scope });
    expect(listInstalled).toHaveBeenCalledTimes(2);
  });

  it("does not hand the caller's array to a mutating reader", async () => {
    const snapshot = [...SNAPSHOT];
    await readActiveManifestsFromStore({ canonicalRows: snapshot });
    expect(snapshot).toEqual(SNAPSHOT);
  });
});

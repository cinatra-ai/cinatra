// cinatra#2694 / S4 (#2698, change 2) — SUPERSESSION ON INSTALL.
//
// The DB tier (src/lib/__tests__/install-semantics-lifecycle-row-identity
// .integration.test.ts) proves the happy path against a real Postgres: the
// organization row is archived IN PLACE and every column, edge and access row
// survives. What it cannot force is the FAILURE half — a store that refuses
// half-way through a multi-row supersession — so that is pinned here, with the
// canonical store's single writer replaced by a double that fails on the second
// row.
//
// The property under test is the one the slice text names: "compensate cleanly
// on failure (never leave a half-superseded state)". A caller must never be able
// to observe a package where SOME organizations lost their row and others kept
// theirs.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  packageName: string;
  ownerLevel: string;
  ownerId: string | null;
  organizationId: string | null;
  kind: string;
  status: string;
  source: unknown;
  requiredInProd: boolean;
  dependencies: unknown[];
};

const PKG = "@acme/widgets-connector";

function row(over: Partial<Row>): Row {
  return {
    id: "row-" + Math.random().toString(36).slice(2),
    packageName: PKG,
    ownerLevel: "organization",
    ownerId: "org-a",
    organizationId: "org-a",
    kind: "connector",
    status: "active",
    source: { type: "verdaccio", registryUrl: "r", packageName: PKG, version: "1.0.0", integrity: "sha512-x" },
    requiredInProd: false,
    dependencies: [],
    ...over,
  };
}

/** The in-memory canonical store the primitive writes through. */
const store = {
  rows: [] as Row[],
  /** Row ids whose status write must FAIL, simulating a store refusal. */
  failStatusWriteFor: new Set<string>(),
  statusWrites: [] as Array<{ id: string; status: string }>,
};

vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: vi.fn(async (id: string) => store.rows.find((r) => r.id === id) ?? null),
  readInstalledExtensionsByPackageName: vi.fn(async (name: string) =>
    store.rows.filter((r) => r.packageName === name),
  ),
  _internalUpdateInstalledExtensionStatus: vi.fn(async (id: string, status: string) => {
    store.statusWrites.push({ id, status });
    if (store.failStatusWriteFor.has(id)) {
      throw new Error(`simulated store refusal writing status for ${id}`);
    }
    const found = store.rows.find((r) => r.id === id);
    if (!found) throw new Error("missing row");
    found.status = status;
    return found;
  }),
  _internalDeleteInstalledExtension: vi.fn(async () => {}),
  _internalInsertInstalledExtension: vi.fn(async () => {}),
  _internalUpdateInstalledExtensionMetadata: vi.fn(async () => {}),
  _internalUpdateInstalledExtensionSource: vi.fn(async () => {}),
}));

vi.mock("../permissions-store", () => ({ deleteExtensionPermissions: vi.fn(async () => {}) }));

const ACTOR = { source: "dispatcher", userId: "u-2698" };

beforeEach(() => {
  store.rows = [];
  store.failStatusWriteFor = new Set();
  store.statusWrites = [];
  vi.clearAllMocks();
});

describe("cinatra#2698 — supersedeOrganizationRowsForWorkspaceInstall", () => {
  it("archives EVERY live organization row of the package, in place", async () => {
    const a = row({ organizationId: "org-a", ownerId: "org-a" });
    const b = row({ organizationId: "org-b", ownerId: "org-b" });
    const ws = row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null });
    store.rows = [a, b, ws];

    const { supersedeOrganizationRowsForWorkspaceInstall } = await import("../lifecycle-primitive");
    const archived = await supersedeOrganizationRowsForWorkspaceInstall(PKG, ACTOR);

    expect(new Set(archived)).toEqual(new Set([a.id, b.id]));
    expect(a.status).toBe("archived");
    expect(b.status).toBe("archived");
    // The workspace row is NOT touched — it is the row that supersedes.
    expect(ws.status).toBe("active");
  });

  it("leaves a package with no organization rows completely alone", async () => {
    const ws = row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null });
    store.rows = [ws];

    const { supersedeOrganizationRowsForWorkspaceInstall } = await import("../lifecycle-primitive");
    expect(await supersedeOrganizationRowsForWorkspaceInstall(PKG, ACTOR)).toEqual([]);
    expect(store.statusWrites).toEqual([]);
  });

  it("skips an ALREADY-ARCHIVED organization row (idempotent)", async () => {
    const already = row({ status: "archived" });
    store.rows = [already, row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null })];

    const { supersedeOrganizationRowsForWorkspaceInstall } = await import("../lifecycle-primitive");
    expect(await supersedeOrganizationRowsForWorkspaceInstall(PKG, ACTOR)).toEqual([]);
    expect(store.statusWrites).toEqual([]);
  });

  it("leaves a LOCKED organization row alone — the lock outranks the rewrite", async () => {
    const locked = row({ status: "locked" });
    store.rows = [locked, row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null })];

    const { supersedeOrganizationRowsForWorkspaceInstall } = await import("../lifecycle-primitive");
    expect(await supersedeOrganizationRowsForWorkspaceInstall(PKG, ACTOR)).toEqual([]);
    expect(locked.status).toBe("locked");
  });

  it("COMPENSATES on a mid-way failure — no package is left half-superseded", async () => {
    const a = row({ organizationId: "org-a", ownerId: "org-a" });
    const b = row({ organizationId: "org-b", ownerId: "org-b" });
    store.rows = [a, b, row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null })];
    // The SECOND row's archive refuses.
    store.failStatusWriteFor = new Set([b.id]);

    const { supersedeOrganizationRowsForWorkspaceInstall } = await import("../lifecycle-primitive");
    await expect(supersedeOrganizationRowsForWorkspaceInstall(PKG, ACTOR)).rejects.toMatchObject({
      code: "WORKSPACE_SUPERSESSION_FAILED",
      compensated: true,
    });

    // The first row was archived and then RESTORED by the compensation.
    expect(a.status).toBe("active");
    expect(b.status).toBe("active");
  });

});

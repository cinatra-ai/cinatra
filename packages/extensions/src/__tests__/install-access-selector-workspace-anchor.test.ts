// THE ACTION HOP of the write path (cinatra#2694 / S2 #2696) —
// `installExtensionPackageFormAction` at a WORKSPACE install target.
//
// Pinned here:
//   1. the action resolves S1's target→ownership CONTRACT and threads the tuple
//      into the dependency batch (the batch is what persists it);
//   2. the pre-install rollback-protection SNAPSHOT and the post-install access
//      write key on the CHOSEN ANCHOR's identity (owner_level='workspace',
//      organization_id NULL, owner_id='__platform__'), not the org identity that
//      was hard-coded before — an org-keyed read would see neither the row it
//      must protect nor the row it must write the policy against;
//   3. the persisted audience policy is `["workspace"]` / `["admin"]`;
//   4. a FAILED access write on a FRESH workspace-anchored install rolls back
//      exactly the row it created (the row-scoped inverse — the org-pinned
//      package uninstall cannot address an org-NULL row, and S4 #2698 owns that
//      resolver), while a PRE-EXISTING live row is never destroyed;
//   5. the ORGANIZATION target still takes the established package-scoped
//      uninstall — regression.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../handler-bootstrap", () => ({}));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (...a: unknown[]) => redirectMock(...a),
}));

vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: vi.fn(async () => null),
}));

const uninstallMock = vi.fn(async () => undefined);
vi.mock("../index", () => ({
  extensionRegistry: {
    install: vi.fn(),
    update: vi.fn(),
    uninstall: (...a: unknown[]) => uninstallMock(...(a as [])),
    archive: vi.fn(),
    restore: vi.fn(),
    forceDelete: vi.fn(),
  },
}));

vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../utils", () => ({
  deriveTypeId: vi.fn((k: string | null | undefined) => k ?? "agent"),
  resolveExtensionTypeId: vi.fn(async () => "artifact"),
  resolveExtensionPackageForLifecycle: vi.fn(async () => ({
    typeId: "artifact",
    resolvedVersion: "1.0.0",
  })),
}));

const SESSION = {
  user: { id: "admin-1", role: "admin" },
  session: { activeOrganizationId: "org-1" },
};
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => SESSION as unknown),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_owner" })),
  isPlatformAdmin: () => true,
}));

const installBatchMock = vi.fn(async (_input: Record<string, unknown>) => ({
  rootPackage: "@cinatra-ai/x",
  rootVersion: "1.0.0",
  installed: [] as unknown[],
  alreadyInstalled: [] as unknown[],
  batchId: null as string | null,
}));
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: (...a: unknown[]) =>
    installBatchMock(...(a as [Record<string, unknown>])),
}));

vi.mock("@cinatra-ai/agents/install-target-authz", () => ({
  readActorRolesForInstall: vi.fn(() => ({
    principalId: "admin-1",
    organizationId: "org-1",
    platformRole: "platform_admin",
    orgRole: "org_owner",
  })),
  assertTargetBelongsToActiveOrg: vi.fn(async () => ({})),
  assertCanInstallAtTarget: vi.fn(async () => undefined),
}));

// The WORKSPACE-anchored canonical row the install writes.
const WS_ROW = {
  id: "iext_ws123",
  kind: "artifact",
  status: "active",
  packageName: "@cinatra-ai/x",
  organizationId: null,
  ownerLevel: "workspace",
  ownerId: "__platform__",
};
const readRowMock = vi.fn(
  async (_identity: Record<string, unknown>) => WS_ROW as typeof WS_ROW | null,
);
const readRowsByNameMock = vi.fn(async () => [WS_ROW] as Array<typeof WS_ROW>);
vi.mock("../canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) =>
    readRowMock(...(a as [Record<string, unknown>])),
  readInstalledExtensionsByPackageName: (...a: unknown[]) => readRowsByNameMock(...(a as [])),
}));

const setAccessMock = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock("../install-access-contract", () => ({
  setExtensionInstallAccess: (...a: unknown[]) =>
    setAccessMock(...(a as [Record<string, unknown>])),
}));

const deleteScopedCanonicalRowMock = vi.fn(async (_rowId: string) => undefined);
vi.mock("../lifecycle-primitive", () => ({
  deleteScopedCanonicalRow: (...a: unknown[]) =>
    deleteScopedCanonicalRowMock(...(a as [string])),
}));

const resolveDeclaredProtectionMock = vi.fn(async (_pkg: string) => false);
vi.mock("../protected-extension", () => ({
  resolveDeclaredProtection: (...a: unknown[]) =>
    resolveDeclaredProtectionMock(...(a as [string])),
}));

const INPUT = { packageName: "@cinatra-ai/x", packageVersion: "1.0.0" };
const WORKSPACE_IDENTITY = {
  organizationId: null,
  ownerLevel: "workspace",
  ownerId: "__platform__",
  packageName: "@cinatra-ai/x",
};

async function runAction(input: Record<string, unknown>) {
  const { installExtensionPackageFormAction } = await import("../actions");
  return installExtensionPackageFormAction(
    input as Parameters<typeof installExtensionPackageFormAction>[0],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readRowMock.mockImplementation(async () => WS_ROW);
  readRowsByNameMock.mockResolvedValue([WS_ROW]);
  installBatchMock.mockResolvedValue({
    rootPackage: "@cinatra-ai/x",
    rootVersion: "1.0.0",
    installed: [],
    alreadyInstalled: [],
    batchId: null,
  });
  setAccessMock.mockResolvedValue(undefined);
  resolveDeclaredProtectionMock.mockResolvedValue(false);
});

describe("cinatra#2696 — a Workspace: All install threads the workspace anchor", () => {
  it("passes the WORKSPACE tuple to the dependency batch", async () => {
    await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(installBatchMock.mock.calls[0]![0]).toMatchObject({
      packageName: "@cinatra-ai/x",
      rowOwnership: {
        ownerLevel: "workspace",
        ownerId: "__platform__",
        organizationId: null,
      },
    });
  });

  it("keys the pre-install SNAPSHOT and the post-install row read on the WORKSPACE identity", async () => {
    await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(readRowMock).toHaveBeenCalledTimes(2); // pre-install snapshot + post-install resolve
    for (const call of readRowMock.mock.calls) {
      expect(call[0]).toEqual(WORKSPACE_IDENTITY);
    }
  });

  it('persists the ["workspace"] audience against the workspace-anchored row', async () => {
    await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(setAccessMock).toHaveBeenCalledWith({
      kind: "artifact",
      resourceId: "iext_ws123",
      policy: {
        runListVisibility: ["workspace"],
        runDataVisibility: ["workspace"],
        runExecuteVisibility: ["workspace"],
        allowRunSharing: false,
      },
      installedByUserId: "admin-1",
    });
    expect(redirectMock).toHaveBeenCalledWith("/configuration/extensions");
  });

  it('"Workspace: Admins only" behaves identically with the ["admin"] audience', async () => {
    await runAction({ ...INPUT, accessTarget: { level: "admin", id: "org-1" } });

    expect(installBatchMock.mock.calls[0]![0]).toMatchObject({
      rowOwnership: { ownerLevel: "workspace", organizationId: null },
    });
    expect(setAccessMock.mock.calls[0]![0]).toMatchObject({
      resourceId: "iext_ws123",
      policy: {
        runListVisibility: ["admin"],
        runDataVisibility: ["admin"],
        runExecuteVisibility: ["admin"],
        allowRunSharing: false,
      },
    });
  });
});

describe("cinatra#2696 — fail-closed rollback of a workspace-anchored install", () => {
  it("a FAILED access write on a FRESH install deletes exactly the row it created", async () => {
    // Pre-install snapshot: NO row. Post-install: the workspace row exists.
    let call = 0;
    readRowMock.mockImplementation(async () => (++call === 1 ? null : WS_ROW));
    setAccessMock.mockRejectedValue(new Error("policy write failed"));

    const res = await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(res).toEqual({ ok: false, category: "unrecoverable", stage: "access" });
    // The ROW-SCOPED inverse removed the created row…
    expect(deleteScopedCanonicalRowMock).toHaveBeenCalledWith("iext_ws123");
    // …and the org-pinned package uninstall was NEVER used (it cannot address
    // an org-NULL row; that resolver is S4 #2698).
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it("a PRE-EXISTING live workspace row is NEVER destroyed — access-partial instead", async () => {
    readRowMock.mockImplementation(async () => WS_ROW); // live row before AND after
    setAccessMock.mockRejectedValue(new Error("policy write failed"));

    const res = await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(res).toEqual({ ok: false, category: "unrecoverable", stage: "access-partial" });
    expect(deleteScopedCanonicalRowMock).not.toHaveBeenCalled();
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it("a PROTECTED package refuses the rollback and reports the partial state honestly", async () => {
    let call = 0;
    readRowMock.mockImplementation(async () => (++call === 1 ? null : WS_ROW));
    setAccessMock.mockRejectedValue(new Error("policy write failed"));
    resolveDeclaredProtectionMock.mockResolvedValue(true);

    const res = await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(res).toEqual({ ok: false, category: "unrecoverable", stage: "access-partial" });
    expect(deleteScopedCanonicalRowMock).not.toHaveBeenCalled();
  });

  it("an unreadable protection declaration is treated as PROTECTED (fail-closed)", async () => {
    let call = 0;
    readRowMock.mockImplementation(async () => (++call === 1 ? null : WS_ROW));
    setAccessMock.mockRejectedValue(new Error("policy write failed"));
    resolveDeclaredProtectionMock.mockRejectedValue(new Error("declaration unreadable"));

    const res = await runAction({ ...INPUT, accessTarget: { level: "workspace", id: "org-1" } });

    expect(res).toEqual({ ok: false, category: "unrecoverable", stage: "access-partial" });
    expect(deleteScopedCanonicalRowMock).not.toHaveBeenCalled();
  });
});

describe("cinatra#2696 — organization-target regression", () => {
  const ORG_ROW = {
    id: "iext_org123",
    kind: "artifact",
    status: "active",
    packageName: "@cinatra-ai/x",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: "org-1",
  };

  it("threads the ORG anchor, keys the org identity, and writes NO explicit policy", async () => {
    readRowMock.mockImplementation(async () => ORG_ROW as unknown as typeof WS_ROW);

    await runAction({ ...INPUT, accessTarget: { level: "organization", id: "org-1" } });

    expect(installBatchMock.mock.calls[0]![0]).toMatchObject({
      rowOwnership: { ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" },
    });
    expect(readRowMock.mock.calls[0]![0]).toEqual({
      organizationId: "org-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      packageName: "@cinatra-ai/x",
    });
    // organization target → the kind's install default (no explicit policy).
    expect(setAccessMock.mock.calls[0]![0]).toEqual({
      kind: "artifact",
      resourceId: "iext_org123",
      installedByUserId: "admin-1",
    });
  });

  it("an org-target rollback still takes the package-scoped uninstall (unchanged)", async () => {
    let call = 0;
    readRowMock.mockImplementation(async () =>
      ++call === 1 ? null : (ORG_ROW as unknown as typeof WS_ROW),
    );
    setAccessMock.mockRejectedValue(new Error("policy write failed"));

    const res = await runAction({ ...INPUT, accessTarget: { level: "organization", id: "org-1" } });

    expect(res).toEqual({ ok: false, category: "unrecoverable", stage: "access" });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(deleteScopedCanonicalRowMock).not.toHaveBeenCalled();
  });
});

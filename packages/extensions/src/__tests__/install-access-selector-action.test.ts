// installExtensionPackageFormAction — pre-install access selector contract
// (cinatra#805).
//
// Locks the action-level ordering + fail-safety:
//   1. no accessTarget → EXACTLY the legacy behavior (install, NO policy write)
//   2. organization target → setExtensionInstallAccess WITHOUT a policy
//      (per-kind default) + installer pointer
//   3. team target → policy scoped to team:<id>
//   4. authz deny → NOTHING installed (gate runs BEFORE any mutation)
//   5. kind gate → a non connector/artifact/workflow kind refuses BEFORE install
//   6. access-write failure on a FRESH install → compensating uninstall +
//      stage:"access" (fail-closed: never left at the broader default)
//   7. access-write failure with a PRE-EXISTING live install → NO uninstall +
//      stage:"access-partial"
//   8. access-write failure + rollback failure → stage:"access-partial"
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
// Keep the heavy handler-bootstrap barrel chain out of vitest (same pattern as
// promotion-action.test.ts).
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

// Per-package install lock (ALS re-entrant in production) — passthrough here,
// but CALLS are asserted: the install→access sequence must run under it so the
// pre-install snapshot cannot race a concurrent install of the same package.
const withInstallLockMock = vi.fn(
  async (_name: string, fn: () => Promise<unknown>) => fn(),
);
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: (...a: unknown[]) =>
    withInstallLockMock(...(a as [string, () => Promise<unknown>])),
}));

const resolveKindMock = vi.fn(async () => "connector");
vi.mock("../utils", () => ({
  deriveTypeId: vi.fn((k: string | null | undefined) => k ?? "agent"),
  resolveExtensionTypeId: (...a: unknown[]) => resolveKindMock(...(a as [])),
  resolveExtensionPackageForLifecycle: vi.fn(async () => ({
    typeId: "connector",
    resolvedVersion: "1.0.0",
  })),
}));

const SESSION = {
  user: { id: "admin-1", role: "admin" },
  session: { activeOrganizationId: "org-1" },
};
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => SESSION),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_owner" })),
}));

// Dependency-batch installer (the real install path).
const installBatchMock = vi.fn(async () => ({
  rootPackage: "@cinatra-ai/x",
  rootVersion: "1.0.0",
  installed: [],
  alreadyInstalled: [],
  batchId: null,
}));
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: (...a: unknown[]) => installBatchMock(...(a as [])),
}));

// Shared install-target authz gates (lazy-imported by the action).
const tenantGateMock = vi.fn(async () => ({}) as { projectOwnership?: unknown });
const targetGateMock = vi.fn(async () => undefined);
vi.mock("@cinatra-ai/agents/install-target-authz", () => ({
  readActorRolesForInstall: vi.fn(() => ({
    principalId: "admin-1",
    organizationId: "org-1",
    platformRole: "platform_admin",
    orgRole: "org_owner",
  })),
  assertTargetBelongsToActiveOrg: (...a: unknown[]) => tenantGateMock(...(a as [])),
  assertCanInstallAtTarget: (...a: unknown[]) => targetGateMock(...(a as [])),
}));

// Canonical row reader (lazy-imported): first call = pre-install probe,
// second call = post-install resolve.
const ROW = {
  id: "iext_abc123",
  kind: "connector",
  status: "active",
  packageName: "@cinatra-ai/x",
  organizationId: "org-1",
  ownerLevel: "organization",
  ownerId: "org-1",
};
const readRowMock = vi.fn(async () => ROW as typeof ROW | null);
vi.mock("../canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) => readRowMock(...(a as [])),
}));

const setAccessMock = vi.fn(async () => undefined);
vi.mock("../install-access-contract", () => ({
  setExtensionInstallAccess: (...a: unknown[]) => setAccessMock(...(a as [])),
}));

const TEAM_ID = "11111111-2222-4333-8444-555555555555";
const INPUT = { packageName: "@cinatra-ai/x", packageVersion: "1.0.0" };

async function runAction(input: Record<string, unknown>) {
  const { installExtensionPackageFormAction } = await import("../actions");
  return installExtensionPackageFormAction(
    input as Parameters<typeof installExtensionPackageFormAction>[0],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: fresh install (no pre-existing row), install succeeds, access
  // write succeeds, kind resolves to connector.
  readRowMock.mockImplementation(async () => ROW);
  resolveKindMock.mockResolvedValue("connector");
  installBatchMock.mockResolvedValue({
    rootPackage: "@cinatra-ai/x",
    rootVersion: "1.0.0",
    installed: [],
    alreadyInstalled: [],
    batchId: null,
  });
  setAccessMock.mockResolvedValue(undefined);
  uninstallMock.mockResolvedValue(undefined);
  tenantGateMock.mockResolvedValue({});
  targetGateMock.mockResolvedValue(undefined);
});

describe("installExtensionPackageFormAction — access selector", () => {
  it("1. no accessTarget → legacy behavior: install + redirect, NO gates, NO policy write, NO extra lock", async () => {
    const result = await runAction(INPUT);
    expect(result).toBeUndefined();
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(setAccessMock).not.toHaveBeenCalled();
    expect(tenantGateMock).not.toHaveBeenCalled();
    expect(withInstallLockMock).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/configuration/extensions");
  });

  it("2. organization target → per-kind DEFAULT policy (no policy field) + installer pointer, under the per-package lock", async () => {
    // Pre-install probe must see no live row for the fresh-install branch.
    readRowMock.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "organization", id: "org-1" },
    });
    expect(result).toBeUndefined();
    expect(tenantGateMock).toHaveBeenCalledTimes(1);
    expect(targetGateMock).toHaveBeenCalledTimes(1);
    // The snapshot→install→policy-write unit runs under the package lock so
    // the compensation can never race a concurrent install of the package.
    expect(withInstallLockMock).toHaveBeenCalledTimes(1);
    expect(withInstallLockMock.mock.calls[0]?.[0]).toBe("@cinatra-ai/x");
    expect(setAccessMock).toHaveBeenCalledExactlyOnceWith({
      kind: "connector",
      resourceId: "iext_abc123",
      installedByUserId: "admin-1",
    });
    expect(redirectMock).toHaveBeenCalledWith("/configuration/extensions");
  });

  it("3. team target → policy scoped to team:<id> on all three tiers", async () => {
    readRowMock.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    await runAction({ ...INPUT, accessTarget: { level: "team", id: TEAM_ID } });
    expect(setAccessMock).toHaveBeenCalledExactlyOnceWith({
      kind: "connector",
      resourceId: "iext_abc123",
      installedByUserId: "admin-1",
      policy: {
        runListVisibility: `team:${TEAM_ID}`,
        runDataVisibility: `team:${TEAM_ID}`,
        runExecuteVisibility: `team:${TEAM_ID}`,
        allowRunSharing: false,
      },
    });
  });

  it("4. authz deny → NOTHING installed, classified failure returned (fail closed)", async () => {
    targetGateMock.mockRejectedValueOnce(new Error("forbidden"));
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "team", id: TEAM_ID },
    });
    expect(result).toEqual({ ok: false, category: "unrecoverable" });
    expect(installBatchMock).not.toHaveBeenCalled();
    expect(setAccessMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("5. kind gate → an agent-kind INSTALLED row with an accessTarget compensates (uninstall) — no pre-install packument probe", async () => {
    // The pre-install probe was removed on purpose: a registry that cannot
    // serve the packument (or a legacy package without `cinatra.kind`) falls
    // back to "agent" and would wrongly refuse a legitimate connector
    // (observed live). Authoritative kind = the installed canonical row.
    const agentRow = { ...ROW, kind: "agent" };
    readRowMock
      .mockResolvedValueOnce(null) // pre-install probe: fresh install
      .mockResolvedValueOnce(agentRow as typeof ROW); // post-install resolve
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "organization", id: "org-1" },
    });
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access",
    });
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(setAccessMock).not.toHaveBeenCalled();
    expect(uninstallMock).toHaveBeenCalledTimes(1);
  });

  it("6. access-write failure on a FRESH install → compensating uninstall + stage:'access'", async () => {
    readRowMock.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    setAccessMock.mockRejectedValueOnce(new Error("policy write failed"));
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "team", id: TEAM_ID },
    });
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access",
    });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("7. access-write failure with a PRE-EXISTING live install → NO uninstall + stage:'access-partial'", async () => {
    // Pre-install probe sees a live row → the compensation must never destroy it.
    readRowMock.mockResolvedValue(ROW);
    setAccessMock.mockRejectedValueOnce(new Error("policy write failed"));
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "team", id: TEAM_ID },
    });
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-partial",
    });
    expect(uninstallMock).not.toHaveBeenCalled();
  });

  it("8. access-write failure + rollback failure → stage:'access-partial'", async () => {
    readRowMock.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    setAccessMock.mockRejectedValueOnce(new Error("policy write failed"));
    uninstallMock.mockRejectedValueOnce(new Error("uninstall failed"));
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "team", id: TEAM_ID },
    });
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-partial",
    });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
  });

  it("malformed accessTarget (level 'user') refuses before any gate or mutation", async () => {
    const result = await runAction({
      ...INPUT,
      accessTarget: { level: "user", id: "u-1" },
    });
    expect(result).toEqual({ ok: false, category: "unrecoverable" });
    expect(tenantGateMock).not.toHaveBeenCalled();
    expect(installBatchMock).not.toHaveBeenCalled();
  });
});

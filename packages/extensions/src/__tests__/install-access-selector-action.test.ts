// installExtensionPackageFormAction — pre-install access selector contract
// (cinatra#805) + absent-target fail-closed boundary (cinatra#1602).
//
// Locks the action-level ordering + fail-safety:
//   2. organization target → setExtensionInstallAccess WITHOUT a policy
//      (per-kind default) + installer pointer
//   3. team target → policy scoped to team:<id>
//   4. authz deny → NOTHING installed (gate runs BEFORE any mutation)
//   5. kind gate → a non connector/artifact/workflow kind with a target refuses
//      (compensating uninstall)
//   6. access-write failure on a FRESH install → compensating uninstall +
//      stage:"access" (fail-closed: never left at the broader default)
//   7. access-write failure with a PRE-EXISTING live install → NO uninstall +
//      stage:"access-partial"
//   8. access-write failure + rollback failure → stage:"access-partial"
//
// #1602 absent-target boundary (the server action is the enforced picker
// contract; an absent target on an access-target kind must never silently grant
// the broadest default):
//   1602a. absent target + access-target kind (fresh) → REFUSED + rollback,
//          stage:"access-required"; NO policy write; NOT a redirect
//   1602b. absent target + access-target kind + a PRE-EXISTING live row → REFUSED
//          but NO uninstall (never destroy it), stage:"access-required"
//   1602c. absent target + access-target kind + rollback fails →
//          stage:"access-partial" (installed with the default; reported honestly)
//   1602d. absent target + NON-access kind → UNCHANGED legacy direct install +
//          redirect (no gate, no policy write, no rollback)
//   1602e. absent target + access-target kind + NO active org → still REFUSED
//          (kind resolution is org-agnostic; an org-anchored-only lookup would
//          fail open)
//   1602f. absent target + post-install kind READ THROWS → FAIL-CLOSED refuse +
//          rollback (a resolution failure never falls through to legacy success)
//   1602g. absent target + successful install but NO row resolved → FAIL-CLOSED
//          refuse + rollback (cannot prove a non-access kind)
//   1602h. compensation-actor role lookup THROWS → does not escape; rollback runs
//          on the base actor (a returned refusal, never an unhandled throw)
//
// The compensating uninstall carries the caller's ORG-scoped standing (the P5
// lifecycle gate refuses a role-less actor) but NEVER platformRole (which would
// route to a cross-org package-global hard-delete) — asserted in 1602a.
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
// Captured so a test can drop the active org (the #1602 fail-closed refusal must
// hold org-agnostically — an org-anchored-only kind lookup would fail open).
const requireAdminSessionMock = vi.fn(async () => SESSION as unknown);
// Captured so a test can make the compensation-actor role lookup THROW — it must
// never escape the rollback path (it falls back to the base actor).
const buildCanDoOptsMock = vi.fn(async () => ({ orgRole: "org_owner" }) as {
  orgRole?: string;
});
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...a: unknown[]) => requireAdminSessionMock(...(a as [])),
  buildCanDoOptsFromSession: (...a: unknown[]) => buildCanDoOptsMock(...(a as [])),
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
// Org-agnostic post-install kind resolver used by the absent-target branch
// (#1602): kind is a package-level property, so ANY row resolves it. Returns the
// connector row by default; overridden per-test for the non-access kind path.
const readRowsByNameMock = vi.fn(async () => [ROW] as Array<typeof ROW>);
vi.mock("../canonical-store", () => ({
  readInstalledExtensionByIdentity: (...a: unknown[]) => readRowMock(...(a as [])),
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readRowsByNameMock(...(a as [])),
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
  requireAdminSessionMock.mockResolvedValue(SESSION);
  buildCanDoOptsMock.mockResolvedValue({ orgRole: "org_owner" });
  readRowMock.mockImplementation(async () => ROW);
  readRowsByNameMock.mockResolvedValue([ROW]);
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
  // -------------------------------------------------------------------------
  // #1602 — absent-target fail-closed boundary. An absent accessTarget on an
  // access-target kind (connector/artifact/workflow) must be REFUSED rather than
  // defaulting to the broadest per-kind grant. The gate runs POST-install (the
  // kind is only reliably known from the installed canonical row) and NEVER
  // funnels through the pre-install target-authz gates.
  // -------------------------------------------------------------------------
  it("1602a. absent target + access-target kind (fresh) → REFUSED + rollback, stage:'access-required', NO policy write, NOT a redirect", async () => {
    // preRow probe: no live row (fresh install) → compensation rolls it back.
    readRowMock.mockResolvedValueOnce(null);
    readRowsByNameMock.mockResolvedValue([ROW]); // resolved kind = connector
    const result = await runAction(INPUT);
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-required",
    });
    // Install happened under the per-package lock (snapshot→install→compensate
    // must be atomic per package), then was rolled back.
    expect(withInstallLockMock).toHaveBeenCalledTimes(1);
    expect(withInstallLockMock.mock.calls[0]?.[0]).toBe("@cinatra-ai/x");
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(setAccessMock).not.toHaveBeenCalled();
    // The compensating uninstall must carry ORG-scoped standing (the P5 lifecycle
    // gate refuses a role-less actor) but NEVER platformRole (which would route to
    // a cross-org package-global hard-delete). extensionRegistry.uninstall gets
    // (typeId, ref, actor); assert the actor envelope.
    const rollbackArgs = (uninstallMock.mock.calls[0] ?? []) as unknown[];
    const rollbackActor = rollbackArgs[2] as
      | { orgRole?: string; platformRole?: string }
      | undefined;
    expect(rollbackActor?.orgRole).toBe("org_owner");
    expect(rollbackActor?.platformRole).toBeUndefined();
    // The pre-install target-authz gates are for a SUPPLIED target only.
    expect(tenantGateMock).not.toHaveBeenCalled();
    expect(targetGateMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("1602b. absent target + access-target kind with a PRE-EXISTING live row → REFUSED, NO uninstall, stage:'access-required'", async () => {
    // preRow probe sees a live row → the refusal must never destroy it.
    readRowMock.mockResolvedValue(ROW);
    readRowsByNameMock.mockResolvedValue([ROW]);
    const result = await runAction(INPUT);
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-required",
    });
    expect(uninstallMock).not.toHaveBeenCalled();
    expect(setAccessMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("1602c. absent target + access-target kind + rollback fails → stage:'access-partial'", async () => {
    readRowMock.mockResolvedValueOnce(null); // fresh install
    readRowsByNameMock.mockResolvedValue([ROW]);
    uninstallMock.mockRejectedValueOnce(new Error("uninstall failed"));
    const result = await runAction(INPUT);
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-partial",
    });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("1602d. absent target + NON-access kind → UNCHANGED legacy install + redirect, NO policy write, NO rollback", async () => {
    readRowMock.mockResolvedValue(null); // agent/skill are not org-anchored
    readRowsByNameMock.mockResolvedValue([
      { ...ROW, kind: "agent" } as typeof ROW,
    ]);
    const result = await runAction(INPUT);
    expect(result).toBeUndefined();
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(setAccessMock).not.toHaveBeenCalled();
    expect(uninstallMock).not.toHaveBeenCalled();
    expect(tenantGateMock).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/configuration/extensions");
  });

  it("1602e. absent target + access-target kind + NO active org → still REFUSED (org-agnostic kind resolution closes the fail-open gap)", async () => {
    requireAdminSessionMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      session: {}, // no activeOrganizationId
    });
    // No org-anchored snapshot is taken (identity === null), but the org-agnostic
    // kind resolver still classifies the package as an access-target kind.
    readRowsByNameMock.mockResolvedValue([ROW]);
    const result = await runAction(INPUT);
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-required",
    });
    // Nothing org-anchored to protect → the fresh install is rolled back.
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("1602f. absent target + post-install kind READ THROWS → FAIL-CLOSED refuse + rollback (cannot prove a non-access kind)", async () => {
    readRowMock.mockResolvedValueOnce(null); // fresh install
    readRowsByNameMock.mockRejectedValueOnce(new Error("store read failed"));
    const result = await runAction(INPUT);
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-required",
    });
    // A resolution failure must never fall through to the legacy success.
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("1602g. absent target + successful install but NO canonical row resolved → FAIL-CLOSED refuse + rollback", async () => {
    readRowMock.mockResolvedValueOnce(null); // fresh install
    readRowsByNameMock.mockResolvedValue([]); // anomalous: success, no row
    const result = await runAction(INPUT);
    expect(result).toEqual({
      ok: false,
      category: "unrecoverable",
      stage: "access-required",
    });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("1602h. compensation-actor role lookup THROWS → does NOT escape; the rollback still runs on the base actor (a returned refusal, never an unhandled throw)", async () => {
    readRowMock.mockResolvedValueOnce(null); // fresh install
    readRowsByNameMock.mockResolvedValue([ROW]); // access-target kind → refuse
    // The membership lookup fails — buildInstallRollbackActor must swallow it and
    // fall back to the base actor rather than let the throw escape the rollback.
    buildCanDoOptsMock.mockRejectedValueOnce(new Error("membership read failed"));
    const result = await runAction(INPUT);
    // A structured refusal is RETURNED (not thrown), and the rollback was still
    // attempted (here the mocked uninstall succeeds → access-required).
    expect(result).toMatchObject({ ok: false, category: "unrecoverable" });
    expect(uninstallMock).toHaveBeenCalledTimes(1);
    // Fallback actor is the base UI actor — no orgRole was attached.
    const rollbackArgs = (uninstallMock.mock.calls[0] ?? []) as unknown[];
    const rollbackActor = rollbackArgs[2] as { orgRole?: string } | undefined;
    expect(rollbackActor?.orgRole).toBeUndefined();
    expect(redirectMock).not.toHaveBeenCalled();
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
        runListVisibility: [`team:${TEAM_ID}`],
        runDataVisibility: [`team:${TEAM_ID}`],
        runExecuteVisibility: [`team:${TEAM_ID}`],
        allowRunSharing: false,
      },
    });
  });

  it("3b. workspace target → ['workspace'] policy; the tenant id is RE-DERIVED, a forged client id is discarded (cinatra#1527 AC3)", async () => {
    readRowMock.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    await runAction({
      ...INPUT,
      // A malicious/forged cross-org id must never reach the gate or the policy.
      accessTarget: { level: "workspace", id: "forged-other-org" },
    });
    // Gate received the SESSION tenant id (org-1), not the forged client value.
    // (The gate mocks are typed with no params, so read the recorded call args
    // through an unknown[] cast rather than a strict tuple index.)
    expect(targetGateMock).toHaveBeenCalledTimes(1);
    const wsTenantArgs = (tenantGateMock.mock.calls[0] ?? []) as unknown[];
    expect(wsTenantArgs[1]).toEqual({ level: "workspace", id: "org-1" });
    expect(setAccessMock).toHaveBeenCalledExactlyOnceWith({
      kind: "connector",
      resourceId: "iext_abc123",
      installedByUserId: "admin-1",
      policy: {
        runListVisibility: ["workspace"],
        runDataVisibility: ["workspace"],
        runExecuteVisibility: ["workspace"],
        allowRunSharing: false,
      },
    });
  });

  it("3c. admin target → ['admin'] audience policy on all three tiers", async () => {
    readRowMock.mockResolvedValueOnce(null).mockResolvedValueOnce(ROW);
    await runAction({
      ...INPUT,
      accessTarget: { level: "admin", id: "forged-other-org" },
    });
    const adminTenantArgs = (tenantGateMock.mock.calls[0] ?? []) as unknown[];
    expect(adminTenantArgs[1]).toEqual({ level: "admin", id: "org-1" });
    expect(setAccessMock).toHaveBeenCalledExactlyOnceWith({
      kind: "connector",
      resourceId: "iext_abc123",
      installedByUserId: "admin-1",
      policy: {
        runListVisibility: ["admin"],
        runDataVisibility: ["admin"],
        runExecuteVisibility: ["admin"],
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

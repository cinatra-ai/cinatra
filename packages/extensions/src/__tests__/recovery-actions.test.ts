// cinatra#2762 acceptance 2: the settings page offers a WORKING recovery for an
// install that is live but serving nothing.
//
// Two actions, two different jobs. "Retry activation" re-fires the in-process
// activate hook after an operator fixes what refused it, without reinstalling or
// restarting. "Roll back to bundled" archives the override and puts the image's
// own version back in service. Both target the EFFECTIVE row, so neither can act
// on a superseded one, and both RETURN on failure so the client can say what
// actually happened.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../handler-bootstrap", () => ({}));

const redirectMock = vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
});
vi.mock("next/navigation", () => ({ redirect: () => redirectMock() }));
vi.mock("@cinatra-ai/registries", () => ({ getAgentPackage: vi.fn(async () => null) }));
vi.mock("../index", () => ({
  extensionRegistry: {
    install: vi.fn(), update: vi.fn(), uninstall: vi.fn(),
    archive: vi.fn(), restore: vi.fn(), forceDelete: vi.fn(),
  },
}));
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
const SESSION = { user: { id: "admin-1", role: "admin" }, session: { activeOrganizationId: "org-1" } };
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => SESSION),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_owner" })),
  isPlatformAdmin: () => true,
}));

const PKG = "@cinatra-ai/google-appointment-schedules-connector";
const targetRow = {
  id: "iext_target",
  packageName: PKG,
  organizationId: "org-1",
  ownerLevel: "organization",
  status: "active",
  source: { type: "verdaccio", version: "0.1.1" },
};

const resolveTarget = vi.fn(async () => targetRow);
const rowAnchor = vi.fn(() => ({ ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" }));
vi.mock("../lifecycle-target-resolver", () => ({
  resolveLifecycleTargetRow: (...a: unknown[]) => resolveTarget(...(a as [])),
  lifecycleRowAnchor: (...a: unknown[]) => rowAnchor(...(a as [])),
  resolveLifecycleScope: () => ({ ok: false }),
}));

const fireActivate = vi.fn(async () => ({ finalized: true, activated: true }));
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: (...a: unknown[]) => fireActivate(...(a as [])),
}));

const transition = vi.fn(async () => null);
vi.mock("../lifecycle-primitive", () => ({
  transitionExtensionLifecycle: (...a: unknown[]) => transition(...(a as [])),
  deleteNonFinalizedCanonicalRow: vi.fn(),
  deleteScopedCanonicalRow: vi.fn(),
}));

const reactivateBundled = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/static-bundle-loader", () => ({
  reactivateBundledFallbackInProcess: (...a: unknown[]) => reactivateBundled(...(a as [])),
}));

beforeEach(() => {
  redirectMock.mockClear();
  resolveTarget.mockClear();
  fireActivate.mockClear();
  transition.mockClear();
  reactivateBundled.mockClear();
  fireActivate.mockResolvedValue({ finalized: true, activated: true } as never);
  reactivateBundled.mockResolvedValue({ ok: true } as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Run an action that redirects on success, and report which way it went. */
async function run(fn: () => Promise<unknown>) {
  try {
    return { returned: await fn(), redirected: false };
  } catch (err) {
    if ((err as Error).message === "NEXT_REDIRECT") return { returned: undefined, redirected: true };
    throw err;
  }
}

describe("retryExtensionActivationFormAction", () => {
  it("re-fires the in-process activate hook against the EFFECTIVE row", async () => {
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(resolveTarget).toHaveBeenCalled();
    // The row's own org and version, never the actor's.
    expect(fireActivate).toHaveBeenCalledWith(PKG, "org-1", "0.1.1", undefined);
    expect(out.redirected, "a recovered install returns the operator to the list").toBe(true);
  });

  it("does NOT reinstall: the bytes are already finalized, only the registration is missing", async () => {
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(transition).not.toHaveBeenCalled();
  });

  it("forwards the workspace anchor for a workspace-anchored row", async () => {
    rowAnchor.mockReturnValueOnce({
      ownerLevel: "workspace",
      ownerId: "__platform__",
      organizationId: null,
    } as never);
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(fireActivate).toHaveBeenCalledWith(PKG, "org-1", "0.1.1", { ownerLevel: "workspace" });
  });

  it("an activation that does not take RETURNS a failure and never redirects", async () => {
    fireActivate.mockResolvedValue({ finalized: true, activated: false, reason: "signature required" } as never);
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("a resolver refusal (no standing, no addressable row) is reported, not thrown at the client", async () => {
    resolveTarget.mockRejectedValueOnce(new Error("no addressable row"));
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(fireActivate).not.toHaveBeenCalled();
  });
});

describe("rollBackExtensionToBundledFormAction", () => {
  it("archives the override, THEN puts the bundled version back in service", async () => {
    const order: string[] = [];
    transition.mockImplementation(async () => {
      order.push("archive");
      return null;
    });
    reactivateBundled.mockImplementation(async () => {
      order.push("reactivate");
      return { ok: true };
    });
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    // Order is load-bearing: registering under a live override would leave two
    // registrations racing for the same global names.
    expect(order).toEqual(["archive", "reactivate"]);
    expect(out.redirected).toBe(true);
  });

  it("ARCHIVES, never hand-deletes: the payload and provenance stay restorable", async () => {
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(transition).toHaveBeenCalledWith(
      "iext_target",
      "archive",
      expect.objectContaining({ reason: expect.stringContaining("bundled") }),
    );
  });

  it("acts on the EFFECTIVE row, so a superseded row can never be the target", async () => {
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(resolveTarget).toHaveBeenCalled();
  });

  it("reports honestly when the bundled version does not come back in this process", async () => {
    reactivateBundled.mockResolvedValue({ ok: false, reason: "module absent" } as never);
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    // The override IS archived (it no longer shadows anything), but the operator
    // is not told the bundle is serving when it is not.
    expect(transition).toHaveBeenCalled();
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("an archive refusal stops the rollback before the bundle is touched", async () => {
    transition.mockRejectedValueOnce(new Error("locked row"));
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(reactivateBundled).not.toHaveBeenCalled();
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
  });
});

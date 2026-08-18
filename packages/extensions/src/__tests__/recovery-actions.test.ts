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
// Mutable rather than re-mocked per test, for the same reason `staticManifest`
// below is: a `vi.doUnmock` here would cancel this module's mock for every LATER
// import too.
let actorIsPlatformAdmin = true;
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => SESSION),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_owner" })),
  isPlatformAdmin: () => actorIsPlatformAdmin,
}));

const PKG = "@cinatra-ai/google-appointment-schedules-connector";

// THE RESOLVER IS NOT MOCKED (cinatra#2762). It used to be, and that is exactly
// why these tests passed while both actions were unusable in the product: with
// `resolveLifecycleTargetRow` stubbed, the row set the actions actually face
// after a successful install — the bundled anchor AND the marketplace install,
// both at org-NULL — never reached the real addressing rule, which refused it as
// `ambiguous_target` and threw. The ONLY thing stubbed below the actions now is
// the canonical-store READ, so every test here drives the real resolver: the
// real supersession rule, the real precedence policy, the real standing gate.
const canonicalRow = (over: Record<string, unknown> = {}) => ({
  id: "iext_installed",
  packageName: PKG,
  organizationId: null,
  ownerLevel: "workspace",
  ownerId: "__platform__",
  kind: "connector",
  status: "active",
  isDefault: true,
  source: { type: "verdaccio", version: "0.1.1" },
  requiredInProd: false,
  dependencies: [],
  manifestHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});
/** The row the image always provides, live alongside the install. */
const bundledAnchorRow = canonicalRow({
  id: "iext_bundled",
  ownerLevel: "platform",
  ownerId: null,
  source: { type: "bundled", version: "0.1.0" },
});
/** The install that overrides it — the row every recovery op must target. */
const installRow = canonicalRow();

// THE PRODUCTION SHAPE, and the default for every test: both rows live.
let storeRows: Record<string, unknown>[] = [bundledAnchorRow, installRow];
const readRows = vi.fn(async () => storeRows);
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) => readRows(...(a as [])),
}));

// The ACTIVATION-ONLY seam retry drives (cinatra#2762). The install dispatcher's
// hook is mocked too, and every retry test asserts it is NEVER reached: retry
// must not need the registry, and must not re-run an install pipeline.
const activateRow = vi.fn(async () => ({ activated: true }));
vi.mock("@/lib/extension-runtime-activate", () => ({
  activateInstalledRowInProcess: (...a: unknown[]) => activateRow(...(a as [])),
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
// Does the IMAGE carry this package? Mutable rather than re-mocked per test: a
// `vi.doUnmock` here cancels this module's mock for every LATER import too, and
// the actions then read the real generated manifest.
let staticManifest: Record<string, unknown> = {
  "@cinatra-ai/google-appointment-schedules-connector": { packageName: "x" },
};
vi.mock("@/lib/generated/extensions.server", () => ({
  get STATIC_EXTENSION_MANIFEST() {
    return staticManifest;
  },
}));
vi.mock("@/lib/static-bundle-loader", () => ({
  reactivateBundledFallbackInProcess: (...a: unknown[]) => reactivateBundled(...(a as [])),
}));

beforeEach(() => {
  redirectMock.mockClear();
  readRows.mockClear();
  storeRows = [bundledAnchorRow, installRow];
  staticManifest = { [PKG]: { packageName: "x" } };
  actorIsPlatformAdmin = true;
  fireActivate.mockClear();
  activateRow.mockClear();
  transition.mockClear();
  reactivateBundled.mockClear();
  fireActivate.mockResolvedValue({ finalized: true, activated: true } as never);
  activateRow.mockResolvedValue({ activated: true } as never);
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
  it("RESOLVES through the real resolver with the bundled anchor live beside the install", async () => {
    // cinatra#2762 item 2, the regression this file previously could not see: a
    // successful install leaves the image's bundled anchor AND the install both
    // live at org-NULL, and the resolver used to refuse that pair — so the action
    // threw AmbiguousLifecycleTargetError instead of retrying anything.
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(readRows).toHaveBeenCalledWith(PKG);
    expect(out.redirected, "a recovered install returns the operator to the list").toBe(true);
  });

  it("is ACTIVATION-ONLY: it never touches the install dispatcher or the registry", async () => {
    // cinatra#2762 round-2 item 3. Retry used to call `fireExtensionActivate` →
    // `installExtensionFromRegistry`, so it NEEDED the marketplace host —
    // unreachable for exactly the operator most in need of a retry — and re-ran a
    // whole install pipeline to fix a missing registration.
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(fireActivate).not.toHaveBeenCalled();
    expect(activateRow).toHaveBeenCalledTimes(1);
  });

  it("is ROW-BOUND: it activates the resolved row's own org, not the actor's", async () => {
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    // The install is org-NULL; the ACTOR's active org is "org-1". The row wins.
    expect(activateRow).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      expectRowId: "iext_installed",
    });
  });

  it("CARRIES THE ROW ID, so activation cannot bind a different row", async () => {
    // cinatra#2762 round 5 (non-blocking hardening). Retry used to hand the
    // activator only `(packageName, orgId)`, and for an org-NULL row that
    // re-enters PLATFORM-GLOBAL selection — a second resolution from a coarser
    // key than the resolver used. The resolved row's identity now travels with
    // it and the activator refuses a row that is not this one.
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(activateRow).toHaveBeenCalledWith(
      expect.objectContaining({ expectRowId: "iext_installed" }),
    );
  });

  it("does NOT reinstall: the bytes are already finalized, only the registration is missing", async () => {
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(transition).not.toHaveBeenCalled();
  });

  it("an ORG-anchored install resolves at the actor's own scope, unchanged", async () => {
    // No workspace row: the actor's own org scope answers, and the row's own org
    // is what travels to the activator.
    storeRows = [
      canonicalRow({
        id: "iext_org",
        organizationId: "org-1",
        ownerLevel: "organization",
        ownerId: "org-1",
      }),
    ];
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(activateRow).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: "org-1",
      expectRowId: "iext_org",
    });
  });

  it("an activation that does not take RETURNS a failure and never redirects", async () => {
    activateRow.mockResolvedValue({ activated: false, reason: "signature required" } as never);
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("RESTORES THE BUNDLE when the activation fails — a failed retry leaves something serving", async () => {
    // The activation path fires an idempotent capability teardown before it
    // registers, so a retry that then fails can leave NOTHING serving the
    // package: the #2762 state itself, recreated by the recovery action.
    activateRow.mockResolvedValue({ activated: false, reason: "register-threw" } as never);
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(reactivateBundled).toHaveBeenCalledWith(PKG);
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    // The row is NOT archived: retry is not a rollback, and the operator may
    // still fix what refused it.
    expect(transition).not.toHaveBeenCalled();
  });

  it("does NOT restore anything on SUCCESS — the install itself is serving", async () => {
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(reactivateBundled).not.toHaveBeenCalled();
  });

  it("says so when the restore ALSO fails, instead of reporting a bare activation failure", async () => {
    activateRow.mockResolvedValue({ activated: false, reason: "register-threw" } as never);
    reactivateBundled.mockResolvedValue({ ok: false, reason: "module absent" } as never);
    const errors: unknown[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(errors.join(" ")).toContain("RECOVERY REQUIRED");
  });

  it("a package the image does not carry is reported as unserved, not silently 'restored'", async () => {
    activateRow.mockResolvedValue({ activated: false, reason: "register-threw" } as never);
    staticManifest = {};
    const errors: unknown[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(reactivateBundled).not.toHaveBeenCalled();
    expect(errors.join(" ")).toContain("does not ship in the image");
  });

  it("a REAL resolver refusal is reported, not thrown at the client", async () => {
    // Two competing marketplace installs: precedence refuses to guess, so the
    // resolver still raises `ambiguous_target` and the action reports it.
    storeRows = [
      installRow,
      canonicalRow({ id: "iext_other", ownerLevel: "platform", ownerId: null }),
    ];
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(fireActivate).not.toHaveBeenCalled();
  });

  it("a canonical-store read failure is reported, never fanned out", async () => {
    readRows.mockRejectedValueOnce(new Error("canonical store down") as never);
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
      "iext_installed",
      "archive",
      expect.objectContaining({ reason: expect.stringContaining("bundled") }),
    );
  });

  it("acts on the EFFECTIVE row, so a superseded row can never be the target", async () => {
    // A live ORG row of the same package sits beside the workspace install that
    // superseded it. The real supersession rule drops it, so the archive lands on
    // the row in force — never on the one the workspace install replaced.
    storeRows = [
      bundledAnchorRow,
      installRow,
      canonicalRow({
        id: "iext_superseded",
        organizationId: "org-1",
        ownerLevel: "organization",
        ownerId: "org-1",
      }),
    ];
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(transition).toHaveBeenCalledWith("iext_installed", "archive", expect.anything());
    expect(out.redirected).toBe(true);
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

describe("rollBackExtensionToBundledFormAction: the rollback is atomic", () => {
  it("PUTS THE INSTALL BACK when the bundled version cannot be restored", async () => {
    // Archiving the override and stopping would leave NOTHING serving the
    // package, which is worse than the state the operator asked to leave. The
    // archive is undone so the package returns to exactly where it started.
    reactivateBundled.mockResolvedValue({ ok: false, reason: "module absent" } as never);
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(transition).toHaveBeenNthCalledWith(
      1,
      "iext_installed",
      "archive",
      expect.anything(),
    );
    expect(transition).toHaveBeenNthCalledWith(
      2,
      "iext_installed",
      "activate",
      expect.objectContaining({ reason: expect.stringContaining("put back") }),
    );
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
  });

  it("reports RECOVERY REQUIRED when the install cannot be put back either", async () => {
    reactivateBundled.mockResolvedValue({ ok: false, reason: "module absent" } as never);
    transition
      .mockResolvedValueOnce(null as never)
      .mockRejectedValueOnce(new Error("lifecycle refused"));
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    // Still a reported failure, never a redirect implying it worked.
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("rollBackExtensionToBundledFormAction: the guards", () => {
  it("REFUSES a row that is not a marketplace install: there is nothing to roll back", async () => {
    // Bundled ONLY: the resolver addresses the anchor itself, and rolling THAT
    // back would archive the one thing serving the package.
    storeRows = [bundledAnchorRow];
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    // The only thing serving is never archived.
    expect(transition).not.toHaveBeenCalled();
    expect(reactivateBundled).not.toHaveBeenCalled();
  });

  it("REFUSES when the image carries no version to fall back to", async () => {
    staticManifest = {};
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(transition).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2762 round 5 — ROLLBACK IS NOT A ONE-WAY DOOR.
//
// A completed rollback leaves {bundled row LIVE, install row ARCHIVED}. Both
// recovery actions resolve through `resolveLifecycleTargetRow`, which used to
// throw AmbiguousLifecycleTargetError on exactly that set — so the recovery the
// operator had just used made every subsequent lifecycle op on the package
// unusable. THE RESOLVER IS NOT MOCKED here, so these drive the real rule.
// ---------------------------------------------------------------------------
const rolledBackRows = () => [
  bundledAnchorRow,
  canonicalRow({ status: "archived" }),
];

describe("the state a completed rollback leaves behind is still addressable", () => {
  it("retry RESOLVES the archived install instead of refusing the pair", async () => {
    storeRows = rolledBackRows();
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() => retryExtensionActivationFormAction({ packageName: PKG }));
    // It reached the activator at all — before this round it returned
    // `unrecoverable` without ever getting past the resolver.
    expect(activateRow).toHaveBeenCalledWith(
      expect.objectContaining({ expectRowId: "iext_installed" }),
    );
    expect(out.redirected).toBe(true);
  });

  it("roll back RESOLVES the archived install too (and its own guards still speak)", async () => {
    storeRows = rolledBackRows();
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    // The archived INSTALL is what it addressed — not the live bundled anchor,
    // which its own "not a marketplace install" guard would have refused before
    // touching anything.
    expect(transition).toHaveBeenCalledWith(
      "iext_installed",
      "archive",
      expect.anything(),
    );
  });
});

describe("the actions are bound to the row the settings page described", () => {
  // The settings loader mints a `rowSelector` from the row it resolved and
  // closes it over both actions, so the action acts on the row the operator was
  // LOOKING AT rather than re-resolving from the package name. The selector
  // names an anchor TIER: the bundled anchor is `platform`, the install is
  // `workspace`, and both sit at org-NULL — the one same-scope identity
  // ambiguity the store permits.

  it("a selector naming the INSTALL tier targets the install", async () => {
    const { retryExtensionActivationFormAction } = await import("../actions");
    await run(() =>
      retryExtensionActivationFormAction({
        packageName: PKG,
        rowSelector: { ownerLevel: "workspace" },
      }),
    );
    expect(activateRow).toHaveBeenCalledWith(
      expect.objectContaining({ expectRowId: "iext_installed" }),
    );
  });

  it("a selector naming the BUNDLED tier reaches the bundled anchor", async () => {
    // Proof the selector genuinely reaches the resolver: rolling back the
    // BUNDLED row is refused by the action's own guard ("not a marketplace
    // install"), which is only reachable when the resolver returned that row.
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() =>
      rollBackExtensionToBundledFormAction({
        packageName: PKG,
        rowSelector: { ownerLevel: "platform" },
      }),
    );
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(transition).not.toHaveBeenCalled();
    expect(reactivateBundled).not.toHaveBeenCalled();
  });

  it("NO selector keeps the ordinary addressing, byte for byte", async () => {
    const { rollBackExtensionToBundledFormAction } = await import("../actions");
    const out = await run(() => rollBackExtensionToBundledFormAction({ packageName: PKG }));
    expect(transition).toHaveBeenCalledWith("iext_installed", "archive", expect.anything());
    expect(out.redirected).toBe(true);
  });

  it("a selector can NEVER widen reach — standing is still gated over the row", async () => {
    // An org-scoped, non-platform-admin actor naming the platform tier resolves
    // nothing addressable: the selector filters the set the ACTOR can reach, it
    // does not extend it.
    actorIsPlatformAdmin = false;
    const { retryExtensionActivationFormAction } = await import("../actions");
    const out = await run(() =>
      retryExtensionActivationFormAction({
        packageName: PKG,
        rowSelector: { ownerLevel: "platform" },
      }),
    );
    expect(out.returned).toEqual({ ok: false, category: "unrecoverable" });
    expect(activateRow).not.toHaveBeenCalled();
  });
});

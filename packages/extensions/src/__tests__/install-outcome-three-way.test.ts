// cinatra#2761. The install surface must distinguish the THREE outcomes the
// pipeline already reports, and it must never collapse two of them into one.
//
//   1. committed + activated          → plain success (the action redirects)
//   2. committed + activation-deferred → SUCCESS with a caveat and a next step
//   3. truly failed                    → the classified failure + a support ref
//
// The defect these tests close: outcome 2 was reported as outcome 3, so an
// install that had LANDED told the operator it had not, gave them a support
// reference for a case with nothing to support, and named no next step.
//
// The load-bearing invariant, asserted directly below: the committed row and the
// reported tone can never disagree. Outcome 2 exists ONLY when the pipeline
// finalized, so it must never carry a failure category and never mint a
// reference. A reference is the marker of a case an operator must chase.
//
// Mocked exactly like install-failure-diagnostics.test.ts (the same module-load
// chain); the copy module under test is REAL.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../handler-bootstrap", () => ({}));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (...a: unknown[]) => redirectMock(...a),
}));

vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: vi.fn(async () => null),
}));

vi.mock("../index", () => ({
  extensionRegistry: {
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    forceDelete: vi.fn(),
  },
}));

vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../canonical-store", () => ({
  readInstalledExtensionByIdentity: vi.fn(async () => null),
  // A NON-access kind, so the form action's absent-target branch proceeds
  // straight to its outcome (the access gate is not what these tests pin).
  readInstalledExtensionsByPackageName: vi.fn(async () => [{ kind: "agent" }]),
}));

vi.mock("../utils", () => ({
  deriveTypeId: vi.fn((k: string | null | undefined) => k ?? "agent"),
  resolveExtensionTypeId: vi.fn(async () => "connector"),
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
  isPlatformAdmin: (s: { user?: { role?: string | null } | null } | null | undefined) =>
    String(s?.user?.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .includes("admin"),
}));

vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: () => false,
}));

const PKG = "@cinatra-ai/google-appointment-schedules-connector";
const VERSION = "0.1.1";

// The batch result the saga returns. Shaped per test.
const installBatchMock = vi.fn(async () => ({
  rootPackage: PKG,
  rootVersion: VERSION,
  installed: [{ packageName: PKG, version: VERSION }],
  updated: [],
  installedSideBySide: [],
  alreadyInstalled: [],
  activationDeferred: [] as { packageName: string; version: string }[],
  batchId: null as string | null,
}));
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: (...a: unknown[]) => installBatchMock(...(a as [])),
}));

const ACTOR = { actorType: "human" as const, userId: "admin-1", source: "ui" as const };
const REF_RE = /^REF-[0-9A-F]{8}$/;

/** The dispatcher's real throw: the pipeline finalized, activation was refused. */
function activationDeferredThrow(): Error {
  return Object.assign(
    new Error(
      `install of ${PKG} finalized the real-integrity pipeline but did NOT hot-activate ` +
        `in-process (anchor-refused) — the package is anchorable (it will load on the next ` +
        `boot) but did not load without a restart this call. The committed install was left intact.`,
    ),
    { code: "INSTALL_ACTIVATION_DEFERRED", packageName: PKG },
  );
}

let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  installBatchMock.mockReset();
  redirectMock.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  infoSpy.mockRestore();
});

describe("installExtensionPackage: the three outcomes are distinct", () => {
  it("1. committed + ACTIVATED → plain success, no caveat, no reference", async () => {
    installBatchMock.mockImplementation(async () => ({
      rootPackage: PKG,
      rootVersion: VERSION,
      installed: [{ packageName: PKG, version: VERSION }],
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
      activationDeferred: [],
      batchId: null,
    }));
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage(PKG, VERSION, ACTOR);

    expect(res.success).toBe(true);
    expect(res.activationDeferred).toBeUndefined();
    expect(res.reference).toBeUndefined();
    expect(res.failureCategory).toBeUndefined();
  });

  it("2. committed + ACTIVATION-DEFERRED (batch-reported) → success WITH the caveat and NO reference", async () => {
    installBatchMock.mockImplementation(async () => ({
      rootPackage: PKG,
      rootVersion: VERSION,
      installed: [{ packageName: PKG, version: VERSION }],
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
      activationDeferred: [{ packageName: PKG, version: VERSION }],
      batchId: "batch-1",
    }));
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage(PKG, VERSION, ACTOR);

    // The install LANDED. Reporting it as a failure is the defect.
    expect(res.success).toBe(true);
    expect(res.activationDeferred).toBe(true);
    // No support reference: there is no failed install to chase.
    expect(res.reference).toBeUndefined();
    expect(res.failureCategory).toBeUndefined();
    // It is NOT logged through the failure chokepoint.
    const failureLines = errSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("classify-failed"),
    );
    expect(failureLines).toHaveLength(0);
    // The operator still gets a line, tagged as a committed install.
    const committed = infoSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("activation=deferred"),
    ) as unknown[] | undefined;
    expect(committed).toBeTruthy();
    expect(committed).toContain(PKG);
  });

  it("2b. the same outcome THROWN (a path that bypasses the batch) is read identically", async () => {
    installBatchMock.mockImplementation(async () => {
      throw activationDeferredThrow();
    });
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage(PKG, VERSION, ACTOR);

    expect(res.success).toBe(true);
    expect(res.activationDeferred).toBe(true);
    expect(res.reference).toBeUndefined();
  });

  it("3. TRULY FAILED → classified failure, a reference, and no success claim", async () => {
    installBatchMock.mockImplementation(async () => {
      throw Object.assign(new Error("Marketplace install: HTTP 404"), {
        httpStatus: 404,
        responseBody: JSON.stringify({ code: "cinatra.install_not_found" }),
      });
    });
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage(PKG, VERSION, ACTOR);

    expect(res.success).toBe(false);
    expect(res.activationDeferred).toBeUndefined();
    expect(res.failureCategory).toBe("unavailable-version");
    expect(res.reference).toMatch(REF_RE);
  });

  it("a deferred member for a DIFFERENT package does not make this install deferred", async () => {
    installBatchMock.mockImplementation(async () => ({
      rootPackage: PKG,
      rootVersion: VERSION,
      installed: [{ packageName: PKG, version: VERSION }],
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
      activationDeferred: [{ packageName: "@cinatra-ai/other", version: "1.0.0" }],
      batchId: "batch-1",
    }));
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage(PKG, VERSION, ACTOR);
    expect(res.success).toBe(true);
    expect(res.activationDeferred).toBeUndefined();
  });

  it("a batch result WITHOUT the caveat field degrades to plain success (never throws)", async () => {
    installBatchMock.mockImplementation(
      async () =>
        ({
          rootPackage: PKG,
          rootVersion: VERSION,
          installed: [{ packageName: PKG, version: VERSION }],
          alreadyInstalled: [],
          batchId: null,
        }) as never,
    );
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage(PKG, VERSION, ACTOR);
    expect(res.success).toBe(true);
    expect(res.activationDeferred).toBeUndefined();
  });
});

describe("installExtensionPackageFormAction: what reaches the client", () => {
  it("a plain success REDIRECTS (it returns nothing)", async () => {
    installBatchMock.mockImplementation(async () => ({
      rootPackage: PKG,
      rootVersion: VERSION,
      installed: [{ packageName: PKG, version: VERSION }],
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
      activationDeferred: [],
      batchId: null,
    }));
    const { installExtensionPackageFormAction } = await import("../actions");
    const res = await installExtensionPackageFormAction({
      packageName: PKG,
      packageVersion: VERSION,
    });
    expect(res).toBeUndefined();
    expect(redirectMock).toHaveBeenCalledWith("/configuration/extensions");
  });

  it("the DEFERRED outcome returns ok:true with the activation discriminant, and does NOT redirect", async () => {
    installBatchMock.mockImplementation(async () => ({
      rootPackage: PKG,
      rootVersion: VERSION,
      installed: [{ packageName: PKG, version: VERSION }],
      updated: [],
      installedSideBySide: [],
      alreadyInstalled: [],
      activationDeferred: [{ packageName: PKG, version: VERSION }],
      batchId: "batch-1",
    }));
    const { installExtensionPackageFormAction } = await import("../actions");
    const res = await installExtensionPackageFormAction({
      packageName: PKG,
      packageVersion: VERSION,
    });
    expect(res).toEqual({ ok: true, activation: "deferred" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("a TRUE failure returns ok:false with a category and a reference", async () => {
    installBatchMock.mockImplementation(async () => {
      throw new Error("registry unreachable");
    });
    const { installExtensionPackageFormAction } = await import("../actions");
    const res = await installExtensionPackageFormAction({
      packageName: PKG,
      packageVersion: VERSION,
    });
    expect(res).toMatchObject({ ok: false, category: "unrecoverable" });
    expect((res as { reference?: string }).reference).toMatch(REF_RE);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("outcome copy: the three tones can never be confused", () => {
  it("the deferred copy states the install landed and names the next step", async () => {
    const { installActivationDeferredCopy } = await import(
      "../screens/marketplace-failure-copy"
    );
    const copy = installActivationDeferredCopy("install", "Google Appointment Schedules");
    // It says the install SUCCEEDED.
    expect(copy).toContain("installed");
    // It names the next step.
    expect(copy).toContain("restart");
    // It never uses failure language, and never carries a support reference.
    expect(copy).not.toContain("Couldn't");
    expect(copy).not.toContain("administrator");
    expect(copy).not.toContain("Ref:");
  });

  it("the deferred copy differs from EVERY failure-category copy", async () => {
    const { installActivationDeferredCopy, buildMarketplaceFailureCopy } = await import(
      "../screens/marketplace-failure-copy"
    );
    const deferred = installActivationDeferredCopy("install", "Widget");
    const failures = Object.values(buildMarketplaceFailureCopy("install", "Widget"));
    for (const failure of failures) {
      expect(deferred).not.toBe(failure);
    }
  });

  it("appendDiagnosticReference is a no-op without a reference, so the deferred copy stays clean", async () => {
    const { appendDiagnosticReference, installActivationDeferredCopy } = await import(
      "../screens/marketplace-failure-copy"
    );
    const copy = installActivationDeferredCopy("install", "Widget");
    expect(appendDiagnosticReference(copy, undefined)).toBe(copy);
  });

  it("update phrases the same outcome in its own tense", async () => {
    const { installActivationDeferredCopy } = await import(
      "../screens/marketplace-failure-copy"
    );
    expect(installActivationDeferredCopy("update", "Widget")).toContain("updated");
  });
});

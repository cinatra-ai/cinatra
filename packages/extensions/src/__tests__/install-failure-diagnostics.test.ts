// cinatra#1539 — the install classification chokepoint must (a) reject an
// empty version BEFORE any install request, (b) emit ONE sanitized structured
// operator log carrying the raw contract code + HTTP status, and (c) mint an
// opaque diagnostic reference that is BOTH logged and returned to the client so
// an admin can cite it and an operator can grep for it.
//
// These are behavioral contracts of installExtensionPackage /
// installExtensionPackageFormAction, so the module-load dependency chain is
// mocked exactly like install-access-selector-action.test.ts; the classifier /
// extractors under test (screens/marketplace-failure-copy) are REAL.
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
}));

// The real install path — configured per-test to throw a shaped failure.
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

const ACTOR = { actorType: "human" as const, userId: "admin-1", source: "ui" as const };
const REF_RE = /^REF-[0-9A-F]{8}$/;

// Pull the `ref=REF-XXXX` token out of a captured console.error argument list.
function refFromLog(calls: unknown[][]): string | undefined {
  for (const call of calls) {
    const ref = call.find(
      (a): a is string => typeof a === "string" && REF_RE.test(a),
    );
    if (ref) return ref;
  }
  return undefined;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  installBatchMock.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("installExtensionPackage — #1539 chokepoint diagnostics", () => {
  it("rejects an empty version BEFORE the install request, with a non-'gone' category + reference", async () => {
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage("@cinatra-ai/x", "   ", ACTOR);

    expect(res.success).toBe(false);
    expect(res.failureCategory).toBe("unrecoverable"); // not unavailable-version
    expect(res.reference).toMatch(REF_RE);
    // The install request was NEVER made.
    expect(installBatchMock).not.toHaveBeenCalled();
    // The rejection was logged with the same reference and reason.
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("empty-version");
    expect(refFromLog(errSpy.mock.calls)).toBe(res.reference);
  });

  it("a recognized install_not_found keeps unavailable-version and logs code+status+ref", async () => {
    installBatchMock.mockImplementation(async () => {
      throw Object.assign(new Error("Marketplace install: HTTP 404"), {
        httpStatus: 404,
        responseBody: JSON.stringify({ code: "cinatra.install_not_found" }),
      });
    });
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage("@cinatra-ai/x", "0.1.1", ACTOR);

    expect(res.success).toBe(false);
    expect(res.failureCategory).toBe("unavailable-version");
    expect(res.reference).toMatch(REF_RE);

    // The chokepoint log uses a CONSTANT %s format string (CWE-134-safe), so the
    // spy captures the format string + the interpolated values as SEPARATE args.
    // Assert the sanitized values are present as args on the structured line.
    const structured = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("classify-failed"),
    ) as unknown[] | undefined;
    expect(structured).toBeTruthy();
    expect(structured).toContain("install_not_found");
    expect(structured).toContain(404);
    expect(structured).toContain("unavailable-version");
    expect(structured).toContain(res.reference);
    expect(refFromLog(errSpy.mock.calls)).toBe(res.reference);
  });

  it("a BARE 404 (no contract code) classifies to unrecoverable and logs code=none (#1539 AC5)", async () => {
    installBatchMock.mockImplementation(async () => {
      throw Object.assign(new Error("not found"), { httpStatus: 404 });
    });
    const { installExtensionPackage } = await import("../actions");
    const res = await installExtensionPackage("@cinatra-ai/x", "0.1.1", ACTOR);

    expect(res.success).toBe(false);
    expect(res.failureCategory).toBe("unrecoverable"); // NOT unavailable-version
    expect(res.reference).toMatch(REF_RE);

    const structured = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("classify-failed"),
    ) as unknown[] | undefined;
    expect(structured).toBeTruthy();
    // code arg is the string "none" (no recognized contract code); status is 404.
    expect(structured).toContain("none");
    expect(structured).toContain(404);
    expect(structured).toContain("unrecoverable");
  });

  it("the sanitized structured line never contains the raw error detail (CWE-532)", async () => {
    // A MarketplaceMcpError embeds the upstream response `detail` INTO its
    // message (marketplace-mcp-client http-client). The structured chokepoint
    // line must carry only bounded fields — never that message/stack.
    installBatchMock.mockImplementation(async () => {
      throw Object.assign(
        new Error("Marketplace extension_install_authorize returned an error: s3cr3t-detail-XYZ"),
        {
          httpStatus: 404,
          responseBody: JSON.stringify({ code: "cinatra.install_not_found", secret: "s3cr3t-body" }),
        },
      );
    });
    const { installExtensionPackage } = await import("../actions");
    await installExtensionPackage("@cinatra-ai/x", "0.1.1", ACTOR);

    const structured = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("classify-failed"),
    ) as unknown[] | undefined;
    expect(structured).toBeTruthy();
    const joined = structured!.join(" ");
    expect(joined).not.toContain("s3cr3t-detail-XYZ"); // message detail
    expect(joined).not.toContain("s3cr3t-body"); // response body
    // But the bounded contract code IS still extracted and logged.
    expect(structured).toContain("install_not_found");
  });

  it("strips control chars from the user-controlled package name in the log (CWE-117)", async () => {
    installBatchMock.mockImplementation(async () => {
      throw Object.assign(new Error("boom"), { httpStatus: 500 });
    });
    const { installExtensionPackage } = await import("../actions");
    const injected = "@cinatra-ai/x" + String.fromCharCode(10) + "[marketplace-install] FORGED";
    await installExtensionPackage(injected, "0.1.1", ACTOR);

    const structured = errSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("classify-failed"),
    ) as unknown[] | undefined;
    expect(structured).toBeTruthy();
    // The newline was replaced with a space — no forged second log line.
    const pkgArg = structured!.find(
      (a): a is string => typeof a === "string" && a.includes("FORGED"),
    );
    expect(pkgArg).toBeTruthy();
    expect(pkgArg).not.toContain(String.fromCharCode(10));
  });
});

describe("installExtensionPackageFormAction — threads the reference to the client (#1539)", () => {
  it("returns the diagnostic reference on a classified install failure", async () => {
    installBatchMock.mockImplementation(async () => {
      throw Object.assign(new Error("Marketplace install: HTTP 404"), {
        httpStatus: 404,
        responseBody: JSON.stringify({ code: "cinatra.install_not_found" }),
      });
    });
    const { installExtensionPackageFormAction } = await import("../actions");
    const result = await installExtensionPackageFormAction({
      packageName: "@cinatra-ai/x",
      packageVersion: "0.1.1",
    });

    expect(result).toBeTruthy();
    expect(result).toMatchObject({ ok: false, category: "unavailable-version" });
    expect((result as { reference?: string }).reference).toMatch(REF_RE);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("updateExtensionPackage — empty-version guard symmetry (#1539)", () => {
  it("rejects an empty version before the update request, with a reference", async () => {
    const { updateExtensionPackage } = await import("../actions");
    const res = await updateExtensionPackage("@cinatra-ai/x", "", ACTOR);

    expect(res.success).toBe(false);
    expect(res.failureCategory).toBe("unrecoverable");
    expect(res.reference).toMatch(REF_RE);
    expect(installBatchMock).not.toHaveBeenCalled();
  });
});

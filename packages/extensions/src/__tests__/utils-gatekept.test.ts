// Gatekept-install coverage for resolveExtensionTypeId +
// resolveExtensionPackageForLifecycle.
//
// Flag OFF → typeId/kind derive from a direct packument read (legacy).
// Flag ON  → typeId/kind/resolvedVersion come from the authorize response,
//            WITHOUT a packument read; origin/manifest are null (the broker
//            already gated storefront-visibility + entitlement upstream).
//
// The gatekept resolver + flag are injected via the `options` seam; the legacy
// path's registry reads are mocked so the OFF case never hits the network.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// Legacy-path registry reads (only exercised by the flag-OFF assertions).
const getAgentPackageMock = vi.fn();
const getPublishedExtensionKindMock = vi.fn();
const getPublishedExtensionSummaryMock = vi.fn();
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: getAgentPackageMock,
  getPublishedExtensionKind: getPublishedExtensionKindMock,
  getPublishedExtensionSummary: getPublishedExtensionSummaryMock,
}));

vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "https://registry.cinatra.ai",
    packageScope: "@cinatra-ai",
    token: "read-token",
    uiUrl: null,
  })),
}));

describe("resolveExtensionTypeId — gatekept install", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("flag OFF: derives typeId via a direct packument read, never calling the gatekept resolver", async () => {
    getAgentPackageMock.mockResolvedValue({ kind: "skill" });
    const resolveGatekept = vi.fn();
    const { resolveExtensionTypeId } = await import("../utils");
    const typeId = await resolveExtensionTypeId("@scope/ext", "1.2.3", {
      isGatekeptInstallEnabled: () => false,
      resolveGatekeptInstallConfig: resolveGatekept,
    });
    expect(typeId).toBe("skill");
    expect(resolveGatekept).not.toHaveBeenCalled();
    expect(getAgentPackageMock).toHaveBeenCalled();
  });

  it("flag ON: derives typeId from the authorize response kind, never reading a packument", async () => {
    const resolveGatekept = vi.fn(async () => ({
      authorize: { kind: "connector" as const, resolvedVersion: "1.2.3" },
    }));
    const { resolveExtensionTypeId } = await import("../utils");
    const typeId = await resolveExtensionTypeId("@scope/ext", "1.2.3", {
      isGatekeptInstallEnabled: () => true,
      resolveGatekeptInstallConfig: resolveGatekept,
    });
    expect(typeId).toBe("connector");
    expect(resolveGatekept).toHaveBeenCalledWith("@scope/ext", "1.2.3");
    // No direct packument read on the gatekept path.
    expect(getAgentPackageMock).not.toHaveBeenCalled();
    expect(getPublishedExtensionKindMock).not.toHaveBeenCalled();
  });

  it("flag ON: forwards 'latest' when no version is given", async () => {
    const resolveGatekept = vi.fn(async () => ({
      authorize: { kind: "agent" as const, resolvedVersion: "9.9.9" },
    }));
    const { resolveExtensionTypeId } = await import("../utils");
    await resolveExtensionTypeId("@scope/ext", undefined, {
      isGatekeptInstallEnabled: () => true,
      resolveGatekeptInstallConfig: resolveGatekept,
    });
    expect(resolveGatekept).toHaveBeenCalledWith("@scope/ext", "latest");
  });
});

describe("resolveExtensionPackageForLifecycle — gatekept install", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("flag OFF: resolves via a packument summary read, never calling the gatekept resolver", async () => {
    getPublishedExtensionSummaryMock.mockResolvedValue({
      kind: "agent",
      resolvedVersion: "2.0.0",
      manifest: { cinatra: { origin: { visibility: "public", scope: "@scope" } } },
    });
    const resolveGatekept = vi.fn();
    const { resolveExtensionPackageForLifecycle } = await import("../utils");
    const res = await resolveExtensionPackageForLifecycle("@scope/ext", "2.0.0", {
      isGatekeptInstallEnabled: () => false,
      resolveGatekeptInstallConfig: resolveGatekept,
    });
    expect(res.typeId).toBe("agent");
    expect(res.kind).toBe("agent");
    expect(res.resolvedVersion).toBe("2.0.0");
    expect(res.origin).toEqual({ visibility: "public", scope: "@scope" });
    expect(resolveGatekept).not.toHaveBeenCalled();
    expect(getPublishedExtensionSummaryMock).toHaveBeenCalled();
  });

  it("flag ON: resolves typeId/kind/resolvedVersion from authorize; origin + manifest are null; no packument read", async () => {
    const resolveGatekept = vi.fn(async () => ({
      authorize: { kind: "skill" as const, resolvedVersion: "3.1.4" },
    }));
    const { resolveExtensionPackageForLifecycle } = await import("../utils");
    const res = await resolveExtensionPackageForLifecycle("@scope/ext", "3.1.4", {
      isGatekeptInstallEnabled: () => true,
      resolveGatekeptInstallConfig: resolveGatekept,
    });
    expect(res.typeId).toBe("skill");
    expect(res.kind).toBe("skill");
    expect(res.resolvedVersion).toBe("3.1.4");
    expect(res.origin).toBeNull();
    expect(res.manifest).toBeNull();
    expect(resolveGatekept).toHaveBeenCalledWith("@scope/ext", "3.1.4");
    expect(getPublishedExtensionSummaryMock).not.toHaveBeenCalled();
  });
});

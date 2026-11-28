// The canonical install primitive (`extensions_install`) with the option a
// non-MCP caller passes (cinatra#4920): `allowedKinds` refuses a root of
// another kind after the primitive's own resolution and before any install
// work. Mocked at the registry read, the marketplace authorize and the batch
// boundary, so the primitive's own resolution and kind check run for real.

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";

const summaryMock = vi.fn();
const installBatchMock = vi.fn();
const gatekeptOn = vi.fn(() => false);
const authorizeMock = vi.fn();

vi.mock("@cinatra-ai/registries", () => ({
  listExtensionPackages: vi.fn(),
  getAgentPackage: vi.fn(),
  getPublishedExtensionSummary: (...a: unknown[]) => summaryMock(...a),
  vendorScopeOfPackage: (name: string) => name.split("/")[0],
}));
vi.mock("../index", () => ({ extensionRegistry: {} }));
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: (...a: unknown[]) => installBatchMock(...a),
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: vi.fn(async () => ({
    registryUrl: "http://localhost:4873",
    packageScope: "@example-org",
    token: "t",
  })),
}));
// A faithful stand-in for the grant context (`src/lib/extension-install-grant-context.ts`
// is `storage.run(ctx, fn)` / `storage.getStore() ?? null` over one
// AsyncLocalStorage) and for `resolveGatekeptInstallConfig`, which DERIVES the
// resolution from an active context and calls the marketplace authorize only
// outside one. So the authorize count below is the real authorize-once count.
const grantStorage = new AsyncLocalStorage<{ rootPackageName: string; resolution: unknown }>();
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: () => gatekeptOn(),
  resolveGatekeptInstallConfig: (...a: unknown[]) => {
    const ctx = grantStorage.getStore();
    if (ctx) return Promise.resolve(ctx.resolution);
    return authorizeMock(...a);
  },
}));
const grantContexts: unknown[] = [];
vi.mock("@/lib/extension-install-grant-context", () => ({
  withInstallGrantContext: (ctx: { rootPackageName: string; resolution: unknown }, fn: () => unknown) => {
    grantContexts.push(ctx);
    return grantStorage.run(ctx, fn);
  },
  getActiveInstallGrantContext: () => grantStorage.getStore() ?? null,
}));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => ({}) }));
vi.mock("@/lib/marketplace-credentials", () => ({ getEffectiveViewerScope: () => "@example-org" }));
vi.mock("@/lib/deployment-registry-config", () => ({ loadDeploymentRegistryConfig: vi.fn() }));

import { createExtensionsPrimitiveHandlers } from "../mcp/handlers";

const actor: Actor = { actorType: "human", source: "route", userId: "admin-1" };
const summary = (kind: string) => ({
  kind,
  resolvedVersion: "1.2.3",
  manifest: { cinatra: { kind } },
});
const authorized = (kind: string) => ({
  config: { registryUrl: "https://broker.example.test", packageScope: "@example-org", token: "grant", uiUrl: null },
  authorize: { kind, resolvedVersion: "1.2.3", closure: [], expiresAt: "2099-01-01T00:00:00Z" },
});

beforeEach(() => {
  summaryMock.mockReset();
  installBatchMock.mockReset();
  installBatchMock.mockResolvedValue({});
  gatekeptOn.mockReset();
  gatekeptOn.mockReturnValue(false);
  authorizeMock.mockReset();
  grantContexts.length = 0;
});

describe("extensions_install allowedKinds (cinatra#4920)", () => {
  it.each([["connector"], ["artifact"], ["workflow"]])(
    "a %s root is refused with EXTENSION_KIND_NOT_ALLOWED before the batch runs",
    async (kind) => {
      summaryMock.mockResolvedValue(summary(kind));
      const err = await createExtensionsPrimitiveHandlers()
        .extensions_install(
          { packageName: "@example-org/thing", packageVersion: "1.2.3" },
          actor,
          { allowedKinds: ["agent", "skill"] },
        )
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "EXTENSION_KIND_NOT_ALLOWED", kind });
      expect(installBatchMock).not.toHaveBeenCalled();
    },
  );

  it.each([["agent"], ["skill"]])("an allowed %s root installs through the batch", async (kind) => {
    summaryMock.mockResolvedValue(summary(kind));
    const result = await createExtensionsPrimitiveHandlers().extensions_install(
      { packageName: "@example-org/thing", packageVersion: "1.2.3" },
      actor,
      { allowedKinds: ["agent", "skill"] },
    );
    expect(result).toEqual({ success: true, packageName: "@example-org/thing", packageVersion: "1.2.3" });
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(installBatchMock).toHaveBeenCalledWith({
      packageName: "@example-org/thing",
      version: "1.2.3",
      actor,
    });
  });

  it("without options (the MCP tool) every kind still reaches the batch", async () => {
    summaryMock.mockResolvedValue(summary("connector"));
    await createExtensionsPrimitiveHandlers().extensions_install(
      { packageName: "@example-org/thing", packageVersion: "1.2.3" },
      actor,
    );
    expect(installBatchMock).toHaveBeenCalledTimes(1);
  });

  it("gatekept: the marketplace authorize runs first, and its kind refuses a connector before the batch", async () => {
    gatekeptOn.mockReturnValue(true);
    authorizeMock.mockResolvedValue(authorized("connector"));
    const err = await createExtensionsPrimitiveHandlers()
      .extensions_install(
        { packageName: "@example-org/thing", packageVersion: "1.2.3" },
        actor,
        { allowedKinds: ["agent", "skill"] },
      )
      .catch((e: unknown) => e);
    expect(authorizeMock).toHaveBeenCalledWith("@example-org/thing", "1.2.3");
    // The install body ran inside the root's grant context (authorize-once).
    expect(grantContexts).toHaveLength(1);
    expect(err).toMatchObject({ code: "EXTENSION_KIND_NOT_ALLOWED", kind: "connector" });
    expect(summaryMock).not.toHaveBeenCalled();
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it("gatekept: ONE authorize across resolution, the kind check and the batch, which runs inside the root's grant", async () => {
    gatekeptOn.mockReturnValue(true);
    authorizeMock.mockResolvedValue(authorized("agent"));
    let rootSeenByBatch: string | null = null;
    installBatchMock.mockImplementation(async () => {
      // The batch adopts an active context whose root is the package it installs.
      rootSeenByBatch = grantStorage.getStore()?.rootPackageName ?? null;
      return {};
    });
    const result = await createExtensionsPrimitiveHandlers().extensions_install(
      { packageName: "@example-org/thing", packageVersion: "1.2.3" },
      actor,
      { allowedKinds: ["agent", "skill"] },
    );
    expect(result).toEqual({ success: true, packageName: "@example-org/thing", packageVersion: "1.2.3" });
    expect(authorizeMock).toHaveBeenCalledTimes(1);
    expect(rootSeenByBatch).toBe("@example-org/thing");
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it.each([
    ["REQUIRES_REBUILD", "requiresRebuild"],
    ["AGENT_PACKAGE_CONTRACT_VIOLATION", "contractViolation"],
  ])("a raw %s error carrying the batch's compensationFailures keeps them on the structured result", async (code, flag) => {
    summaryMock.mockResolvedValue(summary("agent"));
    installBatchMock.mockRejectedValue(
      Object.assign(new Error("refused after a partial install"), {
        code,
        packageName: "@example-org/thing",
        missingFields: ["cinatra.riskLevel"],
        compensationFailures: ["@example-org/dep-left"],
      }),
    );
    const result = await createExtensionsPrimitiveHandlers().extensions_install(
      { packageName: "@example-org/thing", packageVersion: "1.2.3" },
      actor,
      { allowedKinds: ["agent", "skill"] },
    );
    expect(result).toMatchObject({ success: false, [flag]: true, compensationFailures: ["@example-org/dep-left"] });
  });

  it("a raw structured error with no compensation failures has no compensationFailures on the result", async () => {
    summaryMock.mockResolvedValue(summary("agent"));
    installBatchMock.mockRejectedValue(Object.assign(new Error("rebuild"), { code: "REQUIRES_REBUILD" }));
    const result = await createExtensionsPrimitiveHandlers().extensions_install(
      { packageName: "@example-org/thing", packageVersion: "1.2.3" },
      actor,
    );
    expect(result).toMatchObject({ success: false, requiresRebuild: true });
    expect(result).not.toHaveProperty("compensationFailures");
  });

  it("gatekept: a refused authorize stops the install before the batch", async () => {
    gatekeptOn.mockReturnValue(true);
    authorizeMock.mockRejectedValue(new Error("authorize failed: cinatra.install_not_entitled"));
    await expect(
      createExtensionsPrimitiveHandlers().extensions_install(
        { packageName: "@example-org/thing", packageVersion: "1.2.3" },
        actor,
        { allowedKinds: ["agent", "skill"] },
      ),
    ).rejects.toThrow(/install_not_entitled/);
    expect(installBatchMock).not.toHaveBeenCalled();
  });
});

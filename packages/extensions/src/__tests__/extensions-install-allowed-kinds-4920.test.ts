// The canonical install primitive (`extensions_install`) with the options a
// non-MCP caller passes (cinatra#4920): `allowedKinds` refuses a root of
// another kind after the primitive's own resolution and before any install
// work; the private-package visibility refusal carries a stable code. Mocked
// at the registry read and the batch boundary, so the primitive's own
// resolution, visibility gate and kind check run for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";

const summaryMock = vi.fn();
const installBatchMock = vi.fn();

vi.mock("@cinatra-ai/registries", () => ({
  listExtensionPackages: vi.fn(),
  getAgentPackage: vi.fn(),
  getPublishedExtensionSummary: (...a: unknown[]) => summaryMock(...a),
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
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: () => false,
  resolveGatekeptInstallConfig: vi.fn(),
}));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => ({}) }));
vi.mock("@/lib/marketplace-credentials", () => ({ getEffectiveViewerScope: () => "@example-org" }));
vi.mock("@/lib/deployment-registry-config", () => ({ loadDeploymentRegistryConfig: vi.fn() }));

import { createExtensionsPrimitiveHandlers } from "../mcp/handlers";

const actor: Actor = { actorType: "human", source: "route", userId: "admin-1" };
const summary = (kind: string, origin?: Record<string, unknown>) => ({
  kind,
  resolvedVersion: "1.2.3",
  manifest: { cinatra: { kind, ...(origin ? { origin } : {}) } },
});

beforeEach(() => {
  summaryMock.mockReset();
  installBatchMock.mockReset();
  installBatchMock.mockResolvedValue({});
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

  it("a private package of another viewer scope is refused with EXTENSION_NOT_VISIBLE before the kind check and the batch", async () => {
    // What this proves: the primitive's CONDITIONAL visibility check, when a
    // manifest carries `cinatra.origin`. The current publish path does not
    // write `cinatra.origin` (see the note above `isPackageVisible` in
    // packages/registries/src/verdaccio/client.ts), so for real published
    // packages this check does not fire today; the origin block below is a
    // constructed input, not the shape a published package has.
    summaryMock.mockResolvedValue(summary("connector", { visibility: "private", scope: "@other-org" }));
    const err = await createExtensionsPrimitiveHandlers()
      .extensions_install(
        { packageName: "@example-org/thing", packageVersion: "1.2.3" },
        actor,
        { allowedKinds: ["agent", "skill"] },
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "EXTENSION_NOT_VISIBLE" });
    expect((err as Error).message).toBe(
      "Package @example-org/thing is private and not accessible from this instance.",
    );
    expect(installBatchMock).not.toHaveBeenCalled();
  });
});

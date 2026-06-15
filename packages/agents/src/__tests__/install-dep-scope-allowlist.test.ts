// Regression coverage for issue #103: the full-tree installer must key the
// dependency-scope allowlist on the ROOT package's own vendor scope + the
// first-party base scope — NEVER on the installing instance's namespace
// (resolvedConfig.packageScope). A first-party @cinatra-ai/* package must be
// installable on an instance whose namespace is anything at all, and a vendor
// package may depend on the first-party base layer.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { installPackageWithDependenciesMock, triggerWayflowReloadMock } = vi.hoisted(() => ({
  installPackageWithDependenciesMock: vi.fn(),
  triggerWayflowReloadMock: vi.fn(),
}));

vi.mock("@cinatra-ai/registries", async () => {
  // Real (pure, dependency-free) vendor-scope helpers; capture the typeConfig
  // the installer passes to the resolver entry point.
  const scope = await vi.importActual<typeof import("../../../registries/src/scope")>(
    "../../../registries/src/scope",
  );
  return {
    ...scope,
    installPackageWithDependencies: installPackageWithDependenciesMock,
    extractAgentPackage: vi.fn(),
    cleanupExtractedAgentPackage: vi.fn(),
    ensureConfig: (config: unknown) => config,
  };
});

// The heavy host-coupled chains are irrelevant to the seam under test.
// (verdaccio/package-contract and verdaccio/cli-flags stay real — pure.)
vi.mock("../import-export-actions", () => ({
  createLocalAgentTemplateVersion: vi.fn(),
}));
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplate: vi.fn(),
  updateAgentTemplatePackageVersion: vi.fn(),
  createAgentVersion: vi.fn(),
}));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("@cinatra-ai/objects/auto-registrar", () => ({
  ensureDynamicObjectType: vi.fn(),
}));
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: {} }));
vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: vi.fn(() => "/tmp/agents"),
}));
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: vi.fn(),
  commitMaterialize: vi.fn(),
  rollbackMaterialize: vi.fn(),
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: triggerWayflowReloadMock,
}));

import { installAgentPackageWithDependencies } from "../install-from-package";

const INSTANCE_SCOPED_CONFIG = {
  registryUrl: "https://r.example",
  // Deliberately an instance-namespace scope (the issue #103 trigger shape):
  // the allowlist must NOT be derived from this.
  packageScope: "@curly-african-blonde",
  token: "tok",
  uiUrl: null,
};

function mockResolvedTree(rootName: string) {
  const root = {
    packageName: rootName,
    resolvedVersion: "1.0.0",
    tarballUrl: "https://r.example/t.tgz",
    integrity: "sha512-x",
    requestedRange: "*",
    dependencies: {},
  };
  installPackageWithDependenciesMock.mockResolvedValue({
    tree: { root, all: new Map([[rootName, root]]) },
    installedCount: 1,
    results: ["tpl-1"],
  });
}

describe("installAgentPackageWithDependencies — dep-scope allowlist derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default the reload to success so the scope-allowlist tests below (which do
    // not care about the reload) are unaffected; reload-surfacing tests override
    // this per-call with mockResolvedValueOnce / mockRejectedValueOnce.
    triggerWayflowReloadMock.mockResolvedValue({ ok: true });
  });

  it("keys the allowlist on a FIRST-PARTY root's scope, not the instance namespace", async () => {
    mockResolvedTree("@cinatra-ai/blog-idea-generator-agent");
    await installAgentPackageWithDependencies(
      { packageName: "@cinatra-ai/blog-idea-generator-agent" },
      INSTANCE_SCOPED_CONFIG,
    );
    const arg = installPackageWithDependenciesMock.mock.calls[0]?.[0] as {
      typeConfig: { scopePrefixes: readonly string[] };
      conflictPolicy: string;
    };
    expect([...arg.typeConfig.scopePrefixes]).toEqual(["@cinatra-ai/"]);
    expect(arg.conflictPolicy).toBe("prefer-newer");
  });

  it("allows a VENDOR root's own scope plus the first-party base scope", async () => {
    mockResolvedTree("@acme/widget");
    await installAgentPackageWithDependencies(
      { packageName: "@acme/widget" },
      INSTANCE_SCOPED_CONFIG,
    );
    const arg = installPackageWithDependenciesMock.mock.calls[0]?.[0] as {
      typeConfig: { scopePrefixes: readonly string[] };
    };
    expect([...arg.typeConfig.scopePrefixes].sort()).toEqual(["@acme/", "@cinatra-ai/"]);
    // The instance-namespace scope must never appear in the allowlist.
    expect(arg.typeConfig.scopePrefixes).not.toContain("@curly-african-blonde/");
  });
});

describe("installAgentPackageWithDependencies — reload result surfacing (#157)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a NON-THROWING {ok:false} reload result verbatim (reason NOT remapped)", async () => {
    mockResolvedTree("@cinatra-ai/some-agent");
    triggerWayflowReloadMock.mockResolvedValueOnce({ ok: false, reason: "timeout", detail: "aborted" });
    const res = await installAgentPackageWithDependencies(
      { packageName: "@cinatra-ai/some-agent" },
      INSTANCE_SCOPED_CONFIG,
    );
    // Install completed despite reload failure (durable writes already landed).
    expect(res.rootTemplateId).toBe("tpl-1");
    // The reloader's own result passes straight through VERBATIM — both reason
    // and detail are preserved, NOT remapped to the "network" thrown-error shape.
    expect(res.wayflowReload).toMatchObject({ ok: false, reason: "timeout", detail: "aborted" });
  });

  it("maps a THROWN reload error to the typed {ok:false, reason:'network'} shape and still resolves", async () => {
    mockResolvedTree("@cinatra-ai/some-agent");
    triggerWayflowReloadMock.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await installAgentPackageWithDependencies(
      { packageName: "@cinatra-ai/some-agent" },
      INSTANCE_SCOPED_CONFIG,
    );
    expect(res.rootTemplateId).toBe("tpl-1");
    expect(res.wayflowReload).toMatchObject({ ok: false, reason: "network" });
    expect((res.wayflowReload as { detail?: string }).detail).toContain("socket hang up");
  });
});

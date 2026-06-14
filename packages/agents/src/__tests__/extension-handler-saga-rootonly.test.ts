// #157 — COLLAPSE THE SECOND RESOLVER.
//
// The agent extension handler must install ROOT-ONLY when the batch saga owns
// the dependency fan-out (isSagaOwnedFanoutActive() === true) — calling
// installAgentFromPackage (single package) and NEVER the second
// @cinatra-ai/registries dep-resolver (installAgentPackageWithDependencies).
//
// Outside the saga (the direct extensionRegistry.install/update callers: UI
// extension update, MCP extensions_update, reinstall-latest) the context is
// absent and the handler keeps its full-tree behavior — installs via
// installAgentPackageWithDependencies — so those paths still pull in
// newly-required dependencies.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveInstallEnvironmentMock } = vi.hoisted(() => ({
  resolveInstallEnvironmentMock: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolveInstallEnvironment: resolveInstallEnvironmentMock,
}));

// No skills/ dir → registerSkillsFromPackage is a clean no-op.
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  }),
  readFile: vi.fn(),
}));

// The saga-owned-fan-out toggle is driven per-test via this hoisted spy.
const { sagaActiveSpy } = vi.hoisted(() => ({ sagaActiveSpy: vi.fn(() => false) }));

vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(async () => ({
    rootTemplateId: "tpl-tree",
    installedTemplateIds: ["tpl-tree"],
    tree: {},
  })),
  installAgentFromPackage: vi.fn(async () => ({ templateId: "tpl-root" })),
  isSagaOwnedFanoutActive: () => sagaActiveSpy(),
  extractAgentPackage: vi.fn(async () => ({
    packageName: "@scope/ext",
    packageVersion: "1.2.3",
    manifest: {},
    payload: {},
    readme: null,
    tempDir: "/tmp/ext",
  })),
  cleanupExtractedAgentPackage: vi.fn(async () => {}),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplate: vi.fn(),
  readActiveExtensionTemplates: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ attributes: {} })),
  deleteAgentSkillsForSlugs: vi.fn(),
  enqueueInlineForAgent: vi.fn(async () => {}),
  cleanupForAgent: vi.fn(async () => {}),
}));

vi.mock("@cinatra-ai/registries", async () => {
  const scope = await vi.importActual<typeof import("../../../registries/src/scope")>(
    "../../../registries/src/scope",
  );
  class InstanceNamespaceNotConfiguredError extends Error {}
  return { ...scope, InstanceNamespaceNotConfiguredError };
});

// withInstallLock is dynamically imported; make it a pass-through.
vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

import { createAgentExtensionHandler } from "../extension-handler";
import {
  installAgentFromPackage,
  installAgentPackageWithDependencies,
} from "@cinatra-ai/agents";

const BROKER_URL = "https://marketplace.cinatra.ai/install/v1";
const mockActor = { userId: "u1", organizationId: "org-1", source: "ui" as const, actorType: "human" as const };

describe("createAgentExtensionHandler — #157 saga collapses the second resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sagaActiveSpy.mockReturnValue(false);
    resolveInstallEnvironmentMock.mockResolvedValue({
      args: [`--registry=${BROKER_URL}`, `--//marketplace.cinatra.ai/:_authToken=opaque.grant`],
      registryUrl: BROKER_URL,
      routingMode: "shared-acl",
    });
  });

  it("INSIDE the saga (fan-out active): install is ROOT-ONLY — installAgentFromPackage, NOT the second resolver", async () => {
    sagaActiveSpy.mockReturnValue(true);
    const handler = createAgentExtensionHandler();
    await handler.install({ packageName: "@scope/ext", version: "1.2.3" } as never, mockActor as never);

    expect(installAgentFromPackage).toHaveBeenCalledTimes(1);
    expect(installAgentFromPackage).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@scope/ext", packageVersion: "1.2.3" }),
      expect.anything(),
    );
    // The second registries dep-resolver MUST NOT run inside the saga.
    expect(installAgentPackageWithDependencies).not.toHaveBeenCalled();
  });

  it("INSIDE the saga: update is also ROOT-ONLY", async () => {
    sagaActiveSpy.mockReturnValue(true);
    const handler = createAgentExtensionHandler();
    await handler.update({ packageName: "@scope/ext", version: "2.0.0" } as never, mockActor as never);

    expect(installAgentFromPackage).toHaveBeenCalledTimes(1);
    expect(installAgentPackageWithDependencies).not.toHaveBeenCalled();
  });

  it("OUTSIDE the saga (fan-out inactive): install keeps the full-tree resolver — direct paths still pull in deps", async () => {
    sagaActiveSpy.mockReturnValue(false);
    const handler = createAgentExtensionHandler();
    await handler.install({ packageName: "@scope/ext", version: "1.2.3" } as never, mockActor as never);

    expect(installAgentPackageWithDependencies).toHaveBeenCalledTimes(1);
    expect(installAgentFromPackage).not.toHaveBeenCalled();
  });

  it("OUTSIDE the saga: update keeps the full-tree resolver", async () => {
    sagaActiveSpy.mockReturnValue(false);
    const handler = createAgentExtensionHandler();
    await handler.update({ packageName: "@scope/ext", version: "2.0.0" } as never, mockActor as never);

    expect(installAgentPackageWithDependencies).toHaveBeenCalledTimes(1);
    expect(installAgentFromPackage).not.toHaveBeenCalled();
  });
});

// extensions_uninstall and extensions_force_delete must trigger WayFlow reload
// and disk cleanup after the DB ops complete. The agent extension handler's
// `uninstall(ref, actor)` is the single point that does this;
// extensions_force_delete reaches it via extensionRegistry.forceDelete which
// calls handler.uninstall.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rmDirForRolledBackInstall: vi.fn(),
  triggerReloadAfterRollback: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  deleteAgentSkillsForSlugs: vi.fn(),
  cleanupForAgent: vi.fn(),
}));

vi.mock("../extension-handler-rollback", () => ({
  rmDirForRolledBackInstall: mocks.rmDirForRolledBackInstall,
  triggerReloadAfterRollback: mocks.triggerReloadAfterRollback,
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  deleteAgentSkillsForSlugs: mocks.deleteAgentSkillsForSlugs,
  parseFrontmatter: vi.fn(),
  enqueueInlineForAgent: vi.fn(),
  cleanupForAgent: mocks.cleanupForAgent,
}));
vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(),
  extractAgentPackage: vi.fn(),
  cleanupExtractedAgentPackage: vi.fn(),
  deleteAgentTemplate: mocks.deleteAgentTemplate,
  readAgentTemplateByPackageName: mocks.readAgentTemplateByPackageName,
  updateAgentTemplate: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => {
  class PluginDependencyCycleError extends Error {}
  class InstanceNamespaceNotConfiguredError extends Error {}
  return { PluginDependencyCycleError, InstanceNamespaceNotConfiguredError };
});
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(),
}));

import { createAgentExtensionHandler } from "../extension-handler";

const mockActor = {
  userId: "user-1",
  organizationId: "org-1",
  source: "ui" as const,
  actorType: "human" as const,
};
const mockRef = {
  registryUrl: "https://registry.example.com",
  packageName: "@cinatra/test-agent",
  version: "1.0.0",
};

describe("agent extension handler — uninstall reload + disk cleanup", () => {
  beforeEach(() => {
    mocks.rmDirForRolledBackInstall.mockReset();
    mocks.triggerReloadAfterRollback.mockReset();
    mocks.readAgentTemplateByPackageName.mockReset();
    mocks.deleteAgentTemplate.mockReset();
    mocks.deleteAgentSkillsForSlugs.mockReset();
    mocks.cleanupForAgent.mockReset();
  });

  it("uninstall calls rmDirForRolledBackInstall + triggerReloadAfterRollback after DB delete", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValueOnce({ id: "tpl-1" });
    mocks.deleteAgentTemplate.mockResolvedValueOnce(true);
    mocks.deleteAgentSkillsForSlugs.mockResolvedValueOnce(undefined);
    mocks.cleanupForAgent.mockResolvedValueOnce(undefined);
    mocks.rmDirForRolledBackInstall.mockResolvedValueOnce(undefined);
    mocks.triggerReloadAfterRollback.mockResolvedValueOnce(undefined);

    const handler = createAgentExtensionHandler();
    await handler.uninstall(mockRef, mockActor);

    expect(mocks.deleteAgentTemplate).toHaveBeenCalledWith("tpl-1");
    expect(mocks.rmDirForRolledBackInstall).toHaveBeenCalledWith(
      "@cinatra/test-agent",
    );
    expect(mocks.triggerReloadAfterRollback).toHaveBeenCalledTimes(1);
  });

  it("uninstall is a no-op when the template doesn't exist (no disk cleanup, no reload)", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValueOnce(null);

    const handler = createAgentExtensionHandler();
    await handler.uninstall(mockRef, mockActor);

    expect(mocks.deleteAgentTemplate).not.toHaveBeenCalled();
    expect(mocks.rmDirForRolledBackInstall).not.toHaveBeenCalled();
    expect(mocks.triggerReloadAfterRollback).not.toHaveBeenCalled();
  });

  it("disk cleanup failure is non-fatal (DB delete already succeeded)", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValueOnce({ id: "tpl-1" });
    mocks.deleteAgentTemplate.mockResolvedValueOnce(true);
    mocks.deleteAgentSkillsForSlugs.mockResolvedValueOnce(undefined);
    mocks.cleanupForAgent.mockResolvedValueOnce(undefined);
    mocks.rmDirForRolledBackInstall.mockRejectedValueOnce(
      new Error("ENOENT: directory missing"),
    );

    const handler = createAgentExtensionHandler();
    // Critical: uninstall MUST NOT throw — DB delete is the durable signal.
    await expect(
      handler.uninstall(mockRef, mockActor),
    ).resolves.toBeUndefined();
  });

  it("reload failure is non-fatal", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValueOnce({ id: "tpl-1" });
    mocks.deleteAgentTemplate.mockResolvedValueOnce(true);
    mocks.deleteAgentSkillsForSlugs.mockResolvedValueOnce(undefined);
    mocks.cleanupForAgent.mockResolvedValueOnce(undefined);
    mocks.rmDirForRolledBackInstall.mockResolvedValueOnce(undefined);
    mocks.triggerReloadAfterRollback.mockRejectedValueOnce(
      new Error("wayflow unreachable"),
    );

    const handler = createAgentExtensionHandler();
    await expect(
      handler.uninstall(mockRef, mockActor),
    ).resolves.toBeUndefined();
  });

  it("archive does NOT trigger disk cleanup or reload (status-flag only)", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValueOnce({ id: "tpl-1" });

    const handler = createAgentExtensionHandler();
    await handler.archive(mockRef, mockActor);

    expect(mocks.rmDirForRolledBackInstall).not.toHaveBeenCalled();
    expect(mocks.triggerReloadAfterRollback).not.toHaveBeenCalled();
  });

  it("restore does NOT trigger disk cleanup or reload (status-flag only)", async () => {
    mocks.readAgentTemplateByPackageName.mockResolvedValueOnce({ id: "tpl-1" });

    const handler = createAgentExtensionHandler();
    await handler.restore(mockRef, mockActor);

    expect(mocks.rmDirForRolledBackInstall).not.toHaveBeenCalled();
    expect(mocks.triggerReloadAfterRollback).not.toHaveBeenCalled();
  });
});

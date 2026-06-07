// Mocks target @cinatra-ai/agents, the merged surface that owns
// installAgentPackageWithDependencies and store fns.
// The @cinatra-ai/registries mock exports InstanceNamespaceNotConfiguredError
// because the handler imports it. The @/lib/verdaccio-config mock covers the
// dynamic import inside installAndRegisterSkills.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(),
  extractAgentPackage: vi.fn(),
  cleanupExtractedAgentPackage: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(),
  updateAgentTemplate: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  deleteAgentSkillsForSlugs: vi.fn(),
  parseFrontmatter: vi.fn(),
}));

vi.mock("@cinatra-ai/registries", () => {
  class PluginDependencyCycleError extends Error {
    constructor(public cyclePath: string[]) {
      super(`Dependency cycle detected: ${cyclePath.join(" -> ")}`);
      this.name = "PluginDependencyCycleError";
    }
  }
  // The handler imports InstanceNamespaceNotConfiguredError, so this mock must
  // export it.
  class InstanceNamespaceNotConfiguredError extends Error {
    constructor() {
      super("Instance namespace not configured");
      this.name = "InstanceNamespaceNotConfiguredError";
    }
  }
  return { PluginDependencyCycleError, InstanceNamespaceNotConfiguredError };
});

// Mock @/lib/verdaccio-config — dynamically imported inside installAndRegisterSkills.
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(),
}));

// extension-handler is the unit under test.
import { createAgentExtensionHandler } from "../extension-handler";
import {
  installAgentPackageWithDependencies,
  extractAgentPackage,
  cleanupExtractedAgentPackage,
  deleteAgentTemplate,
  readAgentTemplateByPackageName,
  updateAgentTemplate,
} from "@cinatra-ai/agents";
import { upsertSkill, deleteAgentSkillsForSlugs, parseFrontmatter } from "@cinatra-ai/skills";
import { PluginDependencyCycleError } from "@cinatra-ai/registries";
import { loadVerdaccioConfigForServer } from "@/lib/verdaccio-config";
import { readdir, readFile } from "node:fs/promises";

const mockActor = { userId: "user-1", organizationId: "org-1", source: "ui" as const, actorType: "human" as const };
const mockRef = { registryUrl: "https://registry.example.com", packageName: "@cinatra/test-agent", version: "1.0.0" };
const installedResult = { rootTemplateId: "tpl-123", installedTemplateIds: ["tpl-123"], tree: {} as never };

// Real ExtractedAgentPackage shape (no oasJson field)
const extractedPackage = {
  packageName: "@cinatra/test-agent",
  packageVersion: "1.0.0",
  manifest: {},
  payload: {},
  readme: null,
  tempDir: "/tmp/test-pkg",
};

describe("createAgentExtensionHandler", () => {
  let handler: ReturnType<typeof createAgentExtensionHandler>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-set verdaccio config mock after reset — used by installAndRegisterSkills.
    vi.mocked(loadVerdaccioConfigForServer).mockResolvedValue({ registryUrl: "https://verdaccio.example.com" } as never);
    handler = createAgentExtensionHandler();
  });

  it("install: calls installAgentPackageWithDependencies and returns rootTemplateId", async () => {
    vi.mocked(installAgentPackageWithDependencies).mockResolvedValue(installedResult);
    vi.mocked(extractAgentPackage).mockResolvedValue(extractedPackage);
    vi.mocked(cleanupExtractedAgentPackage).mockResolvedValue(undefined);
    // No skills directory — readdir rejects so skill registration short-circuits
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

    const result = await handler.install(mockRef, mockActor);

    expect(installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: mockRef.packageName }),
      expect.anything(),
    );
    expect(result).toMatchObject({ rootTemplateId: "tpl-123" });
  });

  it("install: registers skills found in extracted package", async () => {
    vi.mocked(installAgentPackageWithDependencies).mockResolvedValue(installedResult);
    vi.mocked(extractAgentPackage).mockResolvedValue(extractedPackage);
    vi.mocked(cleanupExtractedAgentPackage).mockResolvedValue(undefined);
    vi.mocked(upsertSkill).mockResolvedValue({} as never);
    // Simulate a skills/ directory with one skill subdirectory
    vi.mocked(readdir).mockResolvedValue([{ isDirectory: () => true, name: "skill-a" }] as never);
    vi.mocked(readFile).mockResolvedValue("---\nname: Skill A\ndescription: Test skill\n---\n# Skill A\n" as never);
    vi.mocked(parseFrontmatter).mockReturnValue({
      attributes: { name: "Skill A", description: "Test skill" },
      body: "# Skill A\n",
      frontmatter: "name: Skill A\ndescription: Test skill",
    } as never);

    await handler.install(mockRef, mockActor);

    expect(upsertSkill).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent", packageName: "@cinatra/test-agent", skillId: expect.stringContaining("skill-a") }),
    );
  });

  it("install: rolls back (deleteAgentTemplate) when skill registration fails", async () => {
    vi.mocked(installAgentPackageWithDependencies).mockResolvedValue(installedResult);
    vi.mocked(extractAgentPackage).mockResolvedValue(extractedPackage);
    vi.mocked(cleanupExtractedAgentPackage).mockResolvedValue(undefined);
    vi.mocked(readdir).mockResolvedValue([{ isDirectory: () => true, name: "skill-b" }] as never);
    vi.mocked(readFile).mockResolvedValue("---\nname: Skill B\n---\n" as never);
    vi.mocked(parseFrontmatter).mockReturnValue({ attributes: { name: "Skill B" }, body: "", frontmatter: "" } as never);
    vi.mocked(upsertSkill).mockRejectedValue(new Error("skill store error"));
    vi.mocked(deleteAgentTemplate).mockResolvedValue(true);

    await expect(handler.install(mockRef, mockActor)).rejects.toThrow();

    expect(deleteAgentTemplate).toHaveBeenCalledWith("tpl-123");
  });

  it("update: calls installAgentPackageWithDependencies with new ref", async () => {
    const newRef = { ...mockRef, version: "2.0.0" };
    vi.mocked(installAgentPackageWithDependencies).mockResolvedValue(installedResult);
    vi.mocked(extractAgentPackage).mockResolvedValue({ ...extractedPackage, packageVersion: "2.0.0" } as never);
    vi.mocked(cleanupExtractedAgentPackage).mockResolvedValue(undefined);
    vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

    await handler.update(newRef, mockActor);

    expect(installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ packageVersion: "2.0.0" }),
      expect.anything(),
    );
  });

  it("uninstall: deletes template row and deregisters skills", async () => {
    const callOrder: string[] = [];
    vi.mocked(readAgentTemplateByPackageName).mockResolvedValue({ id: "tpl-999", packageName: mockRef.packageName } as never);
    vi.mocked(deleteAgentSkillsForSlugs).mockImplementation(async () => {
      callOrder.push("skills");
      return { deletedIds: [] };
    });
    vi.mocked(deleteAgentTemplate).mockImplementation(async () => {
      callOrder.push("template");
      return true;
    });

    await handler.uninstall(mockRef, mockActor);

    expect(deleteAgentTemplate).toHaveBeenCalledWith("tpl-999");
    expect(deleteAgentSkillsForSlugs).toHaveBeenCalled();
    expect(callOrder).toEqual(["skills", "template"]);
  });

  it("cycle error propagation: PluginDependencyCycleError is NOT caught by handler", async () => {
    vi.mocked(installAgentPackageWithDependencies).mockRejectedValue(
      new PluginDependencyCycleError(["pkg-a", "pkg-b", "pkg-a"]),
    );

    await expect(handler.install(mockRef, mockActor)).rejects.toThrow(PluginDependencyCycleError);
  });

  describe("archive/restore", () => {
    // Canonical archive/restore is owned by the dispatcher (extensions
    // syncCanonicalManifestTransition). The agent extension-handler's
    // archive/restore are intentional no-ops because it must not call
    // updateAgentTemplate with the removed extensionLifecycleStatus field.
    it("archive is a no-op (canonical write owned by dispatcher)", async () => {
      vi.mocked(readAgentTemplateByPackageName).mockResolvedValue({ id: "tpl-archive-1", packageName: mockRef.packageName } as never);
      vi.mocked(updateAgentTemplate).mockResolvedValue({} as never);

      await handler.archive(mockRef, mockActor);

      // No DB writes from the handler.
      expect(updateAgentTemplate).not.toHaveBeenCalled();
    });

    it("restore is a no-op (canonical write owned by dispatcher)", async () => {
      vi.mocked(readAgentTemplateByPackageName).mockResolvedValue({ id: "tpl-restore-1", packageName: mockRef.packageName } as never);
      vi.mocked(updateAgentTemplate).mockResolvedValue({} as never);

      await handler.restore(mockRef, mockActor);

      expect(updateAgentTemplate).not.toHaveBeenCalled();
    });
  });
});

// Gatekept-install: the agent extension handler must thread the
// install ref's VERSION into resolveInstallEnvironment so the gatekept-install
// path (when enabled) authorizes the EXACT listed version. On the legacy path
// the version is simply ignored, so this is non-breaking. The resolved config
// (broker + grant when gatekept) is reused for BOTH the dep install and the
// skill-scan SECOND root fetch — covered here by asserting both
// installAgentPackageWithDependencies and extractAgentPackage receive it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveInstallEnvironmentMock } = vi.hoisted(() => ({
  resolveInstallEnvironmentMock: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolveInstallEnvironment: resolveInstallEnvironmentMock,
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err; // no skills/ dir → registerSkillsFromPackage is a clean no-op
  }),
  readFile: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  installAgentPackageWithDependencies: vi.fn(async () => ({
    rootTemplateId: "tpl-1",
    installedTemplateIds: ["tpl-1"],
    tree: {},
  })),
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

vi.mock("@cinatra-ai/registries", () => {
  class InstanceNamespaceNotConfiguredError extends Error {}
  return { InstanceNamespaceNotConfiguredError };
});

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));

// withInstallLock is dynamically imported; make it a pass-through.
vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

import { createAgentExtensionHandler } from "../extension-handler";
import {
  installAgentPackageWithDependencies,
  extractAgentPackage,
} from "@cinatra-ai/agents";

const BROKER_URL = "https://marketplace.cinatra.ai/install/v1";
const mockActor = { userId: "u1", organizationId: "org-1", source: "ui" as const, actorType: "human" as const };

describe("createAgentExtensionHandler — gatekept version threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Broker-pointed install env: the _authToken arg carries the opaque grant.
    resolveInstallEnvironmentMock.mockResolvedValue({
      args: [`--registry=${BROKER_URL}`, `--//marketplace.cinatra.ai/:_authToken=opaque.grant`],
      registryUrl: BROKER_URL,
      routingMode: "shared-acl",
    });
  });

  it("install threads ref.version into resolveInstallEnvironment", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install({ packageName: "@scope/ext", version: "1.2.3" } as never, mockActor as never);
    expect(resolveInstallEnvironmentMock).toHaveBeenCalledWith("@scope/ext", "1.2.3");
  });

  it("update threads ref.version into resolveInstallEnvironment", async () => {
    const handler = createAgentExtensionHandler();
    await handler.update({ packageName: "@scope/ext", version: "2.0.0" } as never, mockActor as never);
    expect(resolveInstallEnvironmentMock).toHaveBeenCalledWith("@scope/ext", "2.0.0");
  });

  it("reuses the resolved (broker+grant) config for BOTH the dep install and the skill-scan root fetch", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install({ packageName: "@scope/ext", version: "1.2.3" } as never, mockActor as never);

    // Dep install received the broker config (registryUrl = broker, token = grant).
    const installCfg = vi.mocked(installAgentPackageWithDependencies).mock.calls[0]?.[1] as {
      registryUrl: string;
      token: string;
    };
    expect(installCfg.registryUrl).toBe(BROKER_URL);
    expect(installCfg.token).toBe("opaque.grant");

    // Skill-scan SECOND root fetch (extractAgentPackage) received the SAME config.
    const extractCfg = vi.mocked(extractAgentPackage).mock.calls[0]?.[1] as {
      registryUrl: string;
      token: string;
    };
    expect(extractCfg.registryUrl).toBe(BROKER_URL);
    expect(extractCfg.token).toBe("opaque.grant");
  });
});

// cinatra#3204 criterion 16 — the chosen install scope reaches the agent kind's
// NATIVE row, not only the canonical `installed_extension` row.
//
// Modelled on extension-handler-saga-rootonly.test.ts: the same mock set, so the
// handler runs for real and only its collaborators are stubbed.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveInstallEnvironmentMock } = vi.hoisted(() => ({
  resolveInstallEnvironmentMock: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolveInstallEnvironment: resolveInstallEnvironmentMock,
}));

const { resolveFinalizedStorePayloadMock } = vi.hoisted(() => ({
  resolveFinalizedStorePayloadMock: vi.fn(async (input: { packageName: string }) => ({
    storeDir: `/tmp/store/agent/${input.packageName}/deadbeef`,
    digest: "d".repeat(128),
    version: "1.2.3",
    registryUrl: null,
  })),
}));
vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: (...a: unknown[]) =>
    resolveFinalizedStorePayloadMock(...(a as [never])),
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  }),
  readFile: vi.fn(),
}));

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
  readArchivedExtensionTemplates: vi.fn(async () => []),
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

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

import { createAgentExtensionHandler } from "../extension-handler";
import { installAgentPackageWithDependencies, installAgentFromPackage } from "@cinatra-ai/agents";

const BROKER_URL = "https://marketplace.cinatra.ai/install/v1";
const actor = {
  userId: "u1",
  orgId: "org-1",
  source: "ui" as const,
  actorType: "human" as const,
};

describe("the agent handler anchors its native row at the CHOSEN scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sagaActiveSpy.mockReturnValue(false);
    resolveInstallEnvironmentMock.mockResolvedValue({
      args: [`--registry=${BROKER_URL}`, `--//marketplace.cinatra.ai/:_authToken=opaque.grant`],
      registryUrl: BROKER_URL,
      routingMode: "shared-acl",
    });
  });

  it("carries a WORKSPACE-anchored install to the template's workspace owner tier", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install(
      { packageName: "@scope/ext", version: "1.2.3" } as never,
      actor as never,
      {
        rowOwnership: {
          ownerLevel: "workspace",
          ownerId: null,
          organizationId: null,
        },
      } as never,
    );
    expect(installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorOrgId: null,
        ownerLevel: "workspace",
      }),
      expect.anything(),
    );
  });

  it("carries a TEAM target's org anchor rather than re-deriving one from the actor", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install(
      { packageName: "@scope/ext", version: "1.2.3" } as never,
      actor as never,
      {
        rowOwnership: {
          ownerLevel: "organization",
          ownerId: "org-1",
          organizationId: "org-1",
        },
      } as never,
    );
    expect(installAgentPackageWithDependencies).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorOrgId: "org-1",
        ownerLevel: "organization",
        ownerId: "org-1",
      }),
      expect.anything(),
    );
  });

  it("is unchanged when no anchor is planned — no owner tier is stamped", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install(
      { packageName: "@scope/ext", version: "1.2.3" } as never,
      actor as never,
    );
    const call = (installAgentPackageWithDependencies as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.anchorOrgId).toBe("org-1");
    expect(call.ownerLevel).toBeUndefined();
    expect(call.ownerId).toBeUndefined();
  });
});

describe("a SUPPLIED package is installed root-only — there is no registry closure to plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sagaActiveSpy.mockReturnValue(false);
    resolveInstallEnvironmentMock.mockResolvedValue({
      args: [`--registry=${BROKER_URL}`, `--//marketplace.cinatra.ai/:_authToken=opaque.grant`],
      registryUrl: BROKER_URL,
      routingMode: "shared-acl",
    });
  });

  it("a ref declaring SUPPLIED provenance never reaches the dependency planner", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install(
      {
        packageName: "@scope/ext",
        version: "1.2.3",
        provenance: { type: "local", path: "abc.tgz", contentDigest: "a".repeat(64) },
      } as never,
      actor as never,
      { rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null } } as never,
    );
    // The planner resolves EVERY node through the extension registry, and a
    // supplied package is published on none: that resolve either fails or, worse,
    // succeeds against a different package of the same name.
    expect(installAgentPackageWithDependencies).not.toHaveBeenCalled();
    expect(installAgentFromPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@scope/ext",
        requireStorePayload: true,
        ownerLevel: "workspace",
      }),
      expect.anything(),
    );
  });

  it("a REGISTRY ref still plans its closure — the road is unchanged for it", async () => {
    const handler = createAgentExtensionHandler();
    await handler.install(
      { packageName: "@scope/ext", version: "1.2.3" } as never,
      actor as never,
    );
    expect(installAgentPackageWithDependencies).toHaveBeenCalledTimes(1);
    expect(installAgentFromPackage).not.toHaveBeenCalled();
  });
});

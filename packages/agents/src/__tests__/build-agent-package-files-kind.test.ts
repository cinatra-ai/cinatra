/**
 * `buildAgentPackageFiles()` (the DB-template publish path used by
 * `publishAgentPackage()` / `agent_registry_publish` / UI publish action) must
 * emit `cinatra.kind: "agent"` and `cinatra.apiVersion: "cinatra.ai/v1"` on
 * every published manifest.
 *
 * This covers the path that builds its manifest via `buildAgentPackageFiles()`.
 * Without kind/apiVersion metadata, the marketplace agent-tab filter cannot
 * identify the package as an agent.
 *
 * This test locks the manifest output shape across the DB-template publish path.
 */
import { describe, expect, it } from "vitest";
import { buildAgentPackageFiles, type BuildAgentPackageInput } from "../verdaccio/package-files";

const baseTemplate = {
  id: "tpl-test",
  orgId: "org-1",
  name: "Test Agent",
  description: "Built via buildAgentPackageFiles for the manifest metadata regression test",
  sourceNl: "n/a",
  taskSpec: "n/a",
  type: "leaf" as const,
  status: "draft" as const,
  packageName: "@cinatra/test-agent",
  packageVersion: null,
  inputSchema: {},
  outputSchema: null,
  approvalPolicy: { steps: [] },
  hitlScreens: [],
  compiledPlan: [],
  executionProvider: "wayflow" as const,
  triggerMode: "manual" as const,
  gatedSteps: [],
  ownerLevel: "organization" as const,
  ownerId: "org-1",
  agentDependencies: null,
  origin: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseVersion = {
  id: "ver-test",
  templateId: "tpl-test",
  versionNumber: 1,
  contentHash: "abcdef0123456789",
  snapshot: {} as Record<string, unknown>,
  createdAt: new Date(),
};

const baseInput: BuildAgentPackageInput = {
  template: baseTemplate as never,
  version: baseVersion as never,
  semver: "0.1.0",
  title: "Test Agent",
  description: "Test description",
  changelog: null,
  riskLevel: "low",
  toolAccess: [],
  hasApprovalGates: false,
  publishedAt: new Date("2026-05-11T00:00:00Z"),
};

const baseConfig = {
  registryUrl: "http://127.0.0.1:4873",
  packageScope: "@cinatra",
};

describe("buildAgentPackageFiles - cinatra.kind + apiVersion injection", () => {
  it("manifest.cinatra.kind === 'agent' on every output", () => {
    const result = buildAgentPackageFiles(baseInput, baseConfig as never);
    expect(result.manifest.cinatra.kind).toBe("agent");
  });

  it("manifest.cinatra.apiVersion === 'cinatra.ai/v1' on every output", () => {
    const result = buildAgentPackageFiles(baseInput, baseConfig as never);
    expect(result.manifest.cinatra.apiVersion).toBe("cinatra.ai/v1");
  });

  it("kind + apiVersion present in the serialized package.json file string", () => {
    const result = buildAgentPackageFiles(baseInput, baseConfig as never);
    const parsed = JSON.parse(result.files["package.json"]) as {
      cinatra?: { kind?: string; apiVersion?: string };
    };
    expect(parsed.cinatra?.kind).toBe("agent");
    expect(parsed.cinatra?.apiVersion).toBe("cinatra.ai/v1");
  });

  it("preserves other metadata fields alongside kind + apiVersion", () => {
    const result = buildAgentPackageFiles(baseInput, baseConfig as never);
    const meta = result.manifest.cinatra;
    expect(meta.packageType).toBe("agent");
    expect(meta.manifestVersion).toBe(1);
    expect(meta.sourceTemplateId).toBe("tpl-test");
    expect(meta.sourceVersionId).toBe("ver-test");
    expect(meta.sourceVersionNumber).toBe(1);
    expect(meta.type).toBe("leaf");
    expect(meta.kind).toBe("agent");
    expect(meta.apiVersion).toBe("cinatra.ai/v1");
  });

  it("emits agentDependencies + kind + apiVersion when deps are present", () => {
    const result = buildAgentPackageFiles(
      { ...baseInput, agentDependencies: { "@cinatra/foo": "^0.1.0" } },
      baseConfig as never,
    );
    const meta = result.manifest.cinatra;
    expect(meta.kind).toBe("agent");
    expect(meta.apiVersion).toBe("cinatra.ai/v1");
    expect(meta.agentDependencies).toEqual({ "@cinatra/foo": "^0.1.0" });
  });
});

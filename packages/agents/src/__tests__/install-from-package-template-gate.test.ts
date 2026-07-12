// cinatra#1032 deliverable 3 — the PROJECT-TEMPLATE kind gate is WIRED into
// the agent install path: a package shipping cinatra/project-template.json
// whose worker refs violate the exact-match rule (or whose template is
// structurally invalid) is REFUSED in the INERT window — before the disk
// materialize and before any agent_templates/version write — with the
// structured ProjectTemplateContractViolationError. These tests drive the
// REAL installAgentFromPackage (and the REAL gate + sdk validators) with the
// same collaborator mocks as the edge-persistence suite, but with a REAL
// on-disk extract fixture so the gate's file read is exercised end-to-end.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const WORKER_PKG = "@cinatra-ai/draft-writer-agent";

const EDGES = [
  {
    packageName: WORKER_PKG,
    kind: "agent",
    edgeType: "runtime",
    versionConstraint: { kind: "exact", version: "1.0.0" },
    requirement: "required",
  },
];

// Mutable fixture dir the extract mock points at (set per test).
const fixture = vi.hoisted(() => ({ dir: "" }));

vi.mock("@cinatra-ai/extensions/manifest-dependencies", () => ({
  parseManifestDependencyEdges: vi.fn(() => ({ edges: EDGES, source: "canonical" })),
  resolveLiveCanonicalEdgeTargets: vi.fn(async () => []),
  writeDependencyEdgesToCanonicalRows: vi.fn(async () => ({ patchedRowIds: [] })),
  versionConstraintToRange: (vc: { kind: string; range?: string; version?: string; ref?: string }) =>
    vc.kind === "semver-range" ? vc.range! : vc.kind === "exact" ? vc.version! : vc.ref!,
}));
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  checkRequiredExtensionVersionPin: () => ({ ok: true }),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/registries", () => ({
  ensureConfig: (c: unknown) =>
    c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  extractAgentPackage: async () => ({
    packageName: "@cinatra-ai/release-announcement-agent",
    packageVersion: "1.0.0",
    tempDir: fixture.dir,
    manifest: {
      name: "@cinatra-ai/release-announcement-agent",
      version: "1.0.0",
      cinatra: { packageType: "agent-package", manifestVersion: "1", type: "leaf" },
    },
    payload: {
      title: "Pkg",
      description: "d",
      template: { name: "Pkg", description: "d", sourceNl: "src" },
      version: { snapshot: { nodes: [] } },
    },
  }),
  cleanupExtractedAgentPackage: async () => {},
  dependencyScopePrefixesFor: () => ["@cinatra-ai/"],
  installPackageWithDependencies: async () => {
    throw new Error("not used in this test");
  },
}));
vi.mock("../verdaccio/package-contract", () => ({
  agentPackageManifestSchema: { parse: (x: unknown) => x },
  parseAgentPackageManifestForInstall: (x: unknown) => x,
  CINATRA_AGENT_PACKAGE_TYPE: "agent-package",
  CINATRA_AGENT_MANIFEST_VERSION: "1",
}));
vi.mock("../verdaccio/cli-flags", () => ({ buildRegistryAuthArgs: () => [] }));

const createLocal = vi.fn(async () => ({ templateId: "tpl-fresh", versionId: "ver-fresh" }));
vi.mock("../import-export-actions", () => ({
  createLocalAgentTemplateVersion: (...a: unknown[]) => createLocal(...(a as [])),
}));

const readTemplate = vi.fn(async (): Promise<{ id: string; status: string } | null> => null);
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (...a: unknown[]) => readTemplate(...(a as [])),
  updateAgentTemplate: vi.fn(async () => {}),
  updateAgentTemplatePackageVersion: vi.fn(async () => {}),
  createAgentVersion: vi.fn(async () => {}),
}));

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async () => ({
    ok: true,
    value: {
      approvalPolicy: { steps: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: null,
      prompt: null,
      packageName: "@cinatra-ai/release-announcement-agent",
      packageVersion: "1.0.0",
      agentDependencies: {},
      type: "leaf",
      compiledPlan: [],
      hitlScreens: [],
      llmConfig: null,
      toolboxes: [],
      agentSpecVersion: "26.1.0",
      producesObjectTypes: [],
      triggerMode: "full",
      gatedSteps: [],
      cinatraConfig: null,
    },
  }),
}));
vi.mock("@cinatra-ai/objects/auto-registrar", () => ({ ensureDynamicObjectType: async () => ({}) }));
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { has: () => false } }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/tmp/agents-fixture",
  resolveDevExtensionSourceRoot: () => "/tmp/agents-fixture",
}));

const materialize = vi.fn(async () => ({
  materialized: true,
  targetDir: "/tmp/agents-fixture/pkg",
  wasReinstall: false,
}));
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: (...a: unknown[]) => materialize(...(a as [])),
  commitMaterialize: async () => {},
  rollbackMaterialize: async () => {},
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({ triggerWayflowReload: async () => ({ ok: true }) }));

import { installAgentFromPackage } from "../install-from-package";
import { ProjectTemplateContractViolationError } from "../project-template-install-gate";

const template = (workerPackage: string, version: string) => ({
  formatVersion: "cinatra.ai/project-template@1",
  id: "launch-plan",
  name: "Launch plan",
  anchor: { id: "launch" },
  tasks: [
    {
      id: "draft",
      title: "Write the draft",
      worker: {
        role: "draft-writer",
        packageName: workerPackage,
        versionConstraint: { kind: "exact", version },
      },
    },
  ],
});

beforeEach(async () => {
  vi.clearAllMocks();
  readTemplate.mockResolvedValue(null);
  fixture.dir = await mkdtemp(join(tmpdir(), "install-template-gate-"));
});
afterEach(async () => {
  await rm(fixture.dir, { recursive: true, force: true });
});

async function shipTemplate(t: unknown): Promise<void> {
  await mkdir(join(fixture.dir, "cinatra"), { recursive: true });
  await writeFile(join(fixture.dir, "cinatra", "project-template.json"), JSON.stringify(t), "utf8");
}

describe("installAgentFromPackage — project-template kind gate wiring", () => {
  it("installs a template-less package unchanged (gate no-ops)", async () => {
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/release-announcement-agent" });
    expect(res.templateId).toBe("tpl-fresh");
  });

  it("installs a package whose template worker refs exact-match its dependency edges", async () => {
    await shipTemplate(template(WORKER_PKG, "1.0.0"));
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/release-announcement-agent" });
    expect(res.templateId).toBe("tpl-fresh");
    expect(materialize).toHaveBeenCalled();
  });

  it("REFUSES a worker ref absent from the dependency edges — in the INERT window (nothing mutates)", async () => {
    await shipTemplate(template("@cinatra-ai/undeclared-agent", "1.0.0"));
    await expect(
      installAgentFromPackage({ packageName: "@cinatra-ai/release-announcement-agent" }),
    ).rejects.toThrow(ProjectTemplateContractViolationError);
    expect(materialize).not.toHaveBeenCalled();
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("REFUSES a version-mismatched worker ref (exact-match rule, not name-match)", async () => {
    await shipTemplate(template(WORKER_PKG, "2.0.0"));
    await expect(
      installAgentFromPackage({ packageName: "@cinatra-ai/release-announcement-agent" }),
    ).rejects.toMatchObject({ code: "PROJECT_TEMPLATE_CONTRACT_VIOLATION" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES a structurally invalid template before anything mutates", async () => {
    await shipTemplate({ formatVersion: "wrong", id: "x", name: "", anchor: {}, tasks: [] });
    await expect(
      installAgentFromPackage({ packageName: "@cinatra-ai/release-announcement-agent" }),
    ).rejects.toThrow(ProjectTemplateContractViolationError);
    expect(materialize).not.toHaveBeenCalled();
    expect(createLocal).not.toHaveBeenCalled();
  });
});

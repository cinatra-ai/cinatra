// cinatra#1056 — install-time runtime-gate projection.
//
// Drives the REAL installAgentFromPackage with collaborators mocked, asserting
// that the canonical `cinatra.dependencies` edges are projected onto the two
// runtime-gate columns the seed writes: `connector_dependencies` (every
// kind:"connector" edge, carrying its requirement) and `agent_dependencies`
// (REQUIRED kind:"agent" edges only, as a bare range). Optional agent edges and
// kind-less edges are NOT projected. Mirrors the mock scaffold of
// install-from-package-edge-persistence.test.ts.
import { describe, expect, it, vi, beforeEach } from "vitest";

const EDGES = [
  {
    packageName: "@cinatra-ai/wordpress-mcp-connector",
    kind: "connector",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "^1.0.0" },
    requirement: "required",
  },
  {
    packageName: "@cinatra-ai/apollo-connector",
    kind: "connector",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "^2.0.0" },
    requirement: "optional",
  },
  {
    packageName: "@cinatra-ai/sub-agent",
    kind: "agent",
    edgeType: "runtime",
    versionConstraint: { kind: "exact", version: "3.1.0" },
    requirement: "required",
  },
  {
    packageName: "@cinatra-ai/opt-agent",
    kind: "agent",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "^0.1.0" },
    requirement: "optional",
  },
];

const EXPECTED_CONNECTOR = {
  "@cinatra-ai/wordpress-mcp-connector": { range: "^1.0.0", requirement: "required" },
  "@cinatra-ai/apollo-connector": { range: "^2.0.0", requirement: "optional" },
};
// cinatra#1058: REQUIRED agent edges project as a bare range string; OPTIONAL
// agent edges now project as `{ range, requirement: "optional" }` so the
// orchestrator-readiness gate can route them to stop-run-hitl (they were
// DROPPED under #1056's deliberate deferral, which this wave reverses).
const EXPECTED_AGENT = {
  "@cinatra-ai/sub-agent": "3.1.0",
  "@cinatra-ai/opt-agent": { range: "^0.1.0", requirement: "optional" },
};

vi.mock("@cinatra-ai/extensions/manifest-dependencies", () => ({
  parseManifestDependencyEdges: vi.fn(() => ({ edges: EDGES, source: "canonical" })),
  resolveLiveCanonicalEdgeTargets: vi.fn(async () => [{ id: "row-1", packageName: "@cinatra-ai/pkg" }]),
  writeDependencyEdgesToCanonicalRows: vi.fn(async () => ({ patchedRowIds: ["row-1"] })),
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
  isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s),
  assertSafePathSegment: (s: unknown, label = "path segment"): void => {
    const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s);
    if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s));
  },
  ensureConfig: (c: unknown) => c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  extractAgentPackage: async () => ({
    packageName: "@cinatra-ai/pkg",
    packageVersion: "1.0.0",
    tempDir: "/tmp/extract-fixture",
    manifest: {
      name: "@cinatra-ai/pkg",
      version: "1.0.0",
      cinatra: { packageType: "agent-package", manifestVersion: "1", type: "orchestrator" },
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

const createLocal = vi.fn(async (..._a: unknown[]) => ({ templateId: "tpl-fresh", versionId: "ver-fresh" }));
vi.mock("../import-export-actions", () => ({
  createLocalAgentTemplateVersion: (...a: unknown[]) => createLocal(...(a as [])),
}));

const readTemplate = vi.fn(async (): Promise<{ id: string; status: string } | null> => null);
const updateTemplate = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (...a: unknown[]) => readTemplate(...(a as [])),
  updateAgentTemplate: (...a: unknown[]) => updateTemplate(...(a as [])),
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
      packageName: "@cinatra-ai/pkg",
      packageVersion: "1.0.0",
      agentDependencies: {},
      type: "orchestrator",
      compiledPlan: [],
      hitlScreens: [],
      llmConfig: null,
      toolboxes: [],
      agentSpecVersion: "26.1.0",
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
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: async () => ({ materialized: true, targetDir: "/tmp/agents-fixture/pkg", wasReinstall: false }),
  commitMaterialize: async () => {},
  rollbackMaterialize: async () => {},
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({ triggerWayflowReload: async () => ({ ok: true }) }));

import { installAgentFromPackage } from "../install-from-package";

beforeEach(() => {
  vi.clearAllMocks();
  readTemplate.mockResolvedValue(null);
});

describe("installAgentFromPackage — cinatra#1056 runtime-gate projection", () => {
  it("FRESH branch: seeds connector_dependencies (with requirement) + agent edges (required bare, optional requirement-carrying) into the template seed", async () => {
    await installAgentFromPackage({ packageName: "@cinatra-ai/pkg" });
    expect(createLocal).toHaveBeenCalledTimes(1);
    const seed = (createLocal.mock.calls[0][0] as { seed: Record<string, unknown> }).seed;
    expect(seed.connectorDependencies).toEqual(EXPECTED_CONNECTOR);
    expect(seed.agentDependencies).toEqual(EXPECTED_AGENT);
  });

  it("UPSERT branch: patches the same projected maps onto the existing row", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-1", status: "active" });
    await installAgentFromPackage({ packageName: "@cinatra-ai/pkg" });
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    const patch = updateTemplate.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.connectorDependencies).toEqual(EXPECTED_CONNECTOR);
    expect(patch.agentDependencies).toEqual(EXPECTED_AGENT);
  });
});

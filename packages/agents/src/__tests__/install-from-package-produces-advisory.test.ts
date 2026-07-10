// cinatra#1059 — install-time produced-artifact ADVISORY.
//
// Drives the REAL installAgentFromPackage with collaborators mocked, asserting
// that an agent whose `cinatra.produces` artifact extension is NOT installed
// gets a NON-BLOCKING `missingProducedArtifacts` advisory on the install result
// (install still succeeds), and that an installed produced-artifact clears it —
// on BOTH the fresh-install and the upsert finalize branches. Mirrors the mock
// scaffold of install-from-package-runtime-projection.test.ts.
import { describe, expect, it, vi, beforeEach } from "vitest";

const ART = "@cinatra-ai/blog-post-artifact";

// Configurable canonical-store rows the advisory reads. Default: none installed.
let ARTIFACT_ROWS: Array<{
  packageName: string;
  kind: string;
  status: string;
  organizationId: string | null;
}> = [];

vi.mock("@cinatra-ai/extensions/manifest-dependencies", () => ({
  parseManifestDependencyEdges: vi.fn(() => ({ edges: [], source: "canonical" })),
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
  readInstalledExtensionsByPackageNames: vi.fn(async (names: readonly string[]) => {
    const out = new Map<string, typeof ARTIFACT_ROWS>();
    for (const r of ARTIFACT_ROWS) {
      if (!names.includes(r.packageName)) continue;
      const b = out.get(r.packageName);
      if (b) b.push(r);
      else out.set(r.packageName, [r]);
    }
    return out;
  }),
}));

vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s),
  assertSafePathSegment: (s: unknown, label = "path segment"): void => {
    const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s);
    if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s));
  },
  ensureConfig: (c: unknown) => c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  extractAgentPackage: async () => ({
    packageName: "@cinatra-ai/blog-draft-writer-agent",
    packageVersion: "1.0.0",
    tempDir: "/tmp/extract-fixture",
    manifest: {
      name: "@cinatra-ai/blog-draft-writer-agent",
      version: "1.0.0",
      cinatra: {
        packageType: "agent-package",
        manifestVersion: "1",
        type: "orchestrator",
        produces: [{ extension: ART }],
      },
    },
    payload: {
      title: "Blog draft writer",
      description: "d",
      template: { name: "Blog draft writer", description: "d", sourceNl: "src" },
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
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      packageVersion: "1.0.0",
      agentDependencies: {},
      type: "orchestrator",
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
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: async () => ({ materialized: true, targetDir: "/tmp/agents-fixture/pkg", wasReinstall: false }),
  commitMaterialize: async () => {},
  rollbackMaterialize: async () => {},
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({ triggerWayflowReload: async () => ({ ok: true }) }));

import { installAgentFromPackage } from "../install-from-package";

const activeRow = (organizationId: string | null) => ({
  packageName: ART,
  kind: "artifact",
  status: "active",
  organizationId,
});

beforeEach(() => {
  vi.clearAllMocks();
  readTemplate.mockResolvedValue(null);
  ARTIFACT_ROWS = [];
});

describe("installAgentFromPackage — cinatra#1059 produced-artifact advisory", () => {
  it("FRESH branch: produced artifact NOT installed → advisory names it, install still succeeds", async () => {
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1" });
    expect(res.templateId).toBeTruthy();
    expect(res.missingProducedArtifacts).toEqual([ART]);
  });

  it("FRESH branch: produced artifact installed+governing → empty advisory", async () => {
    ARTIFACT_ROWS = [activeRow("org-1")];
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1" });
    expect(res.missingProducedArtifacts).toEqual([]);
  });

  it("FRESH branch: produced artifact ARCHIVED → still advisory (missing)", async () => {
    ARTIFACT_ROWS = [{ ...activeRow("org-1"), status: "archived" }];
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1" });
    expect(res.missingProducedArtifacts).toEqual([ART]);
  });

  it("FRESH branch: produced artifact live only for ANOTHER org → still advisory (missing)", async () => {
    ARTIFACT_ROWS = [activeRow("org-2")];
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1" });
    expect(res.missingProducedArtifacts).toEqual([ART]);
  });

  it("FRESH branch: ambient (null-org) install satisfies any org", async () => {
    ARTIFACT_ROWS = [activeRow(null)];
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1" });
    expect(res.missingProducedArtifacts).toEqual([]);
  });

  it("DISPATCHER path: org scope falls back to anchorOrgId (orgId omitted) → artifact for that org is NOT missing", async () => {
    // The saga-owned fan-out passes only `anchorOrgId`, not `orgId`. The
    // artifact is active only for that org (no ambient null-org row); it must
    // resolve, not be falsely reported missing.
    ARTIFACT_ROWS = [activeRow("org-9")];
    const res = await installAgentFromPackage({
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      anchorOrgId: "org-9",
    });
    expect(res.missingProducedArtifacts).toEqual([]);
  });

  it("UPSERT branch: surfaces the advisory consistently with the fresh branch", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1" });
    expect(res.templateId).toBe("tpl-existing");
    expect(res.missingProducedArtifacts).toEqual([ART]);
  });
});

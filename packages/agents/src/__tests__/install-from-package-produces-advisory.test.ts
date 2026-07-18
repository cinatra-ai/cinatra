// cinatra#1788 (epic #1785) — install-time TYPED-PRODUCTION preflight.
//
// Drives the REAL installAgentFromPackage with collaborators mocked, asserting
// the manifest `cinatra.produces` contract is enforced FAIL-CLOSED before any
// write: an agent whose produces entry does not resolve to a REQUIRED
// artifact-kind dependency (or to a claimed objectTypeId of one) has its
// install REFUSED with a precise error naming the missing claimant/claim; a
// conforming agent installs. The retired #1059 advisory (`missingProducedArtifacts`)
// and install-time dynamic-type minting (`ensureDynamicObjectType`) are gone —
// asserted here too (AC2: dynamic_object_types untouched). The real contract
// (resolveTypedProducesContract) runs via importOriginal; only the schema-parse
// stub is overridden so the compact fixture manifest reaches the preflight.
import { describe, expect, it, vi, beforeEach } from "vitest";

const ART = "@cinatra-ai/blog-post-artifact";
const TYPE = "@cinatra-ai/blog-post-artifact:post";
const OTHER_TYPE = "@cinatra-ai/blog-post-artifact:comment";

// Configurable agent manifest slices (produces + required deps) and the
// registry manifests the preflight resolves for each required artifact dep.
let PRODUCES: Array<{ extension: string; objectTypeId?: string }> = [];
let DEPENDENCIES: unknown[] = [];
let ARTIFACT_MANIFESTS: Record<string, unknown> = {};
// The version a semver-range edge resolves to (null = no satisfying version).
let MAX_SATISFYING: string | null = "1.0.0";

const requiredArtifactEdge = (packageName: string) => ({
  packageName,
  kind: "artifact",
  edgeType: "install-time",
  requirement: "required",
  versionConstraint: { kind: "semver-range", range: "^1.0.0" },
});

/** An artifact-kind package manifest declaring `objectTypes` claims. */
const artifactManifest = (packageName: string, types: string[]) => ({
  name: packageName,
  version: "1.0.0",
  cinatra: {
    kind: "artifact",
    artifact: { objectTypes: types.map((type) => ({ type, claim: "dedicated" })) },
  },
});

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
}));

vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s),
  assertSafePathSegment: (s: unknown, label = "path segment"): void => {
    const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s);
    if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s));
  },
  ensureConfig: (c: unknown) => c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  // The preflight resolves each required artifact dep's PINNED version, then its
  // PUBLISHED manifest. The fixture edges use a semver-range, so the preflight
  // calls resolveMaxSatisfyingVersion first.
  resolveMaxSatisfyingVersion: async () => MAX_SATISFYING,
  getPublishedExtensionSummary: async ({ packageName }: { packageName: string }) => ({
    kind: "artifact" as const,
    resolvedVersion: "1.0.0",
    manifest: ARTIFACT_MANIFESTS[packageName] ?? null,
  }),
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
        produces: PRODUCES,
        dependencies: DEPENDENCIES,
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

// Keep the REAL typed-produces contract (resolveTypedProducesContract) so the
// preflight logic is under test; only stub the schema parse + type constants so
// the compact fixture manifest ("agent-package"/"1") reaches the preflight.
vi.mock("../verdaccio/package-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../verdaccio/package-contract")>();
  return {
    ...actual,
    parseAgentPackageManifestForInstall: (x: unknown) => x,
    CINATRA_AGENT_PACKAGE_TYPE: "agent-package",
    CINATRA_AGENT_MANIFEST_VERSION: "1",
  };
});
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

// buildAgentTemplateInstallSeed compiles the OAS; return a minimal compiled root
// (no `producesObjectTypes` — that field is retired).
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
      triggerMode: "full",
      gatedSteps: [],
      cinatraConfig: null,
    },
  }),
}));

// AC2 guard: install-path dynamic-type minting is retired. This mutator must
// NEVER be called (install-from-package no longer imports it either).
const ensureDynamicObjectType = vi.fn(async () => ({}));
vi.mock("@cinatra-ai/objects/auto-registrar", () => ({
  ensureDynamicObjectType: (...a: unknown[]) => ensureDynamicObjectType(...(a as [])),
}));
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { resolve: () => null } }));
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

const install = (extra?: Record<string, unknown>) =>
  installAgentFromPackage({ packageName: "@cinatra-ai/blog-draft-writer-agent", orgId: "org-1", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  readTemplate.mockResolvedValue(null);
  PRODUCES = [];
  DEPENDENCIES = [];
  ARTIFACT_MANIFESTS = {};
  MAX_SATISFYING = "1.0.0";
});

describe("installAgentFromPackage — cinatra#1788 typed-production preflight", () => {
  it("conforming: produces objectTypeId claimed by a required artifact dep → installs, no dynamic type minted", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [TYPE]) };
    const res = await install();
    expect(res.templateId).toBeTruthy();
    expect(ensureDynamicObjectType).not.toHaveBeenCalled();
  });

  it("conforming coarse: produces without objectTypeId, extension is a required artifact dep → installs", async () => {
    PRODUCES = [{ extension: ART }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, []) };
    const res = await install();
    expect(res.templateId).toBeTruthy();
  });

  it("BLOCKS: produces objectTypeId NOT claimed by the required artifact dep → refused, names the claim", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [OTHER_TYPE]) };
    await expect(install()).rejects.toThrow(/typed-production contract failed/);
    await expect(install()).rejects.toThrow(TYPE);
    expect(createLocal).not.toHaveBeenCalled();
    expect(ensureDynamicObjectType).not.toHaveBeenCalled();
  });

  it("BLOCKS: produces names an extension that is NOT a required artifact dependency → refused", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = []; // no required artifact-kind dependency edge
    await expect(install()).rejects.toThrow(/not a REQUIRED artifact-kind dependency/);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("BLOCKS: an OPTIONAL artifact dependency does not satisfy a typed produces entry", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [{ ...requiredArtifactEdge(ART), requirement: "optional" }];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [TYPE]) };
    await expect(install()).rejects.toThrow(/not a REQUIRED artifact-kind dependency/);
  });

  it("BLOCKS: an unsatisfiable version range fails closed even if the manifest would claim the type (F2)", async () => {
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)]; // semver-range edge
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [TYPE]) };
    MAX_SATISFYING = null; // no published version satisfies the range → fail closed
    await expect(install()).rejects.toThrow(/typed-production contract failed/);
    expect(createLocal).not.toHaveBeenCalled();
  });

  it("no produces → no-op, installs", async () => {
    PRODUCES = [];
    const res = await install();
    expect(res.templateId).toBeTruthy();
  });

  it("UPSERT branch: enforces the contract identically (refuses a violating re-install before any write)", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    PRODUCES = [{ extension: ART, objectTypeId: TYPE }];
    DEPENDENCIES = [requiredArtifactEdge(ART)];
    ARTIFACT_MANIFESTS = { [ART]: artifactManifest(ART, [OTHER_TYPE]) };
    await expect(install()).rejects.toThrow(/typed-production contract failed/);
    expect(updateTemplate).not.toHaveBeenCalled();
  });
});

/**
 * cinatra#2047 defect D-1 — the MANIFEST INGESTION path for the lifecycle
 * declaration.
 *
 * The acceptance run's D-1 finding: "no merged extension manifest declares
 * repairCapable" — because no install path ever compiled a `cinatra.lifecycle`
 * block onto `agent_templates.lifecycle_config`, the column the
 * `changes_requested` route reads. These cases drive the REAL
 * `installAgentFromPackage` with collaborators mocked and assert the declaration
 * lands on the row through all THREE install branches (fresh / upsert / 23505
 * race), and that a version DROPPING the block CLEARS the column rather than
 * leaving a stale `repairCapable` behind.
 *
 * Harness mirrors `install-from-package-produces-advisory.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PKG = "@cinatra-ai/repairing-agent";

/** The `cinatra.lifecycle` block the fixture tarball's manifest declares. */
let LIFECYCLE: unknown = undefined;

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
vi.mock("@cinatra-ai/extensions/agent-produces-reader", () => ({
  readAgentProducesFromPackageManifest: () => [],
}));

vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: () => true,
  assertSafePathSegment: () => {},
  ensureConfig: (c: unknown) =>
    c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  resolveMaxSatisfyingVersion: async () => "1.0.0",
  getPublishedExtensionSummary: async () => ({ kind: "agent" as const, resolvedVersion: "1.0.0", manifest: null }),
  extractAgentPackage: async () => ({
    packageName: PKG,
    packageVersion: "1.0.0",
    tempDir: "/tmp/extract-fixture-2047",
    manifest: {
      name: PKG,
      version: "1.0.0",
      cinatra: {
        packageType: "agent-package",
        manifestVersion: "1",
        type: "leaf",
        ...(LIFECYCLE === undefined ? {} : { lifecycle: LIFECYCLE }),
      },
    },
    payload: {
      title: "Repairing agent",
      description: "d",
      template: { name: "Repairing agent", description: "d", sourceNl: "src" },
      version: { snapshot: { nodes: [] } },
    },
  }),
  cleanupExtractedAgentPackage: async () => {},
  dependencyScopePrefixesFor: () => ["@cinatra-ai/"],
  installPackageWithDependencies: async () => {
    throw new Error("not used in this test");
  },
}));

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

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async () => ({
    ok: true,
    value: {
      approvalPolicy: { steps: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: null,
      prompt: null,
      packageName: PKG,
      packageVersion: "1.0.0",
      agentDependencies: {},
      type: "leaf",
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
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { resolve: () => null } }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/tmp/agents-fixture",
  resolveDevExtensionSourceRoot: () => "/tmp/agents-fixture",
}));
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: async () => ({
    materialized: true,
    targetDir: "/tmp/agents-fixture/pkg",
    wasReinstall: false,
  }),
  commitMaterialize: async () => {},
  rollbackMaterialize: async () => {},
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({ triggerWayflowReload: async () => ({ ok: true }) }));

import { installAgentFromPackage } from "../install-from-package";

const install = () => installAgentFromPackage({ packageName: PKG, orgId: "org-1" });

const freshSeed = () => (createLocal.mock.calls[0]?.[0] as { seed: Record<string, unknown> }).seed;
const upsertPatch = () => updateTemplate.mock.calls[0]?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  // mockClear does NOT drop queued `*Once` implementations — reset both mocks
  // whose defaults a per-case override replaces, or the race case's rejection
  // leaks into the next test.
  createLocal.mockReset();
  createLocal.mockImplementation(async () => ({ templateId: "tpl-fresh", versionId: "ver-fresh" }));
  readTemplate.mockReset();
  readTemplate.mockResolvedValue(null);
  LIFECYCLE = undefined;
});

describe("cinatra#2047 D-1 — installAgentFromPackage compiles cinatra.lifecycle onto the template row", () => {
  it("FRESH install: a declared block lands on lifecycle_config as JSON-as-text", async () => {
    LIFECYCLE = { repairCapable: true, producedTypes: ["artifact-blog-post-body"] };
    await install();
    expect(freshSeed().lifecycleConfig).toBe(
      JSON.stringify({ producedTypes: ["artifact-blog-post-body"], repairCapable: true }),
    );
  });

  it("FRESH install: no block ⇒ null (back-compat with every published package)", async () => {
    await install();
    expect(freshSeed().lifecycleConfig).toBeNull();
  });

  it("UPSERT (re-install): the declaration is re-projected onto the existing row", async () => {
    LIFECYCLE = { repairCapable: true };
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(upsertPatch().lifecycleConfig).toBe(JSON.stringify({ repairCapable: true }));
  });

  it("UPSERT: a version that DROPS the block CLEARS the column (no stale repairCapable)", async () => {
    LIFECYCLE = undefined;
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    // Passed EXPLICITLY as null, not omitted — omitting would leave the stale
    // value on the row and keep routing repairs to a producer that no longer
    // declares the capability.
    expect(upsertPatch()).toHaveProperty("lifecycleConfig", null);
  });

  it("RACE (23505 on the fresh INSERT): the upsert fallback writes the same value", async () => {
    LIFECYCLE = { repairCapable: true, requestedSkips: ["recommendation"] };
    readTemplate.mockResolvedValueOnce(null).mockResolvedValue({ id: "tpl-raced", status: "active" });
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await install();
    expect(upsertPatch().lifecycleConfig).toBe(
      JSON.stringify({ repairCapable: true, requestedSkips: ["recommendation"] }),
    );
  });

  it("a MALFORMED block does not crash the install (fail-soft ⇒ no declaration)", async () => {
    LIFECYCLE = { repairCapable: "yes", producedTypes: "not-an-array" };
    await install();
    expect(freshSeed().lifecycleConfig).toBeNull();
  });
});

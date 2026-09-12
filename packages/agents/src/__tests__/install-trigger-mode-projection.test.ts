import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
/**
 * cinatra#3033 — THE COMPILED TRIGGER CLASSIFICATION MUST REACH THE ROW.
 *
 * `compileOasAgentJson` derives `triggerMode` from the agent's runtime and, for
 * a `full` mode, the `gatedSteps` the per-run trigger gate holds. The MCP
 * install handler has always persisted both onto `agent_templates`. The registry
 * install seed did not: it built the row seed from the same compile result and
 * dropped these two fields, so `trigger_mode` and `gated_steps` landed NULL no
 * matter what the package declared.
 *
 * MEASURED on a development boot of this branch before the fix: every one of the
 * 36 seeded templates — the blog idea generator and the blog draft writer among
 * them — read `trigger_mode` NULL, while their own OAS compiles a mode.
 *
 * These cases drive the REAL `installAgentFromPackage` with collaborators mocked
 * and assert the compiler's result lands through all THREE install branches
 * (fresh / upsert / 23505 race), exactly as the sibling
 * `install-from-package-has-artifact-bindings.test.ts` does for the
 * binding-presence authority.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PKG = "@cinatra-ai/trigger-mode-agent";

/** The OAS compiler's binding-presence result the fixture compile returns. */
let HAS_ARTIFACT_BINDINGS = false;
/** The OAS compiler's trigger classification the fixture compile returns. */
let TRIGGER_MODE: "full" | "start-only" = "full";
let GATED_STEPS: { stepId: string }[] = [];

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
    tempDir: "/tmp/extract-fixture-3033",
    manifest: {
      name: PKG,
      version: "1.0.0",
      cinatra: {
        packageType: "agent-package",
        manifestVersion: "1",
        type: "leaf",
      },
    },
    payload: {
      title: "Binding agent",
      description: "d",
      template: { name: "Binding agent", description: "d", sourceNl: "src" },
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
  // cinatra#2616: the install/import paths now treat a null result as a
  // REFUSAL, so the stub must return the row it "updated".
  updateAgentTemplate: async (...a: unknown[]) =>
    (await updateTemplate(...(a as []))) ?? { id: (a as [string])[0] },
  updateAgentTemplatePackageVersion: vi.fn(async () => {}),
  createAgentVersion: vi.fn(async () => {}),
}));
vi.mock("../agent-template-identity", async () => identityClaimMockFrom((n: string) => (readTemplate as (p?: string) => unknown)(n) as never));

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
      triggerMode: TRIGGER_MODE,
      gatedSteps: GATED_STEPS,
      hasArtifactBindings: HAS_ARTIFACT_BINDINGS,
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
  createLocal.mockReset();
  createLocal.mockImplementation(async () => ({ templateId: "tpl-fresh", versionId: "ver-fresh" }));
  readTemplate.mockReset();
  readTemplate.mockResolvedValue(null);
  HAS_ARTIFACT_BINDINGS = false;
  TRIGGER_MODE = "full";
  GATED_STEPS = [];
});

describe("cinatra#3033 — installAgentFromPackage persists the compiled trigger classification", () => {
  it("FRESH install: the compiled mode and its gated steps land on the seed", async () => {
    TRIGGER_MODE = "full";
    GATED_STEPS = [{ stepId: "draft" }];
    await install();
    expect(freshSeed().triggerMode).toBe("full");
    expect(freshSeed().gatedSteps).toEqual([{ stepId: "draft" }]);
  });

  it("FRESH install: a start-only agent lands 'start-only' with no gated steps — never NULL", async () => {
    TRIGGER_MODE = "start-only";
    GATED_STEPS = [];
    await install();
    // The defect this pins: the seed used to omit the field entirely, so the row
    // read NULL and the runtime gate had to guess a mode the package had already
    // declared.
    expect(freshSeed()).toHaveProperty("triggerMode", "start-only");
    expect(freshSeed()).toHaveProperty("gatedSteps", []);
  });

  it("UPSERT (re-install): the classification is re-projected onto the existing row", async () => {
    TRIGGER_MODE = "full";
    GATED_STEPS = [{ stepId: "publish" }];
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(upsertPatch().triggerMode).toBe("full");
    expect(upsertPatch().gatedSteps).toEqual([{ stepId: "publish" }]);
  });

  it("UPSERT: a version that switches runtime re-projects EXPLICITLY (no stale gate)", async () => {
    TRIGGER_MODE = "start-only";
    GATED_STEPS = [];
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    // Explicit, never omitted — omitting would leave the previous version's
    // gated steps standing on an agent that no longer has them.
    expect(upsertPatch()).toHaveProperty("triggerMode", "start-only");
    expect(upsertPatch()).toHaveProperty("gatedSteps", []);
  });

  it("RACE (23505 on the fresh INSERT): the upsert fallback writes the same classification", async () => {
    TRIGGER_MODE = "full";
    GATED_STEPS = [{ stepId: "draft" }];
    readTemplate.mockResolvedValueOnce(null).mockResolvedValue({ id: "tpl-raced", status: "active" });
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await install();
    expect(upsertPatch().triggerMode).toBe("full");
    expect(upsertPatch().gatedSteps).toEqual([{ stepId: "draft" }]);
  });
});

import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
/**
 * cinatra#2498 — the INSTALL-TIME write path for the locally-persisted
 * binding-presence authority (`agent_templates.has_artifact_bindings`).
 *
 * Acceptance item 1: "Install/compile persists whether the package declares
 * artifact bindings." These cases drive the REAL `installAgentFromPackage`
 * with collaborators mocked and assert the OAS compiler's
 * `hasArtifactBindings` result lands on the row through all THREE install
 * branches (fresh / upsert / 23505 race) — the run-completion registry
 * short-circuit (proven in run-artifact-materializer.test.ts) is only as
 * honest as this write path.
 *
 * Harness mirrors `install-from-package-lifecycle-config.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PKG = "@cinatra-ai/binding-agent";

/** The OAS compiler's binding-presence result the fixture compile returns. */
let HAS_ARTIFACT_BINDINGS = false;
/**
 * cinatra#3208 — the EXECUTED artifact-binding declaration the fixture compile
 * returns. `null` mirrors a compile that could not see its sibling manifest.
 */
let ARTIFACT_BINDINGS: {
  bindings: Array<{ nodeId: string; outputId: string; binding: Record<string, unknown> }>;
  producesRefs: Array<{ extension: string; objectTypeId?: string }>;
} | null = null;

const FAN_OUT_DECLARATION = {
  bindings: [
    {
      nodeId: "endNode",
      outputId: "ideas",
      binding: {
        extension: "@cinatra-ai/blog-idea-artifact",
        contentFrom: "ideas",
        declaredMime: "text/plain",
        fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
      },
    },
  ],
  producesRefs: [{ extension: "@cinatra-ai/blog-idea-artifact" }],
};

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
    tempDir: "/tmp/extract-fixture-2498",
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
      triggerMode: "full",
      gatedSteps: [],
      hasArtifactBindings: HAS_ARTIFACT_BINDINGS,
      artifactBindings: ARTIFACT_BINDINGS,
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
import { parseArtifactBindingDeclaration } from "../artifact-binding";

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
  ARTIFACT_BINDINGS = null;
});

describe("cinatra#2498 — installAgentFromPackage persists the compiler's binding-presence result", () => {
  it("FRESH install: a package with a declared binding lands true on the seed", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    await install();
    expect(freshSeed().hasArtifactBindings).toBe(true);
  });

  it("FRESH install: a package with no declared binding lands false (not null/omitted)", async () => {
    HAS_ARTIFACT_BINDINGS = false;
    await install();
    expect(freshSeed().hasArtifactBindings).toBe(false);
  });

  it("UPSERT (re-install): the flag is re-projected onto the existing row", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(upsertPatch().hasArtifactBindings).toBe(true);
  });

  it("UPSERT: a version that DROPS its last binding flips the column back to false (no stale true)", async () => {
    HAS_ARTIFACT_BINDINGS = false;
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    // Passed EXPLICITLY as false, not omitted — omitting would leave a stale
    // `true` on the row and let the run-completion materializer's registry
    // short-circuit believe a run still owes an artifact it no longer does.
    expect(upsertPatch()).toHaveProperty("hasArtifactBindings", false);
  });

  it("RACE (23505 on the fresh INSERT): the upsert fallback writes the same value", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    readTemplate.mockResolvedValueOnce(null).mockResolvedValue({ id: "tpl-raced", status: "active" });
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await install();
    expect(upsertPatch().hasArtifactBindings).toBe(true);
  });

  // codex round-2 finding: the run-completion materializer's version-pin
  // guard only trusts has_artifact_bindings when it's read alongside a
  // package_version that matches the reading run's own pin. That guard is
  // worthless if package_version and has_artifact_bindings land in TWO
  // separate writes — a run reading in the gap between them would see a
  // stale pairing. These pin that both fields ride the SAME updateAgentTemplate
  // patch object (one UPDATE statement, atomic) on both the upsert and the
  // race branch, and that installAgentFromPackage no longer needs a second,
  // separate updateAgentTemplatePackageVersion call to do it.
  it("UPSERT: hasArtifactBindings and packageVersion land in the SAME patch object (atomic — not two writes)", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    const patch = upsertPatch();
    expect(patch.hasArtifactBindings).toBe(true);
    expect(patch.packageVersion).toBe("1.0.0");
  });

  it("RACE: hasArtifactBindings and packageVersion land in the SAME patch object (atomic — not two writes)", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    readTemplate.mockResolvedValueOnce(null).mockResolvedValue({ id: "tpl-raced", status: "active" });
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await install();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    const patch = upsertPatch();
    expect(patch.hasArtifactBindings).toBe(true);
    expect(patch.packageVersion).toBe("1.0.0");
  });
});

/**
 * cinatra#3208 — the install-time write path for the EXECUTED artifact-binding
 * declaration (`agent_templates.artifact_bindings`). The presence flag above
 * only says a binding exists; the run-completion materializer needs the binding
 * ITSELF, or it goes back to asking the package registry and can resolve a
 * declaration the run never executed. Same three install branches, same
 * atomicity rule (the declaration is worthless to the version-pin guard if it
 * lands in a different write than package_version).
 */
describe("cinatra#3208 — installAgentFromPackage persists the executed artifact-binding declaration", () => {
  it("FRESH install: the compiler's collected declaration lands on the seed as JSON-as-text", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    ARTIFACT_BINDINGS = FAN_OUT_DECLARATION;
    await install();
    const serialized = freshSeed().artifactBindings as string;
    expect(typeof serialized).toBe("string");
    // Read back through the SAME grammar the materializer parses with, so this
    // pins the round trip rather than a string shape.
    expect(parseArtifactBindingDeclaration(serialized)).toEqual(FAN_OUT_DECLARATION);
  });

  it("FRESH install: a compile with no readable sibling manifest lands null (unknown, never an empty declaration)", async () => {
    HAS_ARTIFACT_BINDINGS = false;
    ARTIFACT_BINDINGS = null;
    await install();
    // null, NOT "{...bindings:[]}": an empty declaration would tell the
    // materializer the run owes nothing, which this compile cannot prove.
    expect(freshSeed().artifactBindings).toBeNull();
  });

  it("UPSERT (re-install): the declaration is re-projected onto the existing row", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    ARTIFACT_BINDINGS = FAN_OUT_DECLARATION;
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(parseArtifactBindingDeclaration(upsertPatch().artifactBindings as string)).toEqual(
      FAN_OUT_DECLARATION,
    );
  });

  it("UPSERT: a version that changes its binding overwrites the declaration (no stale shape)", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    ARTIFACT_BINDINGS = {
      bindings: [
        {
          nodeId: "endNode",
          outputId: "ideaBatchDocument",
          binding: {
            extension: "@cinatra-ai/blog-idea-artifact",
            contentFrom: "ideaBatchDocument",
            declaredMime: "text/markdown",
            titleFrom: "ideaBatchTitle",
          },
        },
      ],
      producesRefs: [{ extension: "@cinatra-ai/blog-idea-artifact" }],
    };
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    const parsed = parseArtifactBindingDeclaration(upsertPatch().artifactBindings as string);
    expect(parsed?.bindings[0]?.outputId).toBe("ideaBatchDocument");
  });

  it("RACE (23505 on the fresh INSERT): the upsert fallback writes the same declaration", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    ARTIFACT_BINDINGS = FAN_OUT_DECLARATION;
    readTemplate.mockResolvedValueOnce(null).mockResolvedValue({ id: "tpl-raced", status: "active" });
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await install();
    expect(parseArtifactBindingDeclaration(upsertPatch().artifactBindings as string)).toEqual(
      FAN_OUT_DECLARATION,
    );
  });

  it("UPSERT: artifactBindings and packageVersion land in the SAME patch object (atomic — not two writes)", async () => {
    HAS_ARTIFACT_BINDINGS = true;
    ARTIFACT_BINDINGS = FAN_OUT_DECLARATION;
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    const patch = upsertPatch();
    expect(patch.packageVersion).toBe("1.0.0");
    expect(patch.artifactBindings).toEqual(expect.any(String));
  });
});

import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
/**
 * cinatra#4150 — every template writer persists the compiler's
 * `publishingSteps` on `agent_templates.publishing_steps`.
 *
 * The behavioural half drives the REAL `installAgentFromPackage` (fresh /
 * upsert / 23505 race) and the REAL recompile writer `syncCompiledTemplateToDb`
 * with collaborators mocked. Harness mirrors
 * `install-from-package-has-artifact-bindings.test.ts`.
 *
 * The static half pins the writers: every product file that writes
 * `hasArtifactBindings:` is listed below with its count, and every listed
 * template WRITER writes `publishingSteps:` exactly as often. A new
 * `hasArtifactBindings:` site fails the pin until it is classified here, so a
 * writer cannot be added without the publishing-step column.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/install-from-package-publishing-steps.test.ts
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let extractDir = "";

beforeEach(async () => {
  extractDir = await mkdtemp(join(tmpdir(), "cinatra-install-oas-"));
  await mkdir(join(extractDir, "cinatra"));
  await writeFile(join(extractDir, "cinatra", "oas.json"), JSON.stringify({
    component_type: "Flow", id: "install-fixture", inputs: [],
    start_node: { $component_ref: "start" },
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", inputs: [] },
    },
  }));
});
afterEach(async () => {
  if (extractDir) await rm(extractDir, { recursive: true, force: true });
  extractDir = "";
});

const PKG = "@cinatra-ai/publish-fixture-agent";

/** The compiler's publishing-step result the fixture compile returns. */
let PUBLISHING_STEPS: string[] = [];

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
    tempDir: extractDir,
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
      title: "Publish fixture agent",
      description: "d",
      template: { name: "Publish fixture agent", description: "d", sourceNl: "src" },
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
  updateAgentTemplate: async (...a: unknown[]) =>
    (await updateTemplate(...(a as []))) ?? { id: (a as [string])[0] },
  updateAgentTemplatePackageVersion: vi.fn(async () => {}),
  createAgentVersion: vi.fn(async () => {}),
}));
vi.mock("../agent-template-identity", async () => identityClaimMockFrom((n: string) => (readTemplate as (p?: string) => unknown)(n) as never));

function compiledFixture() {
  return {
    approvalPolicy: { steps: [] },
    inputSchema: { type: "object", properties: {} },
    outputSchema: null,
    prompt: null,
    packageName: PKG,
    packageVersion: "1.0.0",
    agentDependencies: {},
    type: "leaf" as const,
    compiledPlan: [] as [],
    hitlScreens: [],
    llmConfig: null,
    toolboxes: [],
    agentSpecVersion: "26.1.0",
    triggerMode: "full" as const,
    gatedSteps: [],
    hasArtifactBindings: false,
    artifactBindings: null,
    publishingSteps: PUBLISHING_STEPS,
    cinatraConfig: null,
  };
}

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async () => ({ ok: true, value: compiledFixture() }),
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

import { installAgentFromPackage, syncCompiledTemplateToDb } from "../install-from-package";

const install = () => installAgentFromPackage({ packageName: PKG, orgId: "org-1" });

const freshSeed = () => (createLocal.mock.calls[0]?.[0] as { seed: Record<string, unknown> }).seed;
const upsertPatch = () => updateTemplate.mock.calls[0]?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  createLocal.mockReset();
  createLocal.mockImplementation(async () => ({ templateId: "tpl-fresh", versionId: "ver-fresh" }));
  readTemplate.mockReset();
  readTemplate.mockResolvedValue(null);
  PUBLISHING_STEPS = [];
});

describe("cinatra#4150 — installAgentFromPackage persists the compiler's publishingSteps", () => {
  it("FRESH install: the declared nodes land on the seed", async () => {
    PUBLISHING_STEPS = ["publish"];
    await install();
    expect(freshSeed().publishingSteps).toEqual(["publish"]);
  });

  it("FRESH install: a package that declares nothing lands an empty list (not null/omitted)", async () => {
    await install();
    expect(freshSeed()).toHaveProperty("publishingSteps", []);
  });

  it("UPSERT (re-install): the list is re-projected onto the existing row in the same patch as packageVersion", async () => {
    PUBLISHING_STEPS = ["publish"];
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    expect(upsertPatch().publishingSteps).toEqual(["publish"]);
    expect(upsertPatch().packageVersion).toBe("1.0.0");
  });

  it("UPSERT: a version that drops its last declaration clears the list (passed explicitly, never omitted)", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await install();
    expect(upsertPatch()).toHaveProperty("publishingSteps", []);
  });

  it("RACE (23505 on the fresh INSERT): the upsert fallback writes the same list", async () => {
    PUBLISHING_STEPS = ["publish"];
    readTemplate.mockResolvedValueOnce(null).mockResolvedValue({ id: "tpl-raced", status: "active" });
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await install();
    expect(upsertPatch().publishingSteps).toEqual(["publish"]);
  });
});

describe("cinatra#4150 — the recompile writer persists publishingSteps", () => {
  it("writes the list with a package version", async () => {
    PUBLISHING_STEPS = ["publish"];
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await syncCompiledTemplateToDb(PKG, "1.0.1", compiledFixture());
    expect(upsertPatch().publishingSteps).toEqual(["publish"]);
  });

  it("writes the list without a package version too: it follows the source the runtime loads", async () => {
    PUBLISHING_STEPS = ["publish"];
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
    await syncCompiledTemplateToDb(PKG, undefined, compiledFixture());
    expect(upsertPatch().publishingSteps).toEqual(["publish"]);
  });
});

// ---------------------------------------------------------------------------
// Static pin of the writers.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "__tests__", "__fixtures__", "dist", "build", ".next", ".turbo", "coverage"]);

function productSources(): string[] {
  const roots = [join(REPO_ROOT, "src")];
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"))) {
    const src = join(REPO_ROOT, "packages", pkg, "src");
    if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** Object-literal properties `key:` (a type annotation `key: boolean` / `key: string` is not one). Comment lines are skipped. */
function propertyCounts(key: string, files: string[]): Record<string, number> {
  const re = new RegExp(String.raw`\b${key}:(?!\s*(?:boolean|string)\b)`);
  const counts: Record<string, number> = {};
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (re.test(line)) {
        const rel = file.slice(REPO_ROOT.length);
        counts[rel] = (counts[rel] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** Template WRITERS: each `hasArtifactBindings:` here is a write of a template row or seed. */
const TEMPLATE_WRITERS: Record<string, number> = {
  "packages/agents/src/build-agent-template-seed.ts": 1,
  "packages/agents/src/import-agent-core.ts": 2,
  "packages/agents/src/import-export-actions.ts": 1,
  "packages/agents/src/install-from-package.ts": 3,
  "packages/agents/src/seed-bundled-agent-template.ts": 1,
  "packages/agents/src/store-template-versions.ts": 2,
};
/** READERS: `hasArtifactBindings:` sites that read a template and write no template column. */
const TEMPLATE_READERS: Record<string, number> = {
  "packages/agents/src/lifecycle-review-orchestration-store.ts": 4,
  "src/lib/artifacts/run-artifact-materializer.ts": 1,
};

describe("cinatra#4150 — the grep-pinned writer list", () => {
  const files = productSources();

  it("every hasArtifactBindings: site is classified (a new one must be added here as writer or reader)", () => {
    expect(propertyCounts("hasArtifactBindings", files)).toEqual({ ...TEMPLATE_WRITERS, ...TEMPLATE_READERS });
  });

  it("every template writer writes publishingSteps: as often as hasArtifactBindings:", () => {
    const written = propertyCounts("publishingSteps", files);
    for (const [file, count] of Object.entries(TEMPLATE_WRITERS)) {
      expect(written[file] ?? 0, file).toBe(count);
    }
  });

  it("the store's update patch re-projects publishingSteps beside hasArtifactBindings", () => {
    const store = readFileSync(join(REPO_ROOT, "packages/agents/src/store.ts"), "utf8");
    expect(store).toMatch(/updates\.hasArtifactBindings\s*=/);
    expect(store).toMatch(/updates\.publishingSteps\s*=/);
  });
});

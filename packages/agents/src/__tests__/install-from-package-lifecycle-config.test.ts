import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
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
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let extractDir = "";

// The real pre-install guard reads the extracted Flow after the compiler mock succeeds.
// This fixture has no visible inputs, matching the compiled input schema below.
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
    tempDir: extractDir,
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
  // cinatra#2616: the install/import paths now treat a null result as a
  // REFUSAL, so the stub must return the row it "updated".
  updateAgentTemplate: async (...a: unknown[]) =>
    (await updateTemplate(...(a as []))) ?? { id: (a as [string])[0] },
  updateAgentTemplatePackageVersion: vi.fn(async () => {}),
  createAgentVersion: (...a: unknown[]) => createVersion(...(a as [])),
}));
const createVersion = vi.fn(async (..._a: unknown[]) => {});
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

import { installAgentFromPackage, syncCompiledTemplateToDb } from "../install-from-package";

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
  createVersion.mockReset();
  createVersion.mockImplementation(async () => {});
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

  it("cinatra#4264 A1b review 1: UPSERT whose version creation fails writes the PRIOR column back (the files roll back too)", async () => {
    // The materialize is rolled back to the previous version's files, so the
    // lifecycle column this install wrote must follow it back: a regenerate
    // list written for the new flow must not stay beside the old flow.
    const prior = JSON.stringify({
      regenerate: [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }],
    });
    LIFECYCLE = { repairCapable: true };
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active", lifecycleConfig: prior } as never);
    createVersion.mockRejectedValue(new Error("version insert failed"));
    await expect(install()).rejects.toThrow(/version insert failed/);
    expect(updateTemplate).toHaveBeenCalledTimes(2);
    expect(upsertPatch().lifecycleConfig).toBe('{"repairCapable":true}');
    expect(updateTemplate.mock.calls[1]?.[0]).toBe("tpl-existing");
    expect(updateTemplate.mock.calls[1]?.[1]).toEqual({ lifecycleConfig: prior });
  });

  it("a MALFORMED block does not crash the install (fail-soft ⇒ no declaration)", async () => {
    LIFECYCLE = { repairCapable: "yes", producedTypes: "not-an-array" };
    await install();
    expect(freshSeed().lifecycleConfig).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#4264 A1b — the MCP recompile writes lifecycle_config per the
// tri-state projection of the compile's OWN sibling read: `write` (readable
// manifest with a block), `clear` (readable manifest without one), `none`
// (no readable manifest: the column is left as it is; the compile has already
// checked any retained regenerate list against the new flow).
// ---------------------------------------------------------------------------
describe("cinatra#4264 A1b — syncCompiledTemplateToDb projects the lifecycle declaration", () => {
  const image = { artifactNode: "file_image", step: "image_flow", noteInput: "prompt" };
  const draft = { artifactNode: "write_draft", step: "draft_flow", noteInput: "note" };
  const compiled = {
    approvalPolicy: { steps: [] },
    inputSchema: { type: "object", properties: {} },
    outputSchema: null,
    prompt: null,
    packageName: PKG,
    packageVersion: "1.0.1",
    agentDependencies: {},
    type: "leaf",
    compiledPlan: [],
    hitlScreens: [],
    llmConfig: null,
    toolboxes: [],
    agentSpecVersion: "26.1.0",
    triggerMode: "full",
    gatedSteps: [],
    hasArtifactBindings: false,
    artifactBindings: null,
    publishingSteps: [],
    cinatraConfig: null,
  } as unknown as Parameters<typeof syncCompiledTemplateToDb>[2];
  type Reading = { readable: false } | { readable: true; lifecycle: unknown };
  const sync = (reading?: Reading) =>
    (syncCompiledTemplateToDb as unknown as (...a: unknown[]) => Promise<void>)(
      PKG,
      "1.0.1",
      compiled,
      ...(reading === undefined ? [] : [reading]),
    );

  beforeEach(() => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", status: "active" });
  });

  it("write: a readable manifest that ADDS a list stores it", async () => {
    await sync({ readable: true, lifecycle: { repairCapable: true, regenerate: [image] } });
    expect(upsertPatch().lifecycleConfig).toBe(
      '{"repairCapable":true,"regenerate":[{"artifactNode":"file_image","step":"image_flow","noteInput":"prompt"}]}',
    );
  });

  it("write: a CHANGED list replaces the stored one (sorted by artifactNode)", async () => {
    await sync({ readable: true, lifecycle: { regenerate: [draft, image] } });
    expect(upsertPatch().lifecycleConfig).toBe(
      '{"regenerate":[{"artifactNode":"file_image","step":"image_flow","noteInput":"prompt"},' +
        '{"artifactNode":"write_draft","step":"draft_flow","noteInput":"note"}]}',
    );
  });

  it("write: a block that REMOVES the list stores the rest without it", async () => {
    await sync({ readable: true, lifecycle: { repairCapable: true } });
    expect(upsertPatch().lifecycleConfig).toBe('{"repairCapable":true}');
  });

  it("clear: a readable manifest without a block clears the column (explicit null)", async () => {
    await sync({ readable: true, lifecycle: undefined });
    expect(upsertPatch()).toHaveProperty("lifecycleConfig", null);
  });

  it("none: no readable manifest leaves the column unchanged (the key is omitted)", async () => {
    await sync({ readable: false });
    expect(Object.prototype.hasOwnProperty.call(upsertPatch(), "lifecycleConfig")).toBe(false);
  });

  it("a caller that passes no reading writes no lifecycle column (unchanged behaviour)", async () => {
    await sync();
    expect(Object.prototype.hasOwnProperty.call(upsertPatch(), "lifecycleConfig")).toBe(false);
  });

  // Review 1 finding 4: the lifecycle column carries the regenerate guarantee,
  // so a caller that asks for it (passes a reading) gets a DB failure as a
  // rejection; the recompile then refuses instead of reporting success over a
  // stale row. Without a reading the sync stays best-effort.
  it("a DB failure REJECTS when a reading was passed (the lifecycle write is not best-effort)", async () => {
    updateTemplate.mockRejectedValueOnce(new Error("update failed"));
    await expect(sync({ readable: true, lifecycle: undefined })).rejects.toThrow(/update failed/);
  });

  it("a failed row read REJECTS when a reading was passed", async () => {
    readTemplate.mockRejectedValueOnce(new Error("read failed"));
    await expect(sync({ readable: false })).rejects.toThrow(/read failed/);
  });

  it("control: without a reading a DB failure is still warned and swallowed", async () => {
    updateTemplate.mockRejectedValueOnce(new Error("update failed"));
    await expect(sync()).resolves.toBeUndefined();
  });
});

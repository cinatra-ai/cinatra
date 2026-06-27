// #180 PR-1: the AGENT install path is a materializing finalizer — its edge
// persistence must (1) resolve the canonical write targets in the INERT
// pre-write window (fail-loud while nothing has mutated), and (2) write the
// manifest's edges at the finalize seam on EVERY success branch (upsert,
// fresh INSERT, 23505-race upsert). These tests drive the REAL
// installAgentFromPackage with its collaborators mocked, pinning the ordering
// the static seams promise.
import { describe, expect, it, vi, beforeEach } from "vitest";

const order: string[] = [];

const EDGES = [
  {
    packageName: "@cinatra-ai/dep-a",
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
  },
];
const TARGETS = [{ id: "row-1", packageName: "@cinatra-ai/pkg" }];

const resolveTargets = vi.fn(async () => {
  order.push("resolveTargets");
  return TARGETS;
});
const writeEdges = vi.fn(async () => {
  order.push("writeEdges");
  return { patchedRowIds: ["row-1"] };
});

vi.mock("@cinatra-ai/extensions/manifest-dependencies", () => ({
  parseManifestDependencyEdges: vi.fn(() => {
    order.push("parseEdges");
    return { edges: EDGES, source: "canonical" };
  }),
  resolveLiveCanonicalEdgeTargets: (...a: unknown[]) => resolveTargets(...(a as [])),
  writeDependencyEdgesToCanonicalRows: (...a: unknown[]) => writeEdges(...(a as [])),
}));

vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  checkRequiredExtensionVersionPin: () => ({ ok: true }),
}));

// The #180 UPDATE GATE (PR-3) reads the canonical snapshot in the same inert
// window — mock it empty so the gate is a clean no-op here (its semantics are
// pinned in packages/extensions dependency-closure + dispatcher tests).
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); },
  ensureConfig: (c: unknown) => c ?? { registryUrl: "https://registry.cinatra.ai", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
  extractAgentPackage: async () => ({
    packageName: "@cinatra-ai/pkg",
    packageVersion: "1.0.0",
    tempDir: "/tmp/extract-fixture",
    manifest: {
      name: "@cinatra-ai/pkg",
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
  agentPackagePayloadSchema: { parse: (x: unknown) => x },
  CINATRA_AGENT_PACKAGE_TYPE: "agent-package",
  CINATRA_AGENT_MANIFEST_VERSION: "1",
}));

vi.mock("../verdaccio/cli-flags", () => ({ buildRegistryAuthArgs: () => [] }));

const createLocal = vi.fn(async () => {
  order.push("write:createLocalTemplateVersion");
  return { templateId: "tpl-fresh", versionId: "ver-fresh" };
});
vi.mock("../import-export-actions", () => ({
  createLocalAgentTemplateVersion: (...a: unknown[]) => createLocal(...(a as [])),
}));

const readTemplate = vi.fn(async (): Promise<{ id: string; status: string } | null> => null);
const updateTemplate = vi.fn(async () => {
  order.push("write:updateAgentTemplate");
});
const updatePkgVersion = vi.fn(async () => {
  order.push("write:updateAgentTemplatePackageVersion");
});
const createVersion = vi.fn(async () => {
  order.push("write:createAgentVersion");
});
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (...a: unknown[]) => readTemplate(...(a as [])),
  updateAgentTemplate: (...a: unknown[]) => updateTemplate(...(a as [])),
  updateAgentTemplatePackageVersion: (...a: unknown[]) => updatePkgVersion(...(a as [])),
  createAgentVersion: (...a: unknown[]) => createVersion(...(a as [])),
}));

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async () => ({ ok: false, error: "fixture: no oas.json" }),
}));
vi.mock("@cinatra-ai/objects/auto-registrar", () => ({ ensureDynamicObjectType: async () => ({}) }));
vi.mock("@cinatra-ai/objects/registry", () => ({ objectTypeRegistry: { has: () => false } }));
vi.mock("../agent-install-path", () => ({ resolveAgentInstallDir: () => "/tmp/agents-fixture" }));

const materialize = vi.fn(async () => {
  order.push("materialize");
  return { materialized: true, targetDir: "/tmp/agents-fixture/pkg", wasReinstall: false };
});
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: (...a: unknown[]) => materialize(...(a as [])),
  commitMaterialize: async () => {
    order.push("commitMaterialize");
  },
  rollbackMaterialize: async () => {
    order.push("rollbackMaterialize");
  },
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
  withGlobalExtensionLifecycleLock: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../wayflow-reload-client", () => ({ triggerWayflowReload: async () => ({ ok: true }) }));

import { installAgentFromPackage } from "../install-from-package";

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  resolveTargets.mockImplementation(async () => {
    order.push("resolveTargets");
    return TARGETS;
  });
  readTemplate.mockResolvedValue(null);
});

describe("installAgentFromPackage — #180 edge persistence on the agent finalizer path", () => {
  it("UPSERT branch: targets resolve in the INERT window (before materialize + any template write); edges write at the finalize seam with the parsed edges", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-1", status: "active" });
    await installAgentFromPackage({ packageName: "@cinatra-ai/pkg" });
    // Inert-window ordering: resolve BEFORE materialize and BEFORE the first DB write.
    expect(order.indexOf("resolveTargets")).toBeGreaterThan(-1);
    expect(order.indexOf("resolveTargets")).toBeLessThan(order.indexOf("materialize"));
    expect(order.indexOf("resolveTargets")).toBeLessThan(order.indexOf("write:updateAgentTemplate"));
    // Finalize seam: edges write AFTER the version row landed.
    expect(order.indexOf("writeEdges")).toBeGreaterThan(order.indexOf("write:createAgentVersion"));
    expect(writeEdges).toHaveBeenCalledTimes(1);
    expect(writeEdges).toHaveBeenCalledWith(TARGETS, EDGES);
  });

  it("FRESH branch: same contract — resolve inert, edges written once after the fresh INSERT", async () => {
    await installAgentFromPackage({ packageName: "@cinatra-ai/pkg" });
    expect(order.indexOf("resolveTargets")).toBeLessThan(order.indexOf("materialize"));
    expect(order.indexOf("writeEdges")).toBeGreaterThan(order.indexOf("write:createLocalTemplateVersion"));
    expect(writeEdges).toHaveBeenCalledTimes(1);
    expect(writeEdges).toHaveBeenCalledWith(TARGETS, EDGES);
  });

  it("23505-RACE branch: the race-upsert path still reaches the single finalize-seam write", async () => {
    createLocal.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    // After losing the race, the impl re-reads the now-existing row.
    readTemplate.mockResolvedValueOnce(null); // pin-gate op label read
    readTemplate.mockResolvedValueOnce(null); // pre-branch read → fresh branch
    readTemplate.mockResolvedValueOnce({ id: "tpl-race", status: "active" }); // race re-read
    const res = await installAgentFromPackage({ packageName: "@cinatra-ai/pkg" });
    expect(res.templateId).toBe("tpl-race");
    expect(order.indexOf("writeEdges")).toBeGreaterThan(order.indexOf("write:createAgentVersion"));
    expect(writeEdges).toHaveBeenCalledTimes(1);
    expect(writeEdges).toHaveBeenCalledWith(TARGETS, EDGES);
  });

  it("a FAIL-LOUD target resolve refuses while NOTHING has mutated (no materialize, no template/version write, no edge write)", async () => {
    resolveTargets.mockImplementation(async () => {
      order.push("resolveTargets");
      throw new Error("canonical store unreachable");
    });
    await expect(installAgentFromPackage({ packageName: "@cinatra-ai/pkg" })).rejects.toThrow(
      "canonical store unreachable",
    );
    expect(order).not.toContain("materialize");
    expect(order.filter((e) => e.startsWith("write:"))).toEqual([]);
    expect(writeEdges).not.toHaveBeenCalled();
  });
});

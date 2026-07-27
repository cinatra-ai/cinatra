// The run seam's declared-environment SOURCE reader (epic #1705; exec-plane S3
// A2/A3).
//
// The defect these cases pin: `/api/llm-bridge` supplied only the live template
// row to `resolveRunExecutionBinding`, so a PACKAGED agent's manifest
// declaration and a PINNED run's snapshot recipe both resolved ABSENT — the run
// silently executed on L0 (fail-open against "a declared environment resolves or
// the run refuses") and version pinning was bypassed on this seam.
//
// The pin arms below also pin the CLASSIFIER contract (cinatra#1040 S5/S7): a
// `versionId`-only row is the INERT pin every non-A2A run producer writes and is
// NOT a pin; a REQUIRED pin needs BOTH `versionId` and `packageVersion`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAgentTemplateVersionById = vi.fn();
const readAgentTemplateVersionBySemver = vi.fn();
const discoverStoreRecordsV2 = vi.fn();
const readInstalledExtensionsByPackageName = vi.fn();
const staticManifest: Record<string, { executionEnvironment?: unknown }> = {};

vi.mock("@cinatra-ai/agents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentTemplateVersionById: (...args: unknown[]) =>
    readAgentTemplateVersionById(...args),
  readAgentTemplateVersionBySemver: (...args: unknown[]) =>
    readAgentTemplateVersionBySemver(...args),
}));
vi.mock("@/lib/generated/extensions.server", () => ({
  get STATIC_EXTENSION_MANIFEST() {
    return staticManifest;
  },
}));
vi.mock("@/lib/extension-data-root", () => ({
  resolveExtensionDataRoot: () => "/nonexistent-store-root",
}));
vi.mock("@/lib/extension-store-io", () => ({
  realStoreFs: {},
  discoverStoreRecordsV2: (...args: unknown[]) => discoverStoreRecordsV2(...args),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...args: unknown[]) =>
    readInstalledExtensionsByPackageName(...args),
}));

import { resolveRunEnvironmentSources } from "@/lib/execution/resolve-run-environment-sources";

const TEMPLATE_ID = "tpl-1";

/** The overwhelmingly common run shape: no A2A version pin at all. */
function run(over: Partial<Parameters<typeof resolveRunEnvironmentSources>[0]> = {}) {
  return {
    templateId: TEMPLATE_ID,
    versionId: null,
    packageVersion: null,
    packageName: null,
    liveTemplateEnvironment: undefined,
    ...over,
  };
}

beforeEach(() => {
  for (const key of Object.keys(staticManifest)) delete staticManifest[key];
  readAgentTemplateVersionById.mockReset();
  readAgentTemplateVersionBySemver.mockReset();
  discoverStoreRecordsV2.mockReset();
  discoverStoreRecordsV2.mockResolvedValue([]);
  readInstalledExtensionsByPackageName.mockReset();
  // Default: the package IS installed here (the case the fail-closed arm covers).
  readInstalledExtensionsByPackageName.mockResolvedValue([{ id: "inst-1" }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRunEnvironmentSources — packaged-manifest source", () => {
  it("reads the BUNDLED manifest's declaration (the fail-open this fix closes)", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: { pip: ["pandas==2.2.1"] } };
    const sources = await resolveRunEnvironmentSources(run({ packageName: "@acme/agent" }));
    expect(sources.packagedManifestEnvironment).toEqual({ pip: ["pandas==2.2.1"] });
    expect(sources.declarationUnreadable).toBeNull();
    // The bundled hit must never pay for a store scan on the hot bridge path.
    expect(discoverStoreRecordsV2).not.toHaveBeenCalled();
  });

  it("a bundled package that declares nothing yields no declaration (L0 path intact)", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: null };
    const sources = await resolveRunEnvironmentSources(run({ packageName: "@acme/agent" }));
    expect(sources.packagedManifestEnvironment).toBeNull();
    expect(sources.declarationUnreadable).toBeNull();
  });

  it("a template with NO packageName never touches the manifest sources", async () => {
    const sources = await resolveRunEnvironmentSources(
      run({ liveTemplateEnvironment: { pip: ["pandas"] } }),
    );
    expect(sources).toEqual({
      packagedManifestEnvironment: null,
      pinnedSnapshot: null,
      declarationUnreadable: null,
    });
    expect(discoverStoreRecordsV2).not.toHaveBeenCalled();
  });

  it("falls through to the materialized store for a non-bundled (marketplace) package", async () => {
    discoverStoreRecordsV2.mockResolvedValue([
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["cowsay"] } },
      { packageName: "@other/thing", executionEnvironment: { pip: ["numpy"] } },
    ]);
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.packagedManifestEnvironment).toEqual({ npm: ["cowsay"] });
  });

  it("a store read that THROWS is UNREADABLE, not 'declares nothing' → refuses", async () => {
    discoverStoreRecordsV2.mockRejectedValue(new Error("EIO"));
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
    expect(sources.packagedManifestEnvironment).toBeNull();
  });

  it("an INSTALLED packaged agent with no readable manifest refuses (discovery SKIPS corrupt manifests)", async () => {
    discoverStoreRecordsV2.mockResolvedValue([{ packageName: "@other/thing" }]);
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("a packageName that names NO installed extension is not a refusal (no data volume, etc.)", async () => {
    // `discoverStoreRecordsV2` legitimately yields nothing on a deployment with
    // no data volume; refusing every run of every non-bundled template there is
    // a blast radius the run seam must not take.
    discoverStoreRecordsV2.mockResolvedValue([]);
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/not-installed" }),
    );
    expect(sources.declarationUnreadable).toBeNull();
    expect(sources.packagedManifestEnvironment).toBeNull();
  });

  it("an UNREADABLE install registry is itself an unknown state → refuses", async () => {
    discoverStoreRecordsV2.mockResolvedValue([]);
    readInstalledExtensionsByPackageName.mockRejectedValue(new Error("db down"));
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("DISAGREEING materialized digests are UNREADABLE (never an arbitrary pick)", async () => {
    discoverStoreRecordsV2.mockResolvedValue([
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["cowsay"] } },
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["figlet"] } },
    ]);
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("AGREEING digests (byte-different but equivalent) resolve the declaration", async () => {
    discoverStoreRecordsV2.mockResolvedValue([
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["b", "a"] } },
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["a", "b", "b"] } },
    ]);
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.declarationUnreadable).toBeNull();
    expect(sources.packagedManifestEnvironment).toEqual({ npm: ["b", "a"] });
  });

  it("ABSENT and EMPTY declarations AGREE — both mean 'declares nothing', not a conflict", async () => {
    discoverStoreRecordsV2.mockResolvedValue([
      { packageName: "@acme/marketplace-agent", executionEnvironment: null },
      { packageName: "@acme/marketplace-agent", executionEnvironment: {} },
      { packageName: "@acme/marketplace-agent", executionEnvironment: { pip: [] } },
    ]);
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent" }),
    );
    expect(sources.declarationUnreadable).toBeNull();
  });
});

describe("resolveRunEnvironmentSources — pinned version snapshot", () => {
  it("a run with NO version pin reads no snapshot at all (zero DB work on the hot path)", async () => {
    const sources = await resolveRunEnvironmentSources(
      run({ liveTemplateEnvironment: { pip: ["pandas"] } }),
    );
    expect(sources.pinnedSnapshot).toBeNull();
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
    expect(readAgentTemplateVersionBySemver).not.toHaveBeenCalled();
  });

  it("a versionId-ONLY row is the INERT pin — NOT a pin, and no snapshot read", async () => {
    // Every non-A2A producer (createAgentRunPendingInput, runFromRegistry, the
    // workflow/project dispatch paths) writes versionId only, and it points at
    // the legacy `agent_versions` table. Treating it as a pin would make every
    // ordinary run resolve against a row that does not exist.
    const sources = await resolveRunEnvironmentSources(
      run({ versionId: "v-inert", liveTemplateEnvironment: { pip: ["pandas"] } }),
    );
    expect(sources.pinnedSnapshot).toBeNull();
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
  });

  it("a REQUIRED pin (versionId + packageVersion) supplies the snapshot's recipe", async () => {
    readAgentTemplateVersionById.mockResolvedValue({
      templateId: TEMPLATE_ID,
      semver: "1.2.3",
      snapshot: {
        compiledPlan: [],
        taskSpec: null,
        executionEnvironment: { pip: ["pandas==2.0.0"] },
      },
    });
    const sources = await resolveRunEnvironmentSources(
      run({
        versionId: "v1",
        packageVersion: "1.2.3",
        liveTemplateEnvironment: { pip: ["numpy"] },
      }),
    );
    expect(sources.pinnedSnapshot).toEqual({
      executionEnvironment: { pip: ["pandas==2.0.0"] },
    });
  });

  it("a REQUIRED pin whose snapshot is PURGED refuses (never the live recipe)", async () => {
    readAgentTemplateVersionById.mockResolvedValue(null);
    const sources = await resolveRunEnvironmentSources(
      run({
        versionId: "v-purged",
        packageVersion: "1.2.3",
        liveTemplateEnvironment: { pip: ["numpy"] },
      }),
    );
    expect(sources.pinnedSnapshot).toBeNull();
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("a REQUIRED pin bound to a DIFFERENT template refuses (no cross-template swap)", async () => {
    readAgentTemplateVersionById.mockResolvedValue({
      templateId: "some-other-template",
      semver: "1.2.3",
      snapshot: { compiledPlan: [], taskSpec: null },
    });
    const sources = await resolveRunEnvironmentSources(
      run({
        versionId: "v1",
        packageVersion: "1.2.3",
        liveTemplateEnvironment: { pip: ["numpy"] },
      }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("a REQUIRED pin whose snapshot declares NOTHING stays L0 — no live fallback", async () => {
    readAgentTemplateVersionById.mockResolvedValue({
      templateId: TEMPLATE_ID,
      semver: "1.2.3",
      snapshot: { compiledPlan: [], taskSpec: null },
    });
    const sources = await resolveRunEnvironmentSources(
      run({
        versionId: "v1",
        packageVersion: "1.2.3",
        liveTemplateEnvironment: { pip: ["numpy"] },
      }),
    );
    expect(sources.pinnedSnapshot).toEqual({ executionEnvironment: null });
    expect(sources.declarationUnreadable).toBeNull();
  });

  it("a BEST-EFFORT semver pin resolves the snapshot; a MISS falls back to live", async () => {
    readAgentTemplateVersionBySemver.mockResolvedValue({
      templateId: TEMPLATE_ID,
      semver: "1.2.3",
      snapshot: { compiledPlan: [], executionEnvironment: { npm: ["cowsay"] } },
    });
    const hit = await resolveRunEnvironmentSources(run({ packageVersion: "1.2.3" }));
    expect(hit.pinnedSnapshot).toEqual({ executionEnvironment: { npm: ["cowsay"] } });

    readAgentTemplateVersionBySemver.mockResolvedValue(null);
    const miss = await resolveRunEnvironmentSources(
      run({ packageVersion: "9.9.9", liveTemplateEnvironment: { pip: ["numpy"] } }),
    );
    expect(miss.pinnedSnapshot).toBeNull();
    expect(miss.declarationUnreadable).toBeNull();
  });

  it("a snapshot read that THROWS refuses (UNKNOWN pin recipe, never the live one)", async () => {
    readAgentTemplateVersionBySemver.mockRejectedValue(new Error("db down"));
    const sources = await resolveRunEnvironmentSources(
      run({ packageVersion: "1.2.3", liveTemplateEnvironment: { pip: ["numpy"] } }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("a NON-EMPTY packaged manifest short-circuits the pin read entirely", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: { npm: ["cowsay"] } };
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/agent", versionId: "v1", packageVersion: "1.2.3" }),
    );
    expect(sources.packagedManifestEnvironment).toEqual({ npm: ["cowsay"] });
    expect(sources.pinnedSnapshot).toBeNull();
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
  });

  it("an EMPTY packaged manifest does NOT short-circuit — the pin still governs", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: {} };
    readAgentTemplateVersionById.mockResolvedValue({
      templateId: TEMPLATE_ID,
      semver: "1.2.3",
      snapshot: { compiledPlan: [], executionEnvironment: { pip: ["pandas"] } },
    });
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/agent", versionId: "v1", packageVersion: "1.2.3" }),
    );
    expect(sources.pinnedSnapshot).toEqual({ executionEnvironment: { pip: ["pandas"] } });
  });

  it("an INVALID packaged manifest short-circuits too — it IS a declaration (refused downstream)", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: { bogus: ["x"] } };
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/agent", versionId: "v1", packageVersion: "1.2.3" }),
    );
    expect(sources.packagedManifestEnvironment).toEqual({ bogus: ["x"] });
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
  });

  it("an unreadable MANIFEST short-circuits before any snapshot read", async () => {
    discoverStoreRecordsV2.mockRejectedValue(new Error("EIO"));
    const sources = await resolveRunEnvironmentSources(
      run({ packageName: "@acme/marketplace-agent", versionId: "v1", packageVersion: "1.2.3" }),
    );
    expect(sources.declarationUnreadable).not.toBeNull();
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
  });
});

// The run seam's declared-environment SOURCE reader (epic #1705; exec-plane S3
// A2/A3).
//
// The defect these cases pin: `/api/llm-bridge` supplied only the live template
// row to `resolveRunExecutionBinding`, so a PACKAGED agent's manifest
// declaration and a PINNED run's snapshot recipe both resolved ABSENT — the run
// silently executed on L0 (fail-open against "a declared environment resolves or
// the run refuses") and version pinning was bypassed on this seam.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAgentTemplateVersionById = vi.fn();
const discoverStoreRecordsV2 = vi.fn();
const staticManifest: Record<string, { executionEnvironment?: unknown }> = {};

vi.mock("@cinatra-ai/agents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentTemplateVersionById: (...args: unknown[]) =>
    readAgentTemplateVersionById(...args),
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

import { resolveRunEnvironmentSources } from "@/lib/execution/resolve-run-environment-sources";

beforeEach(() => {
  for (const key of Object.keys(staticManifest)) delete staticManifest[key];
  readAgentTemplateVersionById.mockReset();
  discoverStoreRecordsV2.mockReset();
  discoverStoreRecordsV2.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRunEnvironmentSources — packaged-manifest source", () => {
  it("reads the BUNDLED manifest's declaration (the fail-open this fix closes)", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: { pip: ["pandas==2.2.1"] } };
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.packagedManifestEnvironment).toEqual({ pip: ["pandas==2.2.1"] });
    expect(sources.declarationUnreadable).toBeNull();
    // The bundled hit must never pay for a store scan on the hot bridge path.
    expect(discoverStoreRecordsV2).not.toHaveBeenCalled();
  });

  it("a bundled package that declares nothing yields no declaration (L0 path intact)", async () => {
    staticManifest["@acme/agent"] = { executionEnvironment: null };
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.packagedManifestEnvironment).toBeNull();
    expect(sources.declarationUnreadable).toBeNull();
  });

  it("a template with NO packageName never touches the manifest sources", async () => {
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: null,
      liveTemplateEnvironment: { pip: ["pandas"] },
    });
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
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/marketplace-agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.packagedManifestEnvironment).toEqual({ npm: ["cowsay"] });
  });

  it("a store read that THROWS is UNREADABLE, not 'declares nothing' → refuses", async () => {
    discoverStoreRecordsV2.mockRejectedValue(new Error("EIO"));
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/marketplace-agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.declarationUnreadable).not.toBeNull();
    expect(sources.packagedManifestEnvironment).toBeNull();
  });

  it("DISAGREEING materialized digests are UNREADABLE (never an arbitrary pick)", async () => {
    discoverStoreRecordsV2.mockResolvedValue([
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["cowsay"] } },
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["figlet"] } },
    ]);
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/marketplace-agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("AGREEING digests (byte-different but equivalent) resolve the declaration", async () => {
    discoverStoreRecordsV2.mockResolvedValue([
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["b", "a"] } },
      { packageName: "@acme/marketplace-agent", executionEnvironment: { npm: ["a", "b", "b"] } },
    ]);
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/marketplace-agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.declarationUnreadable).toBeNull();
    expect(sources.packagedManifestEnvironment).toEqual({ npm: ["b", "a"] });
  });

  it("a package with no materialized record is NOT a refusal (deliberate blast-radius limit)", async () => {
    discoverStoreRecordsV2.mockResolvedValue([{ packageName: "@other/thing" }]);
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: "@acme/marketplace-agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.declarationUnreadable).toBeNull();
    expect(sources.packagedManifestEnvironment).toBeNull();
  });
});

describe("resolveRunEnvironmentSources — pinned version snapshot", () => {
  it("an UNPINNED run reads no snapshot", async () => {
    const sources = await resolveRunEnvironmentSources({
      versionId: null,
      packageName: null,
      liveTemplateEnvironment: { pip: ["pandas"] },
    });
    expect(sources.pinnedSnapshot).toBeNull();
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
  });

  it("a PINNED run supplies the snapshot so the resolver's pin-exclusive rule engages", async () => {
    readAgentTemplateVersionById.mockResolvedValue({
      id: "v1",
      snapshot: { executionEnvironment: { pip: ["pandas==2.0.0"] } },
    });
    const sources = await resolveRunEnvironmentSources({
      versionId: "v1",
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(sources.pinnedSnapshot).toEqual({
      executionEnvironment: { pip: ["pandas==2.0.0"] },
    });
  });

  it("a pin whose snapshot is GONE, with a live declaration, refuses (no pin bypass)", async () => {
    readAgentTemplateVersionById.mockResolvedValue(null);
    const sources = await resolveRunEnvironmentSources({
      versionId: "v-purged",
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(sources.pinnedSnapshot).toBeNull();
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("a pin whose snapshot is GONE with NOTHING declared stays L0 (byte-identical)", async () => {
    readAgentTemplateVersionById.mockResolvedValue(null);
    const sources = await resolveRunEnvironmentSources({
      versionId: "v-purged",
      packageName: null,
      liveTemplateEnvironment: undefined,
    });
    expect(sources).toEqual({
      packagedManifestEnvironment: null,
      pinnedSnapshot: null,
      declarationUnreadable: null,
    });
  });

  it("a pin whose snapshot is GONE while the MANIFEST declares resolves on the manifest", async () => {
    // The manifest is authoritative over the pin (it is versioned by the
    // INSTALLED PACKAGE, which the agent-template pin does not name), so an
    // unreadable pin changes nothing.
    staticManifest["@acme/agent"] = { executionEnvironment: { npm: ["cowsay"] } };
    readAgentTemplateVersionById.mockResolvedValue(null);
    const sources = await resolveRunEnvironmentSources({
      versionId: "v-purged",
      packageName: "@acme/agent",
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(sources.declarationUnreadable).toBeNull();
    expect(sources.packagedManifestEnvironment).toEqual({ npm: ["cowsay"] });
  });

  it("a snapshot read that THROWS with a live declaration refuses", async () => {
    readAgentTemplateVersionById.mockRejectedValue(new Error("db down"));
    const sources = await resolveRunEnvironmentSources({
      versionId: "v1",
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(sources.declarationUnreadable).not.toBeNull();
  });

  it("an unreadable MANIFEST short-circuits before any snapshot read", async () => {
    discoverStoreRecordsV2.mockRejectedValue(new Error("EIO"));
    const sources = await resolveRunEnvironmentSources({
      versionId: "v1",
      packageName: "@acme/marketplace-agent",
      liveTemplateEnvironment: undefined,
    });
    expect(sources.declarationUnreadable).not.toBeNull();
    expect(readAgentTemplateVersionById).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic producer-assertion resolution. Security-critical: a
// missing or CROSS-ORG createdByRunId
// must yield `validatedRunId: null` (so the creation path never
// persists a cross-tenant provenance pointer) AND empty produces.

const { runPostgresQueriesSyncMock, getAgentPackageMock, readProducesMock, writeAllowedMock } =
  vi.hoisted(() => ({
    runPostgresQueriesSyncMock: vi.fn(),
    getAgentPackageMock: vi.fn(),
    readProducesMock: vi.fn(),
    writeAllowedMock: vi.fn<(ext: string) => Promise<boolean>>(async () => true),
  }));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPostgresQueriesSyncMock,
}));

vi.mock("@/lib/database", () => ({
  getPostgresConnectionString: () => "postgres://test",
  ensurePostgresSchema: () => {},
  postgresSchema: "cinatra",
}));

vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: getAgentPackageMock,
}));

vi.mock("@cinatra-ai/extensions/agent-produces-reader", () => ({
  readAgentProducesFromPackageManifest: readProducesMock,
}));

// CG-4 (cinatra#661): produces entries are filtered through the install-active
// write gate. Mock it; default allow, override per test.
vi.mock("../artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: writeAllowedMock,
}));

import { resolveProducerAssertionPlan } from "../producer-assertions";

// Helper: stage the two scoped SELECTs (agent_runs row, then
// agent_templates row). Each runPostgresQueriesSync call returns one
// result per query — these helpers shape the single-query results.
function stageRunRow(
  row:
    | { org_id: string; package_version: string | null; template_id: string }
    | undefined,
) {
  runPostgresQueriesSyncMock.mockReturnValueOnce([
    { rows: row ? [row] : [], rowCount: row ? 1 : 0 },
  ]);
}
function stageTemplateRow(row: { package_name?: string | null } | undefined) {
  runPostgresQueriesSyncMock.mockReturnValueOnce([
    { rows: row ? [row] : [], rowCount: row ? 1 : 0 },
  ]);
}

describe("resolveProducerAssertionPlan", () => {
  beforeEach(() => {
    runPostgresQueriesSyncMock.mockReset();
    getAgentPackageMock.mockReset();
    readProducesMock.mockReset();
    writeAllowedMock.mockReset().mockResolvedValue(true);
  });

  it("no createdByRunId → no DB calls, empty plan", async () => {
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: null,
      orgId: "org-a",
    });
    expect(plan).toEqual({ validatedRunId: null, produces: [] });
    expect(runPostgresQueriesSyncMock).not.toHaveBeenCalled();
  });

  it("run not found → validatedRunId null, empty produces", async () => {
    stageRunRow(undefined);
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    expect(plan).toEqual({ validatedRunId: null, produces: [] });
  });

  it("CROSS-ORG run → validatedRunId null (provenance dropped), empty produces", async () => {
    stageRunRow({
      org_id: "org-OTHER",
      package_version: "1.0.0",
      template_id: "tpl-1",
    });
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    // The cross-tenant run id must NEVER be persisted.
    expect(plan).toEqual({ validatedRunId: null, produces: [] });
    // No template lookup / manifest read happens after the org gate.
    expect(getAgentPackageMock).not.toHaveBeenCalled();
  });

  it("same-org run but template has no package_name → validatedRunId kept, empty produces", async () => {
    stageRunRow({
      org_id: "org-a",
      package_version: "1.0.0",
      template_id: "tpl-1",
    });
    stageTemplateRow({ package_name: null });
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    // Provenance still recorded (same-org), but no assertions.
    expect(plan).toEqual({ validatedRunId: "run-x", produces: [] });
    expect(getAgentPackageMock).not.toHaveBeenCalled();
  });

  it("same-org run → resolves package, extracts produces, de-dupes + drops default-floor", async () => {
    stageRunRow({
      org_id: "org-a",
      package_version: "2.3.1",
      template_id: "tpl-1",
    });
    stageTemplateRow({ package_name: "@vendor/the-agent" });
    getAgentPackageMock.mockResolvedValue({ manifest: { cinatra: {} } });
    readProducesMock.mockReturnValue([
      { extension: "@cinatra-ai/marketing-icp-artifact" },
      { extension: "@cinatra-ai/marketing-icp-artifact" }, // dup
      { extension: "@cinatra-ai/default-artifact" }, // floor — must drop
      { extension: "@vendor/brand-voice-artifact" },
    ]);
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    expect(plan.validatedRunId).toBe("run-x");
    expect(plan.produces).toEqual([
      "@cinatra-ai/marketing-icp-artifact",
      "@vendor/brand-voice-artifact",
    ]);
    expect(getAgentPackageMock).toHaveBeenCalledWith({
      packageName: "@vendor/the-agent",
      packageVersion: "2.3.1",
    });
  });

  it("CG-4: drops a produces entry whose artifact extension is archived (install-active gate)", async () => {
    stageRunRow({ org_id: "org-a", package_version: "2.3.1", template_id: "tpl-1" });
    stageTemplateRow({ package_name: "@vendor/the-agent" });
    getAgentPackageMock.mockResolvedValue({ manifest: { cinatra: {} } });
    readProducesMock.mockReturnValue([
      { extension: "@cinatra-ai/marketing-icp-artifact" }, // active
      { extension: "@vendor/archived-artifact" }, // archived → dropped
    ]);
    writeAllowedMock.mockImplementation(async (ext: string) => ext !== "@vendor/archived-artifact");

    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    expect(plan.validatedRunId).toBe("run-x");
    // The archived artifact extension is NOT asserted onto the new artifact.
    expect(plan.produces).toEqual(["@cinatra-ai/marketing-icp-artifact"]);
  });

  it("null package_version → getAgentPackage called with undefined (dist-tag default)", async () => {
    stageRunRow({
      org_id: "org-a",
      package_version: null,
      template_id: "tpl-1",
    });
    stageTemplateRow({ package_name: "@vendor/the-agent" });
    getAgentPackageMock.mockResolvedValue({ manifest: {} });
    readProducesMock.mockReturnValue([{ extension: "@vendor/x-artifact" }]);
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    expect(getAgentPackageMock).toHaveBeenCalledWith({
      packageName: "@vendor/the-agent",
      packageVersion: undefined,
    });
    expect(plan.produces).toEqual(["@vendor/x-artifact"]);
  });

  it("manifest read throws → validatedRunId kept, empty produces (never blocks creation)", async () => {
    stageRunRow({
      org_id: "org-a",
      package_version: "1.0.0",
      template_id: "tpl-1",
    });
    stageTemplateRow({ package_name: "@vendor/the-agent" });
    getAgentPackageMock.mockRejectedValue(new Error("registry 503"));
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    expect(plan).toEqual({ validatedRunId: "run-x", produces: [] });
  });

  it("agent_runs lookup throws → fully empty (degrade, never throw)", async () => {
    runPostgresQueriesSyncMock.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const plan = await resolveProducerAssertionPlan({
      createdByRunId: "run-x",
      orgId: "org-a",
    });
    expect(plan).toEqual({ validatedRunId: null, produces: [] });
  });
});

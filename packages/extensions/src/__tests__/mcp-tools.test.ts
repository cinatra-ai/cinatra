import { describe, it, expect, vi, beforeEach } from "vitest";
import { createExtensionsPrimitiveHandlers } from "../mcp/handlers";
import type { Actor } from "@cinatra-ai/extension-types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@cinatra-ai/registries", () => ({
  listAgentPackages: vi.fn(),
  // extensions_search uses the kind-agnostic + multi-scope
  // listExtensionPackages.
  listExtensionPackages: vi.fn(),
  getAgentPackage: vi.fn(),
  // Lifecycle dispatch goes through the kind-agnostic packument summary.
  // Default the mock to a typical agent
  // shape; tests override per-case.
  getPublishedExtensionSummary: vi.fn(async () => ({
    kind: "agent",
    resolvedVersion: "1.0.0",
    manifest: { cinatra: { kind: "agent" } },
  })),
  getPublishedExtensionKind: vi.fn(async () => "agent"),
}));

vi.mock("../index", () => ({
  extensionRegistry: {
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    forceDelete: vi.fn().mockResolvedValue({
      danglingReferences: {
        agent_runs_count: 0,
        agent_runs_count_capped: false,
        dependent_extensions: [],
        dependent_extensions_capped: false,
      },
    }),
    register: vi.fn(),
    validate: vi.fn(),
    _resetForTesting: vi.fn(),
  },
  // Registry unpublish/delete handlers call this locked-row guard.
  // Default to a permissive no-op so existing ordering assertions hold; the
  // locked-rejection path is covered by lifecycle-primitive + dispatcher tests.
  assertNoLockedCanonicalRow: vi.fn().mockResolvedValue(undefined),
}));

// Registry-only handlers lazily import these. The order array
// proves audit/quarantine happen BEFORE the registry mutation.
const regCalls: string[] = [];
const deprecateMock = vi.fn(async () => {
  regCalls.push("deprecate");
});
const deleteMock = vi.fn(async () => {
  regCalls.push("delete");
  return { deleted: true, notFound: false };
});
const auditMock = vi.fn(async () => {
  regCalls.push("audit");
});
const quarantineMock2 = vi.fn(async () => {
  regCalls.push("quarantine");
  return { quarantineDir: "/tmp/q", tarballs: ["t"], missingTarballs: [] as string[] };
});
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForServer: vi.fn(async () => ({
    registryUrl: "http://localhost:4873",
    packageScope: "@cinatra-ai",
    token: "t",
  })),
}));
vi.mock("@cinatra-ai/agents/verdaccio/client", () => ({
  deprecateAgentPackageVersion: (...a: unknown[]) =>
    (deprecateMock as (...x: unknown[]) => unknown)(...a),
  deleteAgentPackageVersion: (...a: unknown[]) =>
    (deleteMock as (...x: unknown[]) => unknown)(...a),
  downloadAgentPackageTarball: vi.fn(async () => true),
}));
vi.mock("../audit-log", () => ({
  computeDanglingReferences: vi.fn(async () => ({
    agent_runs_count: 0,
    agent_runs_count_capped: false,
    dependent_extensions: [],
    dependent_extensions_capped: false,
  })),
  writeExtensionLifecycleAuditEntry: (...a: unknown[]) =>
    (auditMock as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("../quarantine", () => ({
  quarantineExtensionBeforePurge: (...a: unknown[]) =>
    (quarantineMock2 as (...x: unknown[]) => unknown)(...a),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeActor = (): Actor => ({
  actorType: "model",
  userId: "user-1",
  source: "agent",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extensions MCP tool handlers", () => {
  let listExtensionPackages: ReturnType<typeof vi.fn>;
  let getAgentPackage: ReturnType<typeof vi.fn>;
  let getPublishedExtensionSummary: ReturnType<typeof vi.fn>;
  let extensionRegistry: {
    install: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    uninstall: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    forceDelete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const registries = await import("@cinatra-ai/registries");
    listExtensionPackages = (registries as unknown as { listExtensionPackages: ReturnType<typeof vi.fn> }).listExtensionPackages as ReturnType<typeof vi.fn>;
    getAgentPackage = registries.getAgentPackage as ReturnType<typeof vi.fn>;
    getPublishedExtensionSummary = (registries as unknown as { getPublishedExtensionSummary: ReturnType<typeof vi.fn> }).getPublishedExtensionSummary;
    const indexModule = await import("../index");
    extensionRegistry = indexModule.extensionRegistry as unknown as {
      install: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      uninstall: ReturnType<typeof vi.fn>;
      archive: ReturnType<typeof vi.fn>;
      restore: ReturnType<typeof vi.fn>;
      forceDelete: ReturnType<typeof vi.fn>;
    };
  });

  it("extensions_search returns package list from listExtensionPackages mock", async () => {
    const mockPackages = [
      {
        packageName: "@cinatra/test-agent",
        packageVersion: "1.0.0",
        title: "Test Agent",
        origin: null, // legacy package — grandfather to public
      },
    ];
    listExtensionPackages.mockResolvedValueOnce(mockPackages);

    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_search({ query: "test", limit: 10 });

    // Handler now passes `allowedScopes: undefined` + `viewerScope` to
    // listExtensionPackages so visibility filtering is driven by the
    // per-package `origin` block (and applied BEFORE the `limit` slice,
    // so the result always contains up to `limit` actually-visible rows).
    // `viewerScope` is `undefined` in the test environment because the
    // fixture doesn't seed an instance identity.
    expect(listExtensionPackages).toHaveBeenCalledWith(
      {
        query: "test",
        limit: 10,
        allowedScopes: undefined,
        viewerScope: undefined,
      },
      expect.objectContaining({ registryUrl: expect.any(String) }),
    );
    expect(result).toEqual({ packages: mockPackages });
  });

  it("extensions_install calls extensionRegistry.install with correct typeId for agent kind", async () => {
    // The resolver returns the SAME concrete version that was requested
    // (exact-version input), so dispatch + record carry it through unchanged.
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: "2.0.0", manifest: { cinatra: { kind: "agent" } } });
    extensionRegistry.install.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_install(
      { packageName: "@cinatra/my-agent", packageVersion: "2.0.0" },
      actor,
    );

    expect(extensionRegistry.install).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/my-agent", version: "2.0.0" },
      actor,
    );
    expect(result).toEqual({
      success: true,
      packageName: "@cinatra/my-agent",
      packageVersion: "2.0.0",
    });
  });

  it("extensions_install dispatches + records the RESOLVED exact version, not the raw 'latest' input", async () => {
    // A caller installing "latest" authorizes a concrete version (resolved by
    // resolveExtensionPackageForLifecycle / the gatekept authorize). The
    // dispatch to extensionRegistry.install (which feeds
    // syncCanonicalManifestInstall → records ref.version) and the recorded
    // response MUST be the resolved exact version, never the moving "latest"
    // tag — otherwise the canonical manifest persists a tag that drifts from
    // what was actually fetched.
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: "3.4.5", manifest: { cinatra: { kind: "agent" } } });
    extensionRegistry.install.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_install(
      { packageName: "@cinatra/my-agent", packageVersion: "latest" },
      actor,
    );

    expect(extensionRegistry.install).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/my-agent", version: "3.4.5" },
      actor,
    );
    expect(result).toEqual({
      success: true,
      packageName: "@cinatra/my-agent",
      packageVersion: "3.4.5",
    });
  });

  it("extensions_install falls back to the raw input version when the resolver yields no concrete version", async () => {
    // Defensive non-breaking fallback: if resolution.resolvedVersion is null
    // (e.g. a packument with no versions on the flag-OFF legacy path), dispatch
    // + record the raw input version rather than a null/undefined.
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: null, manifest: { cinatra: { kind: "agent" } } });
    extensionRegistry.install.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_install(
      { packageName: "@cinatra/my-agent", packageVersion: "2.0.0" },
      actor,
    );

    expect(extensionRegistry.install).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/my-agent", version: "2.0.0" },
      actor,
    );
    expect(result.packageVersion).toBe("2.0.0");
  });

  it("extensions_update calls extensionRegistry.update with correct typeId", async () => {
    // deriveTypeId throws on unsupported kinds instead of silently rerouting
    // to "agent", which would produce cryptic Zod errors deep in the agent
    // install path. Use kind:"agent"
    // here for the happy path and assert the throw separately below.
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: "3.1.0", manifest: { cinatra: { kind: "agent" } } });
    extensionRegistry.update.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_update(
      { packageName: "@cinatra/my-agent-2", packageVersion: "3.1.0" },
      actor,
    );

    expect(extensionRegistry.update).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/my-agent-2", version: "3.1.0" },
      actor,
    );
    expect(result).toEqual({
      success: true,
      packageName: "@cinatra/my-agent-2",
      packageVersion: "3.1.0",
    });
  });

  it("extensions_update dispatches + records the RESOLVED exact version, not the raw 'latest' input", async () => {
    // Same exact-version-threading invariant as extensions_install: a "latest"
    // update authorizes a concrete version and must dispatch/record THAT.
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: "4.2.0", manifest: { cinatra: { kind: "agent" } } });
    extensionRegistry.update.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_update(
      { packageName: "@cinatra/my-agent-2", packageVersion: "latest" },
      actor,
    );

    expect(extensionRegistry.update).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/my-agent-2", version: "4.2.0" },
      actor,
    );
    expect(result).toEqual({
      success: true,
      packageName: "@cinatra/my-agent-2",
      packageVersion: "4.2.0",
    });
  });

  it("extensions_update dispatches connector kind to the connector handler", async () => {
    // Connector is a registered extension kind: deriveTypeId no longer
    // throws for "connector" (handler-bootstrap registers
    // createConnectorExtensionHandler). The runtime guard moved DOWN to the
    // connector handler; at the dispatch level extensions_update now resolves
    // the "connector" typeId and calls extensionRegistry.update accordingly,
    // instead of pre-failing at deriveTypeId. This unlocks
    // extensions_force_delete / extensions_purge reaching the connector
    // handler for DB + audit + Verdaccio cleanup.
    //
    // The connector handler is also MODEL-B-AWARE — a schema-config
    // connector is runtime-installable; a bundled-react one raises the typed
    // ConnectorRequiresRebuildError, which the MCP handler surfaces as a
    // { requiresRebuild:true } result (covered in connector-handler-model-b.test.ts).
    // This dispatch test only exercises the happy connector-typeId path, so it
    // mocks the RESOLVED exact version the assertion below pins (3.1.0).
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "connector", resolvedVersion: "3.1.0", manifest: { cinatra: { kind: "connector" } } });
    extensionRegistry.update.mockResolvedValueOnce(undefined);
    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    await handlers.extensions_update(
      { packageName: "@cinatra/my-connector", packageVersion: "3.1.0" },
      actor,
    );
    expect(extensionRegistry.update).toHaveBeenCalledWith(
      "connector",
      { registryUrl: "", packageName: "@cinatra/my-connector", version: "3.1.0" },
      actor,
    );
  });

  it("extensions_install surfaces a REQUIRES_REBUILD throw as a { requiresRebuild:true } result (not a 500)", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "connector", resolvedVersion: "1.0.0", manifest: { cinatra: { kind: "connector" } } });
    const reqRebuild = Object.assign(new Error("ships a bundled React setup page"), { code: "REQUIRES_REBUILD" });
    extensionRegistry.install.mockRejectedValueOnce(reqRebuild);
    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_install(
      { packageName: "@cinatra/react-connector", packageVersion: "1.0.0" },
      makeActor(),
    );
    expect(result).toMatchObject({
      success: false,
      requiresRebuild: true,
      packageName: "@cinatra/react-connector",
      packageVersion: "1.0.0",
    });
  });

  it("extensions_install re-throws a NON-rebuild error (no false success)", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "connector", resolvedVersion: "1.0.0", manifest: { cinatra: { kind: "connector" } } });
    extensionRegistry.install.mockRejectedValueOnce(new Error("pipeline did not finalize"));
    const handlers = createExtensionsPrimitiveHandlers();
    await expect(
      handlers.extensions_install({ packageName: "@cinatra/broken-connector", packageVersion: "1.0.0" }, makeActor()),
    ).rejects.toThrow(/did not finalize/);
  });

  it("extensions_uninstall calls extensionRegistry.uninstall with correct typeId", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "skill", resolvedVersion: "1.0.0", manifest: { cinatra: { kind: "skill" } } });
    extensionRegistry.uninstall.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_uninstall(
      { packageName: "@cinatra/my-skill", packageVersion: "1.5.0" },
      actor,
    );

    expect(extensionRegistry.uninstall).toHaveBeenCalledWith(
      "skill",
      { registryUrl: "", packageName: "@cinatra/my-skill", version: "1.5.0" },
      actor,
    );
    expect(result).toEqual({
      success: true,
      packageName: "@cinatra/my-skill",
    });
  });

  it("extensions_install falls back to 'agent' typeId when kind is null", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: null, resolvedVersion: "1.0.0", manifest: { cinatra: {} } });
    extensionRegistry.install.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    await handlers.extensions_install(
      { packageName: "@cinatra/legacy-pkg", packageVersion: "0.1.0" },
      actor,
    );

    expect(extensionRegistry.install).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({ packageName: "@cinatra/legacy-pkg" }),
      actor,
    );
  });

  it("extensions_search uses default limit of 20 when not specified", async () => {
    listExtensionPackages.mockResolvedValueOnce([]);

    const handlers = createExtensionsPrimitiveHandlers();
    await handlers.extensions_search({});

    // Handler passes VerdaccioConfig as second arg to listExtensionPackages.
    // viewerScope is undefined in tests (no instance identity fixture).
    expect(listExtensionPackages).toHaveBeenCalledWith(
      {
        query: undefined,
        limit: 20,
        allowedScopes: undefined,
        viewerScope: undefined,
      },
      expect.objectContaining({ registryUrl: expect.any(String) }),
    );
  });

  // -------------------------------------------------------------------------
  // Lifecycle management tool dispatch tests
  // -------------------------------------------------------------------------

  it("extensions_archive dispatches to extensionRegistry.archive with the right typeId/ref", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: "1.0.0", manifest: { cinatra: { kind: "agent" } } });
    extensionRegistry.archive.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_archive(
      { packageName: "@cinatra/agent-foo", packageVersion: "1.2.3" },
      actor,
    );

    expect(extensionRegistry.archive).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/agent-foo", version: "1.2.3" },
      actor,
    );
    expect(result).toEqual({ success: true, packageName: "@cinatra/agent-foo" });
  });

  it("extensions_restore dispatches to extensionRegistry.restore with the right typeId", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "skill", resolvedVersion: "1.0.0", manifest: { cinatra: { kind: "skill" } } });
    extensionRegistry.restore.mockResolvedValueOnce(undefined);

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_restore(
      { packageName: "@cinatra/my-skill" },
      actor,
    );

    expect(extensionRegistry.restore).toHaveBeenCalledWith(
      "skill",
      { registryUrl: "", packageName: "@cinatra/my-skill" },
      actor,
    );
    expect(result).toEqual({ success: true, packageName: "@cinatra/my-skill" });
  });

  it("extensions_force_delete returns danglingReferences in the response", async () => {
    getPublishedExtensionSummary.mockResolvedValueOnce({ kind: "agent", resolvedVersion: "1.0.0", manifest: { cinatra: { kind: "agent" } } });
    const mockDanglingRefs = {
      agent_runs_count: 5,
      agent_runs_count_capped: false,
      dependent_extensions: ["@cinatra/dep-a"],
      dependent_extensions_capped: false,
    };
    extensionRegistry.forceDelete.mockResolvedValueOnce({
      danglingReferences: mockDanglingRefs,
    });

    const handlers = createExtensionsPrimitiveHandlers();
    const actor = makeActor();
    const result = await handlers.extensions_force_delete(
      {
        packageName: "@cinatra/doomed-agent",
        packageVersion: "2.0.0",
        reason: "decommission",
        confirmDestructive: true,
      },
      actor,
    );

    expect(extensionRegistry.forceDelete).toHaveBeenCalledWith(
      "agent",
      { registryUrl: "", packageName: "@cinatra/doomed-agent", version: "2.0.0" },
      actor,
      "decommission",
    );
    expect(result).toEqual({
      success: true,
      packageName: "@cinatra/doomed-agent",
      danglingReferences: mockDanglingRefs,
    });
  });

  // Registry-only ops generalized from agent_registry_*.
  it("extensions_registry_unpublish writes a durable audit row BEFORE deprecating", async () => {
    regCalls.length = 0;
    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_registry_unpublish(
      { packageName: "@cinatra-ai/foo-connector", packageVersion: "1.2.3", message: "gone" },
      makeActor(),
    );
    expect(regCalls).toEqual(["audit", "deprecate"]); // audit-before-mutation
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "registry_unpublish",
        packageRef: expect.objectContaining({
          packageName: "@cinatra-ai/foo-connector",
          version: "1.2.3",
        }),
      }),
    );
    expect(result).toEqual({
      packageName: "@cinatra-ai/foo-connector",
      packageVersion: "1.2.3",
      deprecated: true,
    });
  });

  it("extensions_registry_delete quarantines + audits BEFORE the irreversible delete", async () => {
    regCalls.length = 0;
    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_registry_delete(
      { packageName: "@cinatra-ai/foo-skills", packageVersion: "0.4.0", confirmDestructive: true },
      makeActor(),
    );
    expect(regCalls).toEqual(["quarantine", "audit", "delete"]); // ordering
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "registry_delete" }),
    );
    expect(result).toEqual({
      packageName: "@cinatra-ai/foo-skills",
      packageVersion: "0.4.0",
      deleted: true,
      notFound: false,
      quarantineDir: "/tmp/q",
    });
  });

  it("extensions_registry_delete refuses without confirmDestructive", async () => {
    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_registry_delete(
      // @ts-expect-error — exercising the defense-in-depth guard
      { packageName: "@cinatra-ai/foo-agent", packageVersion: "9.9.9" },
      makeActor(),
    );
    expect(result).toEqual({
      error: "extensions_registry_delete requires confirmDestructive=true",
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("extensions_registry_delete refuses (no delete) when the version can't be quarantined", async () => {
    quarantineMock2.mockImplementationOnce(async () => {
      regCalls.push("quarantine");
      return { quarantineDir: "/tmp/q", tarballs: [], missingTarballs: ["0.4.0"] };
    });
    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_registry_delete(
      { packageName: "@cinatra-ai/foo-skills", packageVersion: "0.4.0", confirmDestructive: true },
      makeActor(),
    );
    expect(result.error).toMatch(/could not quarantine/);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("extensions_registry_delete returns an error envelope (with quarantineDir) on registry failure", async () => {
    deleteMock.mockImplementationOnce(async () => {
      regCalls.push("delete");
      throw new Error("registry down");
    });
    const handlers = createExtensionsPrimitiveHandlers();
    const result = await handlers.extensions_registry_delete(
      { packageName: "@cinatra-ai/foo-agent", packageVersion: "9.9.9", confirmDestructive: true },
      makeActor(),
    );
    expect(result).toEqual({ error: "registry down", quarantineDir: "/tmp/q" });
  });
});

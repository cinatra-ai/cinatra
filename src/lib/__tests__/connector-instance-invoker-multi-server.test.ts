import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_MAX_STALE_MS,
  CATALOG_TTL_MS,
  invokeConnectorInstanceTool,
  listConnectorInstanceTools,
  mapCatalogLoadErrorToServerHealth,
  type ConnectorInstanceInvokerDeps,
  type EnrolledServerRef,
  type InvokerTrustedActor,
} from "@/lib/connector-instance-invoker";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { InstanceToolPolicyRecord } from "@cinatra-ai/mcp-server/instance-tool-policy";

// cinatra#2018 S3 — the enrollment-driven acquire loop: TTL / max-stale /
// store-beats-cache / fail-closed / per-server endpoints / the typed
// catalog_unavailable distinction. The S2 suite (connector-instance-invoker.
// test.ts) pins the LEGACY path (deps without listEnrolledServers) untouched.

const NOW = 1_753_600_000_000;
const TTL = 5_000;
const MAX_STALE = 60_000;
const DEDICATED_ID = "wps-0123456789abcdef";
const DEDICATED_ENDPOINT = "https://site.test/index.php?rest_route=/mcp/vendor";
const DEFAULT_ENDPOINT = "https://site.test/index.php?rest_route=/mcp/mcp-adapter-default-server";

const ACTOR: InvokerTrustedActor = {
  actor: { principalType: "HumanUser", principalId: "u1", organizationId: "org1" } as never,
  userId: "u1",
  orgId: "org1",
  connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
};

function snapshot(
  serverId: string,
  tools: string[],
  fetchedAtMs: number,
  exposureMode: "triad-only" | "first-class" = "first-class",
): CatalogServerSnapshot {
  return {
    serverId,
    exposureMode,
    tools: tools.map((name) => ({ name, serverId, inputSchema: {}, rawAnnotations: {} })),
    catalogRevision: `rev-${serverId}-${fetchedAtMs}`,
    fetchedAtMs,
  };
}

function makeDeps(overrides: Partial<ConnectorInstanceInvokerDeps> = {}) {
  const cache = createInMemoryConnectorInstanceCatalogCache();
  const enrolled: EnrolledServerRef[] = [
    { serverId: CATALOG_DEFAULT_SERVER_ID, exposureMode: "triad-only", restPath: "/mcp/mcp-adapter-default-server" },
    { serverId: DEDICATED_ID, exposureMode: "first-class", restPath: "/mcp/vendor" },
  ];
  const listEnrolledServers = vi.fn(async () => enrolled);
  const ensureDefaultServerEnrollment = vi.fn(async () => {});
  const recordServerCatalogStatus = vi.fn(async () => {});
  // Explicit `| null` return so the retire-race tests can mockImplementation a
  // null-resolving endpoint (the inferred type would otherwise exclude null).
  const resolveInstanceEndpoint = vi.fn(
    async (
      _ck: string,
      _iid: string,
      serverId?: string,
    ): Promise<{ endpoint: string; authHeader: string } | null> =>
      serverId && serverId !== CATALOG_DEFAULT_SERVER_ID
        ? { endpoint: DEDICATED_ENDPOINT, authHeader: "Basic ded" }
        : { endpoint: DEFAULT_ENDPOINT, authHeader: "Basic def" },
  );
  const loadServerSnapshot = vi.fn(
    async (input: { serverId: string }): Promise<CatalogServerSnapshot> =>
      input.serverId === CATALOG_DEFAULT_SERVER_ID
        ? snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info", "ewpa/create-post"], NOW, "triad-only")
        : snapshot(DEDICATED_ID, ["vendor_tool"], NOW),
  );
  // Param-typed so `mock.calls` rows are indexable tuples (the wire-target
  // assertions read calls[0][0]).
  const callWireTool = vi.fn<
    (input: {
      endpoint: string;
      authHeader: string;
      name: string;
      arguments: Record<string, unknown>;
    }) => Promise<{ ok: number }>
  >(async () => ({ ok: 1 }));
  const audit = vi.fn(async () => {});
  const deps: ConnectorInstanceInvokerDeps = {
    requireUse: vi.fn(async () => {}),
    ensureDefaultOpenPolicy: vi.fn(async () => ({ created: false })),
    resolveInstanceEndpoint,
    cache,
    loadServerSnapshot,
    callWireTool,
    readPolicy: vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "open",
      updatedBy: "u",
      updatedAt: "2026-07-27T00:00:00Z",
    })),
    audit,
    listEnrolledServers,
    ensureDefaultServerEnrollment,
    recordServerCatalogStatus,
    catalogTtlMs: TTL,
    catalogMaxStaleMs: MAX_STALE,
    now: () => NOW,
    ...overrides,
  };
  return {
    deps,
    cache,
    enrolled,
    listEnrolledServers,
    ensureDefaultServerEnrollment,
    recordServerCatalogStatus,
    resolveInstanceEndpoint,
    loadServerSnapshot,
    callWireTool,
  };
}

const LIST_INPUT = { connectorKey: "wordpress", actor: ACTOR } as const;

describe("acquire — freshness matrix", () => {
  it("fresh snapshots serve from cache: no reload, both servers' tools listed", async () => {
    const { deps, cache, loadServerSnapshot } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW - TTL, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW - 1_000));
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(page.tools.map((t) => `${t.serverId}:${t.name}`).sort()).toEqual([
      `${DEDICATED_ID}:vendor_tool`,
      `${CATALOG_DEFAULT_SERVER_ID}:core/get-site-info`,
    ].sort());
    expect(loadServerSnapshot).not.toHaveBeenCalled(); // age == TTL is still fresh
  });

  it("an expired snapshot reloads through the per-server endpoint and re-caches", async () => {
    const { deps, cache, loadServerSnapshot, resolveInstanceEndpoint } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW - 1_000, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool_old"], NOW - TTL - 1));
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(loadServerSnapshot).toHaveBeenCalledTimes(1);
    expect(loadServerSnapshot.mock.calls[0]![0]).toMatchObject({
      serverId: DEDICATED_ID,
      endpoint: DEDICATED_ENDPOINT,
      authHeader: "Basic ded",
    });
    expect(resolveInstanceEndpoint).toHaveBeenCalledWith("wordpress", "inst-1", DEDICATED_ID);
    expect(page.tools.some((t) => t.name === "vendor_tool")).toBe(true);
    expect(cache.get("inst-1", DEDICATED_ID)?.tools[0]?.name).toBe("vendor_tool");
  });

  it("a FAILED reload serves the stale snapshot within max-stale and records mapped health", async () => {
    const { deps, cache, loadServerSnapshot, recordServerCatalogStatus } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW - 10_000)); // expired, within max-stale
    loadServerSnapshot.mockRejectedValueOnce(new InvokerError("invalid_response"));
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    const staleRow = page.tools.find((t) => t.name === "vendor_tool")!;
    expect(staleRow.cacheAgeMs).toBe(10_000); // honestly marked
    expect(recordServerCatalogStatus).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      serverId: DEDICATED_ID,
      status: "catalog_unavailable",
      at: NOW,
    });
  });

  it("past max-stale a dead server contributes NOTHING (fail closed)", async () => {
    const { deps, cache, loadServerSnapshot, recordServerCatalogStatus } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW - MAX_STALE - 1));
    // The dedicated server stays dead across BOTH acquires in this test.
    loadServerSnapshot.mockImplementation(async (input: { serverId: string }) => {
      if (input.serverId === DEDICATED_ID) throw new InvokerError("network_error");
      return snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only");
    });
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(page.tools.some((t) => t.name === "vendor_tool")).toBe(false);
    expect(recordServerCatalogStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: DEDICATED_ID, status: "unreachable" }),
    );
    // The dead server's tool is absent — a call without an explicit serverId
    // stays tool_not_found (we cannot know where an unlisted tool lives).
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });
});

describe("acquire — store beats cache (removed-server fail-closed, layer 1)", () => {
  it("a retired server's still-cached FRESH snapshot is unreachable (eviction deliberately suppressed)", async () => {
    const { deps, cache, enrolled } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW)); // fresh, NOT evicted
    enrolled.splice(1, 1); // the store no longer lists the dedicated server
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(page.tools.some((t) => t.serverId === DEDICATED_ID)).toBe(false);
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });

  it("a stale cursor minted before an enrollment-set change is rejected typed", async () => {
    const { deps, cache, enrolled } = makeDeps({ pageSize: 2 });
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["a", "b"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW));
    const first = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(first.nextCursor).toBeDefined();
    enrolled.splice(1, 1); // enrollment change ⇒ composite revision changes
    await expect(
      listConnectorInstanceTools({ ...LIST_INPUT, cursor: first.nextCursor! }, deps),
    ).rejects.toMatchObject({ code: "catalog_revision_changed" });
  });

  it("a store-read failure fails CLOSED — no silent default-server fallback, even with a fresh cache", async () => {
    const { deps, cache, loadServerSnapshot, callWireTool } = makeDeps({
      listEnrolledServers: vi.fn(async () => {
        throw new Error("store down");
      }),
    });
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    await expect(listConnectorInstanceTools(LIST_INPUT, deps)).rejects.toMatchObject({
      code: "catalog_unavailable",
    });
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "core/get-site-info", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "catalog_unavailable" });
    expect(loadServerSnapshot).not.toHaveBeenCalled();
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("acquire — endpoint-resolution null beats the stale cache (no serve-stale without a valid endpoint)", () => {
  it("a null per-server endpoint (fresher store says not enrolled) omits AND evicts the stale snapshot", async () => {
    const { deps, cache, loadServerSnapshot, recordServerCatalogStatus, resolveInstanceEndpoint } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW - 10_000)); // expired, WITHIN max-stale
    resolveInstanceEndpoint.mockImplementation(async (_ck: string, _iid: string, serverId?: string) =>
      serverId && serverId !== CATALOG_DEFAULT_SERVER_ID
        ? null // authoritative: the enrolled row vanished after the list read
        : { endpoint: DEFAULT_ENDPOINT, authHeader: "Basic def" },
    );
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(page.tools.some((t) => t.serverId === DEDICATED_ID)).toBe(false); // NOT stale-served
    expect(cache.get("inst-1", DEDICATED_ID)).toBeUndefined(); // store beats cache — evicted
    expect(loadServerSnapshot).not.toHaveBeenCalled();
    expect(recordServerCatalogStatus).not.toHaveBeenCalled(); // no wire verdict was produced
    // Without an explicit target its tool is simply absent…
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
    // …and explicit targeting surfaces the typed unavailability.
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, serverId: DEDICATED_ID, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "catalog_unavailable" });
  });

  it("a THROWN per-server endpoint resolution serves nothing but leaves the cache entry for the next acquire", async () => {
    const { deps, cache, resolveInstanceEndpoint } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW - 10_000));
    resolveInstanceEndpoint.mockImplementation(async (_ck: string, _iid: string, serverId?: string) => {
      if (serverId && serverId !== CATALOG_DEFAULT_SERVER_ID) throw new Error("store blip");
      return { endpoint: DEFAULT_ENDPOINT, authHeader: "Basic def" };
    });
    const page = await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(page.tools.some((t) => t.serverId === DEDICATED_ID)).toBe(false);
    expect(cache.get("inst-1", DEDICATED_ID)).toBeDefined(); // indeterminate — not evicted
  });
});

describe("acquire — explicit serverId targeting", () => {
  it("an explicitly-targeted enrolled server with no obtainable snapshot → catalog_unavailable (NOT tool_not_found)", async () => {
    const { deps, loadServerSnapshot } = makeDeps();
    loadServerSnapshot.mockImplementation(async (input: { serverId: string }) => {
      if (input.serverId === DEDICATED_ID) throw new InvokerError("session_required");
      return snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only");
    });
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, serverId: DEDICATED_ID, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "catalog_unavailable" });
    await expect(
      listConnectorInstanceTools({ ...LIST_INPUT, serverId: DEDICATED_ID }, deps),
    ).rejects.toMatchObject({ code: "catalog_unavailable" });
  });

  it("an UNENROLLED explicit serverId stays tool_not_found (a caller id is a filter, never a mint)", async () => {
    const { deps } = makeDeps();
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, serverId: "attacker-picked", actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });
});

describe("execution — per-server wire target", () => {
  it("a dedicated first-class tool executes against the dedicated endpoint, direct call shape", async () => {
    const { deps, callWireTool } = makeDeps();
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "vendor_tool", args: { a: 1 }, actor: ACTOR },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
    expect(callWireTool.mock.calls[0]![0]).toMatchObject({
      endpoint: DEDICATED_ENDPOINT,
      authHeader: "Basic ded",
      name: "vendor_tool",
      arguments: { a: 1 },
    });
  });

  it("a default-server tool keeps the instance endpoint + triad translation (behavior-identical to S2)", async () => {
    const { deps, callWireTool, resolveInstanceEndpoint } = makeDeps();
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "ewpa/create-post", args: { title: "t" }, actor: ACTOR },
      deps,
    );
    expect(callWireTool.mock.calls[0]![0]).toMatchObject({
      endpoint: DEFAULT_ENDPOINT,
      name: "mcp-adapter-execute-ability",
      arguments: { ability_name: "ewpa/create-post", parameters: { title: "t" } },
    });
    // The pre-gate instance resolve + the acquire loop's default reuse — the
    // default server never triggers a per-server endpoint resolution.
    const perServerCalls = resolveInstanceEndpoint.mock.calls.filter(
      (c) => c[2] !== undefined && c[2] !== CATALOG_DEFAULT_SERVER_ID,
    );
    expect(perServerCalls.map((c) => c[2])).toEqual([DEDICATED_ID]); // acquire-load only
  });

  it("a mid-call retire race fails closed: per-server endpoint resolves null → typed error, no wire call", async () => {
    const { deps, cache, resolveInstanceEndpoint, callWireTool } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW));
    resolveInstanceEndpoint.mockImplementation(async (_ck, _iid, serverId?: string) =>
      serverId && serverId !== CATALOG_DEFAULT_SERVER_ID
        ? null // the enrolled row vanished between acquire and execution
        : { endpoint: DEFAULT_ENDPOINT, authHeader: "Basic def" },
    );
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("gate tail — first-touch default enrollment backstop", () => {
  it("runs once per invocation on BOTH the invoke and list paths", async () => {
    const { deps, ensureDefaultServerEnrollment, cache } = makeDeps();
    cache.set("inst-1", snapshot(CATALOG_DEFAULT_SERVER_ID, ["core/get-site-info"], NOW, "triad-only"));
    cache.set("inst-1", snapshot(DEDICATED_ID, ["vendor_tool"], NOW));
    await listConnectorInstanceTools(LIST_INPUT, deps);
    expect(ensureDefaultServerEnrollment).toHaveBeenCalledTimes(1);
    expect(ensureDefaultServerEnrollment).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      instanceId: "inst-1",
    });
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "vendor_tool", args: {}, actor: ACTOR },
      deps,
    );
    expect(ensureDefaultServerEnrollment).toHaveBeenCalledTimes(2);
  });
});

describe("mapCatalogLoadErrorToServerHealth", () => {
  it("maps the typed transport taxonomy onto the persisted health states", () => {
    expect(mapCatalogLoadErrorToServerHealth(new InvokerError("network_error"))).toBe("unreachable");
    expect(mapCatalogLoadErrorToServerHealth(new InvokerError("timeout"))).toBe("unreachable");
    expect(mapCatalogLoadErrorToServerHealth(new InvokerError("session_required"))).toBe("catalog_unavailable");
    expect(mapCatalogLoadErrorToServerHealth(new InvokerError("tool_error"))).toBe("catalog_unavailable");
    expect(mapCatalogLoadErrorToServerHealth(new InvokerError("empty_response"))).toBe("catalog_unavailable");
    expect(mapCatalogLoadErrorToServerHealth(new InvokerError("invalid_response"))).toBe("catalog_unavailable");
    expect(
      mapCatalogLoadErrorToServerHealth(new InvokerError("tool_error", "denied", { httpStatus: 401 })),
    ).toBe("auth_error");
    expect(
      mapCatalogLoadErrorToServerHealth(new InvokerError("network_error", "denied", { httpStatus: 403 })),
    ).toBe("auth_error");
    expect(mapCatalogLoadErrorToServerHealth(new Error("unclassified"))).toBe("catalog_unavailable");
  });
});

describe("defaults", () => {
  it("exports the production TTL / max-stale constants (5 min / 60 min)", () => {
    expect(CATALOG_TTL_MS).toBe(5 * 60_000);
    expect(CATALOG_MAX_STALE_MS).toBe(60 * 60_000);
  });
});

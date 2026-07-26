import { describe, expect, it, vi } from "vitest";
import {
  listConnectorInstanceTools,
  type ConnectorInstanceInvokerDeps,
  type InvokerTrustedActor,
} from "@/lib/connector-instance-invoker";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { InstanceToolPolicyRecord } from "@cinatra-ai/mcp-server/instance-tool-policy";

// cinatra#2017 S2 slice K6 — governed tools_list (B2): the gate runs BEFORE any
// catalog read, and the frozen-contract rows (§3.5 / §10-A2).

const ACTOR: InvokerTrustedActor = {
  actor: { principalType: "HumanUser", principalId: "u1", organizationId: "org1" } as never,
  userId: "u1",
  orgId: "org1",
  connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
};

function snapshot(names: string[]): CatalogServerSnapshot {
  return {
    serverId: CATALOG_DEFAULT_SERVER_ID,
    exposureMode: "triad-only",
    tools: names.map((name) => ({
      name,
      serverId: CATALOG_DEFAULT_SERVER_ID,
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
      description: `desc ${name}`,
      rawAnnotations: {},
    })),
    catalogRevision: "rev-1",
    fetchedAtMs: 0,
  };
}

function makeDeps(overrides: Partial<ConnectorInstanceInvokerDeps> = {}): {
  deps: ConnectorInstanceInvokerDeps;
  requireUse: ReturnType<typeof vi.fn>;
  resolveInstanceEndpoint: ReturnType<typeof vi.fn>;
  loadServerSnapshot: ReturnType<typeof vi.fn>;
} {
  const cache = createInMemoryConnectorInstanceCatalogCache();
  cache.set("inst-1", snapshot(["core/get-site-info", "ewpa/create-post"]));
  const requireUse = vi.fn(async () => {});
  const resolveInstanceEndpoint = vi.fn(async () => ({ endpoint: "https://site/x", authHeader: "Basic z" }));
  const loadServerSnapshot = vi.fn(async () => snapshot(["core/get-site-info"]));
  const deps: ConnectorInstanceInvokerDeps = {
    requireUse,
    ensureDefaultOpenPolicy: vi.fn(async () => ({ created: false })),
    resolveInstanceEndpoint,
    cache,
    loadServerSnapshot,
    callWireTool: vi.fn(async () => ({})),
    readPolicy: vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "open",
      updatedBy: "u",
      updatedAt: "2026-07-26T00:00:00Z",
    })),
    audit: vi.fn(async () => {}),
    now: () => 1000,
    ...overrides,
  };
  return { deps, requireUse, resolveInstanceEndpoint, loadServerSnapshot };
}

describe("listConnectorInstanceTools — B2: gate BEFORE any catalog read (oracle-leak fix)", () => {
  it("no/revoked actor (requireUse throws) → typed error AND the transport/cache is NEVER touched", async () => {
    const requireUse = vi.fn(async () => {
      throw new Error("no_trusted_actor");
    });
    const { deps, resolveInstanceEndpoint, loadServerSnapshot } = makeDeps({ requireUse });
    await expect(
      listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR }, deps),
    ).rejects.toThrow("no_trusted_actor");
    expect(resolveInstanceEndpoint).not.toHaveBeenCalled();
    expect(loadServerSnapshot).not.toHaveBeenCalled();
  });

  it("pin mismatch → instance_pin_mismatch and NO catalog", async () => {
    const { deps, resolveInstanceEndpoint } = makeDeps();
    await expect(
      listConnectorInstanceTools(
        { connectorKey: "wordpress", instanceId: "inst-OTHER", actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "instance_pin_mismatch" });
    expect(resolveInstanceEndpoint).not.toHaveBeenCalled();
  });
});

describe("listConnectorInstanceTools — frozen contract (§3.5 / §10-A2)", () => {
  it("rows carry schema-bearing fields + policyStatus + derivedClass + cacheAgeMs + catalogRevision; stable sort (serverId,name)", async () => {
    const { deps } = makeDeps();
    const page = await listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR }, deps);
    expect(page.tools.map((t) => t.name)).toEqual(["core/get-site-info", "ewpa/create-post"]); // sorted
    const row = page.tools[0]!;
    expect(row.inputSchema).toMatchObject({ type: "object" });
    expect(row.description).toBe("desc core/get-site-info");
    expect(row.policyStatus).toBe("allowed");
    expect(row.derivedClass).toBe("write");
    expect(row.cacheAgeMs).toBe(1000);
    expect(typeof row.catalogRevision).toBe("string");
    expect(page.catalogRevision).toBe(row.catalogRevision);
  });

  it("restricted mode MARKS denied entries but never SHORTENS the list (N9)", async () => {
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: CATALOG_DEFAULT_SERVER_ID, name: "core/get-site-info" }],
      updatedBy: "u",
      updatedAt: "2026-07-26T00:00:00Z",
    }));
    const { deps } = makeDeps({ readPolicy });
    const page = await listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR }, deps);
    expect(page.tools).toHaveLength(2); // full catalog, not shortened
    const byName = Object.fromEntries(page.tools.map((t) => [t.name, t.policyStatus]));
    expect(byName["core/get-site-info"]).toBe("allowed");
    expect(byName["ewpa/create-post"]).toBe("denied");
  });

  it("uncapped pagination: small page yields a nextCursor; page 2 continues over the same snapshot", async () => {
    const { deps } = makeDeps({ pageSize: 1 });
    const p1 = await listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR }, deps);
    expect(p1.tools).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listConnectorInstanceTools(
      { connectorKey: "wordpress", actor: ACTOR, cursor: p1.nextCursor },
      deps,
    );
    expect(p2.tools).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined(); // last page
    expect(p2.tools[0]!.name).not.toBe(p1.tools[0]!.name);
  });

  it("revision-pinned cursor: a stale cursor is rejected with catalog_revision_changed", async () => {
    const { deps } = makeDeps({ pageSize: 1 });
    const p1 = await listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR }, deps);
    // Simulate a snapshot bump (S3's invalidation) — a new revision under the same instance.
    deps.cache.invalidate("inst-1");
    deps.cache.set("inst-1", { ...snapshot(["core/get-site-info", "ewpa/create-post"]), catalogRevision: "rev-2" });
    await expect(
      listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR, cursor: p1.nextCursor }, deps),
    ).rejects.toMatchObject({ code: "catalog_revision_changed" });
  });
});

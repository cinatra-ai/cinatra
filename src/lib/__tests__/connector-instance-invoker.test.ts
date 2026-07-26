import { describe, expect, it, vi } from "vitest";
import {
  invokeConnectorInstanceTool,
  type ConnectorInstanceInvokerDeps,
  type InvokerTrustedActor,
} from "@/lib/connector-instance-invoker";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { InstanceToolPolicyRecord } from "@cinatra-ai/mcp-server/instance-tool-policy";

// cinatra#2017 S2 slice K6 — the governed invoker core (design §1.2 order, M4
// single pass, B1 pin, §3 triad/routing). Fully mocked deps — no live stack.

const ACTOR: InvokerTrustedActor = {
  actor: { principalType: "HumanUser", principalId: "u1", organizationId: "org1" } as never,
  userId: "u1",
  orgId: "org1",
  connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
};

function triadSnapshot(
  tools: Array<{ name: string; rawAnnotations?: Record<string, unknown> }>,
  serverId = CATALOG_DEFAULT_SERVER_ID,
): CatalogServerSnapshot {
  return {
    serverId,
    exposureMode: "triad-only",
    tools: tools.map((t) => ({
      name: t.name,
      serverId,
      inputSchema: {},
      rawAnnotations: t.rawAnnotations ?? {},
    })),
    catalogRevision: "rev-1",
    fetchedAtMs: 0,
  };
}

function makeDeps(overrides: Partial<ConnectorInstanceInvokerDeps> = {}): {
  deps: ConnectorInstanceInvokerDeps;
  requireUse: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  callWireTool: ReturnType<typeof vi.fn>;
  ensureDefaultOpenPolicy: ReturnType<typeof vi.fn>;
  resolveInstanceEndpoint: ReturnType<typeof vi.fn>;
} {
  const cache = createInMemoryConnectorInstanceCatalogCache();
  cache.set("inst-1", triadSnapshot([{ name: "ewpa/create-post" }, { name: "core/get-site-info" }]));

  const requireUse = vi.fn(async () => {});
  const audit = vi.fn(async () => {});
  const callWireTool = vi.fn(async () => ({ success: true, data: { ok: 1 } }));
  const ensureDefaultOpenPolicy = vi.fn(async () => ({ created: true }));
  const resolveInstanceEndpoint = vi.fn(async () => ({ endpoint: "https://site/x", authHeader: "Basic zzz" }));
  const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
    connectorKey: "wordpress",
    instanceId: "inst-1",
    mode: "open",
    updatedBy: "u",
    updatedAt: "2026-07-26T00:00:00Z",
  }));

  const deps: ConnectorInstanceInvokerDeps = {
    requireUse,
    ensureDefaultOpenPolicy,
    resolveInstanceEndpoint,
    cache,
    loadServerSnapshot: vi.fn(async () => triadSnapshot([{ name: "ewpa/create-post" }])),
    callWireTool,
    readPolicy,
    audit,
    ...overrides,
  };
  return { deps, requireUse, audit, callWireTool, ensureDefaultOpenPolicy, resolveInstanceEndpoint };
}

describe("invokeConnectorInstanceTool — order, single pass (M4), triad translation", () => {
  it("happy path: one authority pass, one execution audit, triad-translated wire call", async () => {
    const { deps, requireUse, audit, callWireTool, ensureDefaultOpenPolicy } = makeDeps();
    const result = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "ewpa/create-post", args: { title: "t" }, actor: ACTOR, causation: "run-9" },
      deps,
    );
    expect(result).toEqual({ success: true, data: { ok: 1 } });
    // Single live authority pass (M4).
    expect(requireUse).toHaveBeenCalledTimes(1);
    // Lazy first-touch after the gate.
    expect(ensureDefaultOpenPolicy).toHaveBeenCalledTimes(1);
    // Triad translation: toolName → execute-ability{ability_name,parameters}.
    expect(callWireTool).toHaveBeenCalledTimes(1);
    expect(callWireTool.mock.calls[0][0]).toMatchObject({
      name: "mcp-adapter-execute-ability",
      arguments: { ability_name: "ewpa/create-post", parameters: { title: "t" } },
    });
    // Exactly one execution audit, carrying causation.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ decision: "allowed", causation: "run-9" });
  });

  it("first-class server → direct callTool(name, args), no triad wrapping", async () => {
    const { deps, callWireTool } = makeDeps();
    deps.cache.invalidate("inst-1");
    deps.cache.set("inst-1", {
      serverId: CATALOG_DEFAULT_SERVER_ID,
      exposureMode: "first-class",
      tools: [{ name: "native_tool", serverId: CATALOG_DEFAULT_SERVER_ID, inputSchema: {}, rawAnnotations: {} }],
      catalogRevision: "rev-1",
      fetchedAtMs: 0,
    });
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "native_tool", args: { a: 1 }, actor: ACTOR },
      deps,
    );
    expect(callWireTool.mock.calls[0][0]).toMatchObject({ name: "native_tool", arguments: { a: 1 } });
  });
});

describe("invokeConnectorInstanceTool — step 0 pin gate (B1)", () => {
  it("effectiveInstanceId = input.instanceId ?? pin.instanceId (omitted → pinned id)", async () => {
    const { deps, requireUse } = makeDeps();
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR },
      deps,
    );
    expect(requireUse.mock.calls[0][1]).toMatchObject({ instanceId: "inst-1" });
  });

  it("rejects instanceId mismatch vs the signed pin → instance_pin_mismatch", async () => {
    const { deps, callWireTool } = makeDeps();
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, instanceId: "inst-OTHER", actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "instance_pin_mismatch" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("rejects a FOREIGN connectorKey pin (cross-connector) → instance_pin_mismatch", async () => {
    const { deps } = makeDeps();
    const drupalPinnedActor: InvokerTrustedActor = {
      ...ACTOR,
      connectorInstancePin: { connectorKey: "drupal", instanceId: "inst-1" },
    };
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: drupalPinnedActor },
        deps,
      ),
    ).rejects.toMatchObject({ code: "instance_pin_mismatch" });
  });

  it("pin absent + no explicit instanceId → instance_id_required", async () => {
    const { deps } = makeDeps();
    const noPin: InvokerTrustedActor = { actor: ACTOR.actor, userId: "u1", orgId: "org1" };
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: noPin },
        deps,
      ),
    ).rejects.toMatchObject({ code: "instance_id_required" });
  });

  it("pin absent + explicit instanceId (org scope) → proceeds", async () => {
    const { deps, requireUse } = makeDeps();
    const noPin: InvokerTrustedActor = { actor: ACTOR.actor, userId: "u1", orgId: "org1" };
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, instanceId: "inst-1", actor: noPin },
      deps,
    );
    expect(requireUse).toHaveBeenCalledTimes(1);
  });
});

describe("invokeConnectorInstanceTool — deny short-circuits (no wire call, single pass)", () => {
  it("requireUse deny propagates BEFORE any endpoint/catalog/wire touch", async () => {
    const requireUse = vi.fn(async () => {
      throw new Error("no_trusted_actor");
    });
    const { deps, callWireTool, resolveInstanceEndpoint } = makeDeps({ requireUse });
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toThrow("no_trusted_actor");
    expect(requireUse).toHaveBeenCalledTimes(1); // single pass
    expect(resolveInstanceEndpoint).not.toHaveBeenCalled();
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("policy deny (restricted empty allow) → tool_policy_denied, no wire call", async () => {
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      updatedBy: "u",
      updatedAt: "2026-07-26T00:00:00Z",
    }));
    const { deps, callWireTool } = makeDeps({ readPolicy });
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_policy_denied" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("tool_not_found (presence-check miss) → typed error, no wire call", async () => {
    const { deps, callWireTool } = makeDeps();
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "nope/missing", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("invokeConnectorInstanceTool — duplicate-name routing (§3.6)", () => {
  it("ambiguous name across two servers with no serverId → ambiguous_tool", async () => {
    const { deps } = makeDeps();
    deps.cache.set("inst-1", triadSnapshot([{ name: "dup" }], "server-a"));
    deps.cache.set("inst-1", triadSnapshot([{ name: "dup" }], "server-b"));
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "dup", args: {}, actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "ambiguous_tool" });
  });

  it("ambiguous name resolves when serverId is supplied", async () => {
    const { deps, callWireTool } = makeDeps();
    deps.cache.set("inst-1", triadSnapshot([{ name: "dup" }], "server-a"));
    deps.cache.set("inst-1", triadSnapshot([{ name: "dup" }], "server-b"));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "dup", args: {}, serverId: "server-b", actor: ACTOR },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });
});

describe("invokeConnectorInstanceTool — destructive hook (step 3, S5 seam)", () => {
  it("fires the hook only when enabled AND the resolved tool classifies destructive", async () => {
    const fire = vi.fn(async () => {});
    const { deps } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for a read-classified tool", async () => {
    const fire = vi.fn(async () => {});
    const { deps } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "safe", rawAnnotations: { readOnlyHint: true } }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "safe", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).not.toHaveBeenCalled();
  });
});

// Guard the InvokerError type surface is used (import-level).
it("InvokerError carries a typed code", () => {
  expect(new InvokerError("tool_not_found").code).toBe("tool_not_found");
});

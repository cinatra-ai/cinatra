import { describe, expect, it, vi } from "vitest";
import {
  invokeConnectorInstanceTool,
  listConnectorInstanceTools,
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

// cinatra#3745 — a site-tool call binds to the catalog row its caller checked.
//
// A connector's read tool lists the catalog, checks that the row is read-class,
// then calls it. The host resolves the call against ITS OWN cached snapshot, so
// a snapshot refresh between the list and the call could turn the same
// `{serverId, name}` row into an ordinary (non-destructive) write that no hook
// stops. `expectedRawAnnotations` binds the call to the annotations the caller
// saw; `expectedClass: "read"` lets a caller that must only read say so.

const ACTOR: InvokerTrustedActor = {
  actor: { principalType: "HumanUser", principalId: "u1", organizationId: "org1" } as never,
  userId: "u1",
  orgId: "org1",
  connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
};

const READ_TOOL = "core/get-page";

function snapshot(
  tools: Array<{ name: string; rawAnnotations?: Record<string, unknown> }>,
  revision: string,
): CatalogServerSnapshot {
  return {
    serverId: CATALOG_DEFAULT_SERVER_ID,
    exposureMode: "triad-only",
    tools: tools.map((t) => ({
      name: t.name,
      serverId: CATALOG_DEFAULT_SERVER_ID,
      inputSchema: {},
      rawAnnotations: t.rawAnnotations ?? {},
    })),
    catalogRevision: revision,
    fetchedAtMs: 0,
  };
}

function makeDeps(initial: CatalogServerSnapshot) {
  const cache = createInMemoryConnectorInstanceCatalogCache();
  cache.set("inst-1", initial);
  const callWireTool = vi.fn(async () => ({ success: true, data: { ok: 1 } }));
  const destructiveFire = vi.fn(async () => ({ action: "continue" as const }));
  const contentReviewFire = vi.fn(async () => ({ action: "continue" as const }));
  const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
    connectorKey: "wordpress",
    instanceId: "inst-1",
    mode: "open",
    updatedBy: "u",
    updatedAt: "2026-11-25T00:00:00Z",
  }));
  const deps: ConnectorInstanceInvokerDeps = {
    requireUse: vi.fn(async () => {}),
    ensureDefaultOpenPolicy: vi.fn(async () => ({ created: false })),
    resolveInstanceEndpoint: vi.fn(async () => ({ endpoint: "https://site/x", authHeader: "Basic zzz" })),
    cache,
    loadServerSnapshot: vi.fn(async () => initial),
    callWireTool,
    readPolicy,
    audit: vi.fn(async () => {}),
    destructiveHook: { enabled: () => true, fire: destructiveFire },
    contentReviewHook: { enabled: () => true, fire: contentReviewFire },
  };
  return { deps, cache, callWireTool, destructiveFire, contentReviewFire, readPolicy };
}

async function listRow(deps: ConnectorInstanceInvokerDeps, name: string) {
  const page = await listConnectorInstanceTools({ connectorKey: "wordpress", actor: ACTOR }, deps);
  const row = page.tools.find((t) => t.name === name);
  if (!row) throw new Error(`row ${name} not listed`);
  return row;
}

describe("invokeConnectorInstanceTool — expectedRawAnnotations binds the call to the listed row (cinatra#3745)", () => {
  it("refuses a row that became an ordinary write between the list and the call: nothing executes, no hook fires", async () => {
    const { deps, cache, callWireTool, destructiveFire, contentReviewFire, readPolicy } = makeDeps(
      snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"),
    );
    const row = await listRow(deps, READ_TOOL);
    expect(row.derivedClass).toBe("read");
    readPolicy.mockClear();

    // The host's snapshot refreshes: the same {serverId, name} is now a write.
    cache.set("inst-1", snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: false } }], "rev-b"));

    const call = invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: { id: 7 },
        actor: ACTOR,
        expectedRawAnnotations: row.rawAnnotations,
      },
      deps,
    );
    // red-first-expect: promise resolved "{ success: true, data: { ok: 1 } }" instead of rejecting
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
    expect(destructiveFire).not.toHaveBeenCalled();
    expect(contentReviewFire).not.toHaveBeenCalled();
    // Refused before the policy step.
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it("executes a row that did not change", async () => {
    const { deps, callWireTool } = makeDeps(
      snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true, title: "Get page" } }], "rev-a"),
    );
    const row = await listRow(deps, READ_TOOL);
    const result = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedRawAnnotations: row.rawAnnotations },
      deps,
    );
    expect(result).toEqual({ success: true, data: { ok: 1 } });
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("executes an unannotated row that was listed and sent back unchanged", async () => {
    const { deps, callWireTool } = makeDeps(snapshot([{ name: "core/plain" }], "rev-a"));
    const row = await listRow(deps, "core/plain");
    expect(row.rawAnnotations).toEqual({});
    // The row as the connector receives it over the wire (a JSON round trip).
    const sentBack = JSON.parse(JSON.stringify(row.rawAnnotations)) as Record<string, unknown>;
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "core/plain", args: {}, actor: ACTOR, expectedRawAnnotations: sentBack },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("does not refuse when only the key order differs, at any depth", async () => {
    const { deps, callWireTool } = makeDeps(
      snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true, meta: { a: 1, b: [1, { y: 2, x: 1 }] } } }], "rev-a"),
    );
    await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        expectedRawAnnotations: { meta: { b: [1, { x: 1, y: 2 }], a: 1 }, readOnlyHint: true },
      },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("refuses an extra or a missing annotation key, and a value that is not an object", async () => {
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    for (const expected of [{ readOnlyHint: true, destructiveHint: false }, {}, null, []]) {
      const call = invokeConnectorInstanceTool(
        {
          connectorKey: "wordpress",
          toolName: READ_TOOL,
          args: {},
          actor: ACTOR,
          expectedRawAnnotations: expected as unknown as Record<string, unknown>,
        },
        deps,
      );
      await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    }
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("invokeConnectorInstanceTool — the annotations comparison reads own keys only (cinatra#3745)", () => {
  it("refuses a row that differs from the listed one only by an own __proto__ annotation", async () => {
    const changed = JSON.parse('{"readOnlyHint":true,"__proto__":{"destructiveHint":true}}') as Record<string, unknown>;
    expect(Object.keys(changed)).toContain("__proto__");
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: changed }], "rev-a"));
    const call = invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedRawAnnotations: { readOnlyHint: true } },
      deps,
    );
    // red-first-expect: promise resolved "{ success: true, data: { ok: 1 } }" instead of rejecting
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("refuses a caller whose listed row carries an own __proto__ annotation the current row lacks", async () => {
    const listed = JSON.parse('{"readOnlyHint":true,"__proto__":{"x":1}}') as Record<string, unknown>;
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    const call = invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedRawAnnotations: listed },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("compares integer-like keys by content, whatever their insertion order", async () => {
    const current = JSON.parse('{"a":1,"10":{"z":1,"2":2},"2":"x"}') as Record<string, unknown>;
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: current }], "rev-a"));
    await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        expectedRawAnnotations: JSON.parse('{"2":"x","10":{"2":2,"z":1},"a":1}') as Record<string, unknown>,
      },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
    const changed = invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        expectedRawAnnotations: JSON.parse('{"2":"y","10":{"2":2,"z":1},"a":1}') as Record<string, unknown>,
      },
      deps,
    );
    await expect(changed).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("refuses an annotations value it cannot compare instead of throwing past the refusal", async () => {
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    const call = invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedRawAnnotations: { readOnlyHint: true, n: BigInt(1) } },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("invokeConnectorInstanceTool — only plain objects compare (cinatra#3745)", () => {
  class Annotations {}
  it("refuses a Map, a Date, a class instance and a nested Map or Date for an unannotated row", async () => {
    for (const bad of [new Map(), new Date(0), new Annotations(), { inner: new Map() }, { at: [new Date(0)] }]) {
      const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL }], "rev-a"));
      const call = invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedRawAnnotations: bad as never },
        deps,
      );
      // red-first-expect: promise resolved "{ success: true, data: { ok: 1 } }" instead of rejecting
      await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
      expect(callWireTool).not.toHaveBeenCalled();
    }
  });

  it("accepts a null-prototype record equal to the row", async () => {
    const listed = Object.assign(Object.create(null) as Record<string, unknown>, { readOnlyHint: true });
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedRawAnnotations: listed },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });
});

describe("invokeConnectorInstanceTool — expectedServerId binds the call to the listed server (cinatra#3745)", () => {
  // Server A's unique row is gone; server B now carries the same name and
  // annotations. The caller listed (and checked) the row on A.
  function onlyOnServerB(): CatalogServerSnapshot {
    const base = snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-b");
    return { ...base, serverId: "srv-b", tools: base.tools.map((t) => ({ ...t, serverId: "srv-b" })) };
  }

  it("refuses a row that resolves on another server than the listed one: nothing executes", async () => {
    const { deps, callWireTool } = makeDeps(onlyOnServerB());
    const call = invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        expectedRawAnnotations: { readOnlyHint: true },
        expectedServerId: "srv-a",
      },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("with serverId of A the resolution stays on A and refuses the substitution", async () => {
    const { deps, callWireTool } = makeDeps(onlyOnServerB());
    const call = invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        serverId: "srv-a",
        expectedRawAnnotations: { readOnlyHint: true },
        expectedServerId: "srv-a",
      },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("refuses a tool gone from the listed server with no other server carrying it", async () => {
    const { deps, callWireTool } = makeDeps(snapshot([{ name: "core/other" }], "rev-c"));
    const call = invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        serverId: CATALOG_DEFAULT_SERVER_ID,
        expectedRawAnnotations: { readOnlyHint: true },
        expectedServerId: CATALOG_DEFAULT_SERVER_ID,
      },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("an unguarded call for a missing tool still answers tool_not_found", async () => {
    const { deps } = makeDeps(onlyOnServerB());
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, serverId: "srv-a" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });

  it("executes the row on the listed server", async () => {
    const { deps, callWireTool } = makeDeps(onlyOnServerB());
    await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: READ_TOOL,
        args: {},
        actor: ACTOR,
        serverId: "srv-b",
        expectedRawAnnotations: { readOnlyHint: true },
        expectedServerId: "srv-b",
      },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });
});

describe("listConnectorInstanceTools hands out copies, never the stored catalog objects (cinatra#3745)", () => {
  it("a listed row's annotations mutated to read-only do not change what the guarded call compares or classifies", async () => {
    const { deps, callWireTool, destructiveFire, contentReviewFire } = makeDeps(
      snapshot([{ name: "core/update-page", rawAnnotations: { readOnlyHint: false } }], "rev-a"),
    );
    const row = await listRow(deps, "core/update-page");
    expect(row.derivedClass).not.toBe("read");
    row.rawAnnotations.readOnlyHint = true;
    (row.inputSchema as Record<string, unknown>).mutated = true;
    const call = invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: "core/update-page",
        args: {},
        actor: ACTOR,
        serverId: CATALOG_DEFAULT_SERVER_ID,
        expectedServerId: CATALOG_DEFAULT_SERVER_ID,
        expectedRawAnnotations: row.rawAnnotations,
        expectedClass: "read",
      },
      deps,
    );
    // red-first-expect: promise resolved "{ success: true, data: { ok: 1 } }" instead of rejecting
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_changed" });
    expect(callWireTool).not.toHaveBeenCalled();
    expect(destructiveFire).not.toHaveBeenCalled();
    expect(contentReviewFire).not.toHaveBeenCalled();
    const again = await listRow(deps, "core/update-page");
    expect(again.rawAnnotations).toEqual({ readOnlyHint: false });
    expect(again.inputSchema).toEqual({});
  });

  it("a hook receives copies of the stored schema and annotations", async () => {
    const { deps, cache, destructiveFire } = makeDeps(
      snapshot([{ name: "core/delete-post", rawAnnotations: { destructiveHint: true } }], "rev-a"),
    );
    const mutatingHook = async (input: { rawAnnotations: Record<string, unknown> }) => {
      input.rawAnnotations.destructiveHint = false;
      return { action: "continue" as const };
    };
    destructiveFire.mockImplementation(mutatingHook as unknown as () => Promise<{ action: "continue" }>);
    await invokeConnectorInstanceTool({ connectorKey: "wordpress", toolName: "core/delete-post", args: {}, actor: ACTOR }, deps);
    expect(destructiveFire).toHaveBeenCalledTimes(1);
    expect(cache.listForInstance("inst-1")[0]!.tools[0]!.rawAnnotations).toEqual({ destructiveHint: true });
  });
});

describe("invokeConnectorInstanceTool — expectedClass: \"read\" (cinatra#3745)", () => {
  it("refuses a write-class entry: nothing executes, no hook fires", async () => {
    const { deps, callWireTool, destructiveFire, contentReviewFire } = makeDeps(
      snapshot([{ name: "core/update-page", rawAnnotations: { readOnlyHint: false } }], "rev-a"),
    );
    const call = invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "core/update-page", args: {}, actor: ACTOR, expectedClass: "read" },
      deps,
    );
    // red-first-expect: promise resolved "{ success: true, data: { ok: 1 } }" instead of rejecting
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_not_read" });
    expect(callWireTool).not.toHaveBeenCalled();
    expect(destructiveFire).not.toHaveBeenCalled();
    expect(contentReviewFire).not.toHaveBeenCalled();
  });

  it("refuses a read-annotated entry whose name is on the known-destructive list", async () => {
    const { deps, callWireTool, destructiveFire } = makeDeps(
      snapshot([{ name: "core/delete-post", rawAnnotations: { readOnlyHint: true } }], "rev-a"),
    );
    const call = invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "core/delete-post", args: {}, actor: ACTOR, expectedClass: "read" },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_not_read" });
    expect(callWireTool).not.toHaveBeenCalled();
    expect(destructiveFire).not.toHaveBeenCalled();
  });

  it("refuses any other expectedClass value, even on a read-class entry", async () => {
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    const call = invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedClass: "write" as never },
      deps,
    );
    await expect(call).rejects.toMatchObject({ code: "catalog_entry_not_read" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("passes a read-class entry", async () => {
    const { deps, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR, expectedClass: "read" },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("a call without either field behaves as before: a changed write still executes", async () => {
    const { deps, cache, callWireTool } = makeDeps(snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: true } }], "rev-a"));
    cache.set("inst-1", snapshot([{ name: READ_TOOL, rawAnnotations: { readOnlyHint: false } }], "rev-b"));
    await invokeConnectorInstanceTool({ connectorKey: "wordpress", toolName: READ_TOOL, args: {}, actor: ACTOR }, deps);
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });
});

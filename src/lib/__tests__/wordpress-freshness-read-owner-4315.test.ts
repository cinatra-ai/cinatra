/**
 * The WordPress freshness read on an agent run (cinatra#4315).
 *
 * A core restore or freshness tool runs its handler in the run frame with no
 * guarded owner, so the connector invoker refuses the freshness read and the
 * adapter turns that refusal into `unknown`. The adapter now pins a host read
 * owner for exactly its own read (the WordPress connector, the instance and the
 * one read ability), so the read is served on a run. Off a run nothing changes.
 * The owner comes only from the host code; caller-supplied invoker fields never
 * serve a call, a write ability still refuses, and an outward call still
 * refuses under the new owner. The minter takes no connector or ability name
 * (a closed list of read abilities), and its mint proof is module-private: an
 * owner added to a globally reachable set, an inherited `hostRead` or a Proxy
 * that answers `hostRead` serves nothing.
 *
 * Drives the real adapter, the real invoker and the real run guard; the run
 * store, the audit writer, the trusted-actor resolution and the invoker's
 * injected deps (wire, endpoint, catalog) are doubles.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ deps: undefined as unknown }));
vi.mock("@cinatra-ai/agents/store", () => ({
  parseRunStepToolPolicy: (p: unknown) => p,
  readRunStepToolPolicy: async () => ({}),
  assertRunStepToolAllowed: () => ({ kind: "declared" }),
  isRunExecutedSourceCurrent: async () => true,
  withRunActionPolicyTransaction: async () => {
    throw new Error("no person-gate consumption in these cases");
  },
}));
vi.mock("@/lib/register-host-connector-services", () => ({
  buildConnectorInstanceInvokerDeps: () => h.deps,
}));
vi.mock("@/lib/connector-instance-write-authority", () => ({
  resolveTrustedWriteActor: async () => ({
    actor: { principalType: "HumanUser", principalId: "person", organizationId: "org" },
    userId: "person",
    orgId: "org",
  }),
}));

import * as auditModule from "@/lib/authz/audit";
import { OUTWARD_EFFECT_TOOL_NAMES } from "@/lib/authz/mcp-boundary";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";
import { InvokerError } from "@/lib/connector-instance-mcp-transport";
import { markDeclaredOutwardRunFrame } from "../extension-capabilities-registry";
import * as hostContext from "../extension-host-context";
import {
  invokeConnectorInstanceTool,
  type ConnectorInstanceInvokerDeps,
  type InvokerTrustedActor,
} from "../connector-instance-invoker";
import {
  createInMemoryConnectorInstanceCatalogCache,
  CATALOG_DEFAULT_SERVER_ID,
  type CatalogServerSnapshot,
} from "../connector-instance-catalog-cache";
import { wordpressFreshnessAdapter } from "../object-history/freshness/wordpress-adapter";

const INSTANCE = "wp_instance_1";
const CAPTURED = "2026-05-23T10:00:00";
const proof = {
  contextId: "ctx", stepId: "step", executionAttemptId: "attempt",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const runFrame = () =>
  ({ runId: "run", orgId: "org", userId: "person", verifiedStepId: "step", verifiedExecutedSource: proof }) as unknown as McpRequestContext;
const offRunFrame = () => ({ orgId: "org", userId: "person" }) as unknown as McpRequestContext;
const actor: InvokerTrustedActor = {
  actor: { principalType: "HumanUser", principalId: "person", organizationId: "org" } as never,
  userId: "person",
  orgId: "org",
};
const READ = { readOnlyHint: true, destructiveHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false };

function fixture(modifiedGmt: string = CAPTURED) {
  const tool = (name: string, rawAnnotations: Record<string, unknown>) =>
    ({ name, serverId: CATALOG_DEFAULT_SERVER_ID, inputSchema: {}, rawAnnotations });
  const snapshot: CatalogServerSnapshot = {
    serverId: CATALOG_DEFAULT_SERVER_ID,
    exposureMode: "triad-only",
    tools: [tool("ewpa/get-post", READ), tool("ewpa/get-page", READ), tool("ewpa/create-post", WRITE), tool("email_send", WRITE)],
    catalogRevision: "rev",
    fetchedAtMs: 0,
  };
  const cache = createInMemoryConnectorInstanceCatalogCache();
  cache.set(INSTANCE, snapshot);
  const wire = vi.fn(async () => ({ success: true, data: { post_modified_gmt: modifiedGmt, post_content: "body" } }));
  const deps: ConnectorInstanceInvokerDeps = {
    requireUse: async () => {},
    ensureDefaultOpenPolicy: async () => ({ created: false }),
    resolveInstanceEndpoint: async () => ({ endpoint: "https://site.invalid/mcp", authHeader: "Basic native-test" }),
    cache,
    loadServerSnapshot: async () => snapshot,
    callWireTool: wire,
    readPolicy: async () => ({ connectorKey: "wordpress", instanceId: INSTANCE, mode: "open", updatedBy: "person", updatedAt: new Date(0).toISOString() }),
    audit: async () => {},
  } as ConnectorInstanceInvokerDeps;
  h.deps = deps;
  return { wire, deps };
}

function check(postType?: "page") {
  return wordpressFreshnessAdapter.check({
    objectId: "obj_1",
    orgId: "org",
    remoteRevisionRef: {
      connector: "wordpress",
      kind: "wordpress-post",
      remoteId: "42",
      modifiedAt: CAPTURED,
      extra: postType ? { instanceId: INSTANCE, postType } : { instanceId: INSTANCE },
    } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"],
  });
}
const invoke = (toolName: string, deps: ConnectorInstanceInvokerDeps) =>
  invokeConnectorInstanceTool(
    { connectorKey: "wordpress", instanceId: INSTANCE, toolName, args: { post_id: 42 }, actor,
      primitiveName: "wordpress_freshness_check", sourceType: "freshness_sweep", causation: "obj_1" },
    deps,
  );
const mint = <T>(effect: (toolName: string) => Promise<T>, kind: "post" | "page" = "post", instanceId = INSTANCE) =>
  hostContext.withWordPressFreshnessReadOwner({ instanceId, kind }, effect);
// What any code in the same process can do with the guard's globally registered
// current-owner map: install an owner object for a run frame.
function runAsOwner<T>(owner: object, effect: () => Promise<T>): Promise<T> {
  const frame = runFrame();
  const owners = (globalThis as unknown as Record<symbol, WeakMap<object, unknown>>)[
    Symbol.for("@cinatra-ai/host:guarded-action-owner/v1")];
  owners.set(frame, owner);
  return mcpRequestContextStorage.run(frame, effect).finally(() => owners.delete(frame));
}
// A leaf-shaped unpinned owner with no hostRead, and a forged read naming a write.
const leafFields = () => ({ unpinned: true, toolName: "wordpress_freshness_check", wrapper: "instance_tool",
  connectorKey: "wordpress", instanceId: INSTANCE });
const forgedWriteRead = () => Object.freeze({ connectorKey: "wordpress", instanceId: INSTANCE,
  toolName: "ewpa/create-post", toolNames: Object.freeze(["ewpa/create-post"]) });
const CREATE_CALL = { connectorKey: "wordpress", instanceId: INSTANCE, toolName: "ewpa/create-post" } as const;
const OWNERLESS = { code: "tool_error", message: "executed connector owner is unavailable" };

beforeEach(() => {
  vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#4315 item 1: the fail-closed state without the host-derived owner", () => {
  it("reads unknown with the refusal reason and makes no wire call", async () => {
    // Remove the host-derived owner: the read runs in the bare run frame.
    if (typeof (hostContext as Record<string, unknown>).withWordPressFreshnessReadOwner === "function") {
      vi.spyOn(hostContext, "withWordPressFreshnessReadOwner").mockImplementation(
        ((_read: unknown, effect: (toolName: string) => Promise<unknown>) => effect("ewpa/get-post")) as typeof hostContext.withWordPressFreshnessReadOwner,
      );
    }
    const { wire } = fixture();
    const verdict = await mcpRequestContextStorage.run(runFrame(), () => check());
    expect(verdict.state).toBe("unknown");
    expect(verdict.state).not.toBe("fresh");
    expect(verdict.state).not.toBe("missing");
    if (verdict.state === "unknown") expect(verdict.reason).toBe("wordpress ability error: executed connector owner is unavailable");
    expect(wire).toHaveBeenCalledTimes(0);
  });
});

describe("cinatra#4315 item 2: off a run nothing changes", () => {
  it.each([
    ["fresh", CAPTURED],
    ["changed", "2026-06-01T08:00:00"],
  ] as const)("serves one wire call and reads %s from the stub payload", async (state, modified) => {
    const { wire } = fixture(modified);
    const verdict = await mcpRequestContextStorage.run(offRunFrame(), () => check());
    expect(verdict.state).toBe(state);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(expect.objectContaining({ arguments: { ability_name: "ewpa/get-post", parameters: { post_id: 42 } } }));
  });
});

describe("cinatra#4315 item 3: the read is served on a run under the host-derived owner", () => {
  it.each([
    ["fresh", CAPTURED],
    ["changed", "2026-06-01T08:00:00"],
  ] as const)("serves one wire call and reads %s", async (state, modified) => {
    const { wire } = fixture(modified);
    const verdict = await mcpRequestContextStorage.run(runFrame(), () => check());
    expect(verdict.state).toBe(state);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(expect.objectContaining({ arguments: { ability_name: "ewpa/get-post", parameters: { post_id: 42 } } }));
  });
});

describe("cinatra#4315 item 3: a page is read with ewpa/get-page on a run", () => {
  it("serves one ewpa/get-page wire call and reads fresh", async () => {
    const { wire } = fixture();
    const verdict = await mcpRequestContextStorage.run(runFrame(), () => check("page"));
    expect(verdict.state).toBe("fresh");
    expect(wire).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledWith(expect.objectContaining({ arguments: { ability_name: "ewpa/get-page", parameters: { post_id: 42 } } }));
  });
});

describe("cinatra#4315 item 4: the owner is host-derived", () => {
  it("caller-supplied sourceType and primitiveName on a run with no guarded owner refuse before any wire call", async () => {
    const { wire, deps } = fixture();
    const call = mcpRequestContextStorage.run(runFrame(), () => invoke("ewpa/get-post", deps));
    await expect(call).rejects.toBeInstanceOf(InvokerError);
    await expect(call).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("an owner-shaped object the host did not mint serves nothing", () => {
    const forged = { unpinned: true, toolName: "wordpress_freshness_check", wrapper: "instance_tool",
      hostRead: { connectorKey: "wordpress", instanceId: INSTANCE, toolNames: ["ewpa/get-post"] } } as const;
    expect(hostContext.guardedOwnerServesInstanceCall(forged as never,
      { connectorKey: "wordpress", instanceId: INSTANCE, toolName: "ewpa/get-post" })).toBe(false);
  });

  it("off a run the host read owner sets no owner", async () => {
    const seen = await mcpRequestContextStorage.run(offRunFrame(), () =>
      mint(async () => hostContext.currentGuardedActionOwner()));
    expect(seen).toBeUndefined();
  });

  it("an owner added to a globally reachable set serves nothing", async () => {
    const { wire, deps } = fixture();
    // The first commit of this change kept its mint proof under this registered
    // symbol; any code in the process could add to it. The proof is now module-private.
    const holder = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
    const key = Symbol.for("@cinatra-ai/host:host-read-action-owners/v1");
    const set = (holder[key] ??= new WeakSet<object>());
    const forged = Object.freeze({ ...leafFields(), hostRead: forgedWriteRead() });
    set.add(forged);
    expect(hostContext.guardedOwnerServesInstanceCall(forged as never, CREATE_CALL)).toBe(false);
    await expect(runAsOwner(forged, () => invoke("ewpa/create-post", deps))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("an owner with an inherited hostRead serves nothing", async () => {
    const { wire, deps } = fixture();
    const inherited = Object.assign(Object.create({ hostRead: forgedWriteRead() }) as object, leafFields());
    expect(hostContext.guardedOwnerServesInstanceCall(inherited as never, CREATE_CALL)).toBe(false);
    await expect(runAsOwner(inherited, () => invoke("ewpa/create-post", deps))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["hides hostRead from has and getOwnPropertyDescriptor but answers get", false],
    ["hides hostRead from getOwnPropertyDescriptor but answers has", true],
  ] as const)("a Proxy owner that %s serves nothing", async (_label, answersHas) => {
    const { wire, deps } = fixture();
    const read = forgedWriteRead();
    const proxy = new Proxy(leafFields(), {
      has: (t, p) => (p === "hostRead" ? answersHas : Reflect.has(t, p)),
      get: (t, p, r) => (p === "hostRead" ? read : Reflect.get(t, p, r)),
      getOwnPropertyDescriptor: (t, p) => (p === "hostRead" ? undefined : Reflect.getOwnPropertyDescriptor(t, p)),
    });
    expect(hostContext.guardedOwnerServesInstanceCall(proxy as never, CREATE_CALL)).toBe(false);
    await expect(runAsOwner(proxy, () => invoke("ewpa/create-post", deps))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("a Proxy owner whose trap throws on hostRead serves nothing", () => {
    const proxy = new Proxy(leafFields(), {
      has: (t, p) => { if (p === "hostRead") throw new Error("trap"); return Reflect.has(t, p); },
    });
    expect(hostContext.guardedOwnerServesInstanceCall(proxy as never, CREATE_CALL)).toBe(false);
  });

  it("a leaf owner with no hostRead still serves the call, as before (the guard then reads it)", async () => {
    const { wire, deps } = fixture();
    const leaf = Object.freeze(leafFields());
    expect(hostContext.guardedOwnerServesInstanceCall(leaf as never,
      { connectorKey: "wordpress", instanceId: INSTANCE, toolName: "ewpa/get-post" })).toBe(true);
    await expect(runAsOwner(leaf, () => invoke("ewpa/get-post", deps))).resolves.toBeDefined();
    expect(wire).toHaveBeenCalledTimes(1);
  });
});

describe("cinatra#4315 item 5: writes still refuse", () => {
  it("a core-code write ability on a run with no guarded owner refuses before any wire call", async () => {
    const { wire, deps } = fixture();
    await expect(mcpRequestContextStorage.run(runFrame(), () => invoke("ewpa/create-post", deps))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("the host read owner for ewpa/get-post does not serve ewpa/create-post", async () => {
    const { wire, deps } = fixture();
    await expect(mcpRequestContextStorage.run(runFrame(), () =>
      mint(() => invoke("ewpa/create-post", deps)))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("no exported minter mints an owner that serves a write ability", async () => {
    const { wire, deps } = fixture();
    // At the first commit of this change the minter took free connector and
    // ability names, so toolNames ["ewpa/create-post"] served the write. The
    // minter now takes only a post type from a closed list.
    const freeNames = (hostContext as Record<string, unknown>).withHostConnectorReadOwner as
      undefined | ((read: unknown, effect: () => Promise<unknown>) => Promise<unknown>);
    const call = mcpRequestContextStorage.run(runFrame(), () => freeNames
      ? freeNames({ primitiveName: "wordpress_freshness_check", connectorKey: "wordpress", instanceId: INSTANCE,
        toolNames: ["ewpa/create-post"] }, () => invoke("ewpa/create-post", deps))
      : hostContext.withWordPressFreshnessReadOwner({ instanceId: INSTANCE, kind: "create-post" as never },
        (toolName) => invoke(toolName, deps)));
    await expect(call).rejects.toBeInstanceOf(hostContext.OutwardActionRefusal);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["create-post"], ["ewpa/create-post"], ["delete-post"], [""], ["__proto__"], ["toString"], [undefined],
  ] as const)("the minter refuses kind %j before the effect, on and off a run", async (kind) => {
    const effect = vi.fn(async () => "served");
    for (const frame of [runFrame(), offRunFrame()]) {
      const call = mcpRequestContextStorage.run(frame, () =>
        hostContext.withWordPressFreshnessReadOwner({ instanceId: INSTANCE, kind: kind as never }, effect));
      await expect(call).rejects.toBeInstanceOf(hostContext.OutwardActionRefusal);
      await expect(call).rejects.toThrow("action_host_read_not_allowed");
    }
    expect(effect).toHaveBeenCalledTimes(0);
  });

  it("the minter refuses an empty instance before the effect", async () => {
    const effect = vi.fn(async () => "served");
    await expect(mcpRequestContextStorage.run(runFrame(), () =>
      hostContext.withWordPressFreshnessReadOwner({ instanceId: "", kind: "post" }, effect))).rejects.toThrow("action_host_read_not_allowed");
    expect(effect).toHaveBeenCalledTimes(0);
  });

  it("the minted owner serves only the wordpress connector, its instance and its one read ability", async () => {
    const served = await mcpRequestContextStorage.run(runFrame(), () => mint(async (toolName) => {
      const owner = hostContext.currentGuardedActionOwner()!;
      const serves = (connectorKey: string, instanceId: string, name: string) =>
        hostContext.guardedOwnerServesInstanceCall(owner, { connectorKey, instanceId, toolName: name });
      return {
        toolName,
        own: serves("wordpress", INSTANCE, "ewpa/get-post"),
        page: serves("wordpress", INSTANCE, "ewpa/get-page"),
        write: serves("wordpress", INSTANCE, "ewpa/create-post"),
        connector: serves("drupal", INSTANCE, "ewpa/get-post"),
        instance: serves("wordpress", "wp_instance_2", "ewpa/get-post"),
      };
    }));
    expect(served).toEqual({ toolName: "ewpa/get-post", own: true, page: false, write: false, connector: false, instance: false });
  });

  it("the host read owner for one instance does not serve another instance", async () => {
    const { wire, deps } = fixture();
    await expect(mcpRequestContextStorage.run(runFrame(), () =>
      mint(() => invoke("ewpa/get-post", deps), "post", "wp_instance_2"))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("the owner ends with the read, also when the read rejects", async () => {
    const after = await mcpRequestContextStorage.run(runFrame(), async () => {
      await mint(async () => { throw new Error("read failed"); }).catch(() => undefined);
      return hostContext.currentGuardedActionOwner();
    });
    expect(after).toBeUndefined();
  });
});

describe("cinatra#4315 item 6: outward still refuses under the new owner", () => {
  it("a name in OUTWARD_EFFECT_TOOL_NAMES is not served under the host read owner and makes no wire call", async () => {
    expect(OUTWARD_EFFECT_TOOL_NAMES.has("email_send")).toBe(true);
    const { wire, deps } = fixture();
    await expect(mcpRequestContextStorage.run(runFrame(), () =>
      mint(() => invoke("email_send", deps)))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("the guard refuses an outward name under the host read owner with OutwardActionRefusal", async () => {
    const effect = vi.fn(async () => "served");
    const call = mcpRequestContextStorage.run(runFrame(), () => mint(() =>
      hostContext.withGuardedRunActionInvocation({ action: { ...hostContext.currentGuardedActionOwner()!, toolName: "email_send" },
        arguments: {} }, effect)));
    await expect(call).rejects.toBeInstanceOf(hostContext.OutwardActionRefusal);
    await expect(call).rejects.toThrow("action_loaded_identity_missing_or_stale");
    expect(effect).toHaveBeenCalledTimes(0);
  });

  it("a frame marked as declared outward refuses with OutwardActionRefusal before any wire call", async () => {
    const { wire, deps } = fixture();
    const call = mcpRequestContextStorage.run(markDeclaredOutwardRunFrame(runFrame()), () =>
      mint(() => invoke("ewpa/get-post", deps)));
    await expect(call).rejects.toBeInstanceOf(hostContext.OutwardActionRefusal);
    await expect(call).rejects.toThrow("action_loaded_identity_missing_or_stale");
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("the adapter in a declared-outward frame reads unknown with no wire call", async () => {
    const { wire } = fixture();
    const verdict = await mcpRequestContextStorage.run(markDeclaredOutwardRunFrame(runFrame()), () => check());
    expect(verdict.state).toBe("unknown");
    expect(wire).toHaveBeenCalledTimes(0);
  });
});

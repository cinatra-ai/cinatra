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
 * refuses under the new owner.
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

function check() {
  return wordpressFreshnessAdapter.check({
    objectId: "obj_1",
    orgId: "org",
    remoteRevisionRef: {
      connector: "wordpress",
      kind: "wordpress-post",
      remoteId: "42",
      modifiedAt: CAPTURED,
      extra: { instanceId: INSTANCE },
    } as unknown as Parameters<typeof wordpressFreshnessAdapter.check>[0]["remoteRevisionRef"],
  });
}
const invoke = (toolName: string, deps: ConnectorInstanceInvokerDeps) =>
  invokeConnectorInstanceTool(
    { connectorKey: "wordpress", instanceId: INSTANCE, toolName, args: { post_id: 42 }, actor,
      primitiveName: "wordpress_freshness_check", sourceType: "freshness_sweep", causation: "obj_1" },
    deps,
  );
const hostRead = (toolNames: string[], instanceId = INSTANCE) =>
  ({ primitiveName: "wordpress_freshness_check", connectorKey: "wordpress", instanceId, toolNames });
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
    if (typeof (hostContext as Record<string, unknown>).withHostConnectorReadOwner === "function") {
      vi.spyOn(hostContext, "withHostConnectorReadOwner").mockImplementation(
        ((_read: unknown, effect: () => Promise<unknown>) => effect()) as typeof hostContext.withHostConnectorReadOwner,
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
      hostContext.withHostConnectorReadOwner(hostRead(["ewpa/get-post"]), async () => hostContext.currentGuardedActionOwner()));
    expect(seen).toBeUndefined();
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
      hostContext.withHostConnectorReadOwner(hostRead(["ewpa/get-post"]), () => invoke("ewpa/create-post", deps)))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("the host read owner for another connector does not serve the WordPress call", async () => {
    const { wire, deps } = fixture();
    await expect(mcpRequestContextStorage.run(runFrame(), () =>
      hostContext.withHostConnectorReadOwner({ ...hostRead(["ewpa/get-post"]), connectorKey: "drupal" }, () => invoke("ewpa/get-post", deps)))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("the host read owner for one instance does not serve another instance", async () => {
    const { wire, deps } = fixture();
    await expect(mcpRequestContextStorage.run(runFrame(), () =>
      hostContext.withHostConnectorReadOwner(hostRead(["ewpa/get-post"], "wp_instance_2"), () => invoke("ewpa/get-post", deps)))).rejects.toMatchObject(OWNERLESS);
    expect(wire).toHaveBeenCalledTimes(0);
  });
});

describe("cinatra#4315 item 6: outward still refuses under the new owner", () => {
  it("a name in OUTWARD_EFFECT_TOOL_NAMES refuses with OutwardActionRefusal before any wire call", async () => {
    expect(OUTWARD_EFFECT_TOOL_NAMES.has("email_send")).toBe(true);
    const { wire, deps } = fixture();
    const call = mcpRequestContextStorage.run(runFrame(), () =>
      hostContext.withHostConnectorReadOwner(hostRead(["email_send"]), () => invoke("email_send", deps)));
    await expect(call).rejects.toBeInstanceOf(hostContext.OutwardActionRefusal);
    await expect(call).rejects.toThrow("action_loaded_identity_missing_or_stale");
    expect(wire).toHaveBeenCalledTimes(0);
  });

  it("a frame marked as declared outward refuses with OutwardActionRefusal before any wire call", async () => {
    const { wire, deps } = fixture();
    const call = mcpRequestContextStorage.run(markDeclaredOutwardRunFrame(runFrame()), () =>
      hostContext.withHostConnectorReadOwner(hostRead(["ewpa/get-post"]), () => invoke("ewpa/get-post", deps)));
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

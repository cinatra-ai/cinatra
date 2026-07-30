import { describe, expect, it, vi } from "vitest";
import {
  invokeConnectorInstanceTool,
  type ConnectorInstanceInvokerDeps,
  type InvokerTrustedActor,
} from "@/lib/connector-instance-invoker";
import {
  InvokerError,
  PENDING_CONFIRMATION_MESSAGE_PREFIX,
} from "@/lib/connector-instance-mcp-transport";
import { buildPendingConfirmationMessage } from "@/lib/connector-instance-destructive-hook";
import {
  CATALOG_DEFAULT_SERVER_ID,
  createInMemoryConnectorInstanceCatalogCache,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import type { InstanceToolPolicyRecord } from "@cinatra-ai/mcp-server/instance-tool-policy";

// cinatra#2017 S2 slice K6 — the governed invoker core (design §1.2 order, M4
// single pass, B1 pin, §3 triad/routing). Fully mocked deps — no live stack.

// Real-signature spy type for the step-3 hook so `mock.calls` rows are
// indexable, typed tuples.
type DestructiveHookFire = NonNullable<ConnectorInstanceInvokerDeps["destructiveHook"]>["fire"];
// Real-signature spy type for the step-3b content-review hook (cinatra#2022
// S7 PR-σ) — same reasoning as DestructiveHookFire above.
type ContentReviewHookFire = NonNullable<ConnectorInstanceInvokerDeps["contentReviewHook"]>["fire"];

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

// cinatra#2022 S7 PR-δ — pre-merge tests for the chat-widening PR: chat gains
// reach to the generic WordPress site-tool primitives, so this block proves
// the per-instance tool-policy floor's new deny-by-default posture holds.
// Confirmation-hook firing on `chat` and the annotation-floor mechanics are
// ALREADY proven generically above (the "destructive hook" describe block,
// e.g. the FLOOR-trigger and `sourceType: "chat"` park-material tests) and in
// connector-instance-destructive-hook.test.ts's full surface × policy-state
// matrix — unchanged by δ. This block proves the NEW property δ adds: the
// per-instance tool-policy floor now denies by default (restricted+empty)
// regardless of which surface reaches it, closing the gap even when the
// destructive hook itself would not have fired.
describe("invokeConnectorInstanceTool — δ chat-widening policy floor (cinatra#2022 S7)", () => {
  // An existing pre-δ instance with no explicit policy record
  // produces ZERO mutation access from ANY surface until the site owner adds
  // an explicit allow entry. The per-instance policy step is surface-
  // independent by construction (§2.6/§10-A3) — proven here across the surface
  // vocabulary the destructive hook itself recognizes (chat/agent_run/
  // public_site_widget/session), standing in for chat/in-admin/blog-publish/
  // freshness respectively.
  it("absent policy record denies every surface alike (chat, agent_run, public_site_widget, session)", async () => {
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => null);
    for (const sourceType of ["chat", "agent_run", "public_site_widget", "session"] as const) {
      const { deps, callWireTool } = makeDeps({ readPolicy });
      await expect(
        invokeConnectorInstanceTool(
          { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR, sourceType },
          deps,
        ),
      ).rejects.toMatchObject({ code: "tool_policy_denied" });
      expect(callWireTool).not.toHaveBeenCalled();
    }
  });

  // A newly-created post-δ instance gets the identical restricted-
  // empty default via the ORDINARY fallback path — no special-case creation
  // branch. At the invoker level this means: whether readPolicy returns null
  // (never touched) or an explicit restricted+empty row (already
  // first-touch-backstopped), the verdict is the same deny.
  it("an explicit restricted+empty row (the first-touch-backstopped shape) denies identically to an absent record", async () => {
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      updatedBy: "system:connector-instance-policy-first-touch",
      updatedAt: "2026-07-30T00:00:00Z",
    }));
    const { deps, callWireTool } = makeDeps({ readPolicy });
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR, sourceType: "chat" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_policy_denied" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  // Deny precedence in the policy store wins over any conflicting allow.
  it("deny precedence: an ability in BOTH allow and deny is denied", async () => {
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: CATALOG_DEFAULT_SERVER_ID, name: "ewpa/create-post" }],
      deny: [{ serverId: CATALOG_DEFAULT_SERVER_ID, name: "ewpa/create-post" }],
      updatedBy: "admin",
      updatedAt: "2026-07-30T00:00:00Z",
    }));
    const { deps, callWireTool } = makeDeps({ readPolicy });
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR, sourceType: "chat" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_policy_denied" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  // An Administrator-scoped instance's dangerous tool stays blocked until
  // explicitly allowed. `ewpa/create-code-snippet` can run arbitrary PHP if
  // the connection is Administrator-scoped; the per-instance policy floor
  // denies it by default regardless of what the connected WordPress user's
  // OWN role permits.
  it("an Administrator-scoped dangerous ability (ewpa/create-code-snippet) stays blocked absent an explicit allow", async () => {
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => null);
    const { deps, callWireTool } = makeDeps({ readPolicy });
    deps.cache.set(
      "inst-1",
      triadSnapshot([{ name: "ewpa/create-code-snippet", rawAnnotations: {} }]),
    );
    await expect(
      invokeConnectorInstanceTool(
        {
          connectorKey: "wordpress",
          toolName: "ewpa/create-code-snippet",
          args: {},
          actor: ACTOR,
          sourceType: "chat",
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_policy_denied" });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  // A misclassified/unknown-annotation tool cannot silently bypass the
  // confirmation path. Even a tool whose annotations carry NO destructive/
  // write hints (so the step-3 destructive hook would never fire for it) is
  // still caught by the step-2 policy floor's deny-by-default — defense in
  // depth, independent of annotation classification.
  it("a tool with empty/unclassified annotations is still denied by the policy floor (defense in depth vs. the hook)", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const readPolicy = vi.fn(async (): Promise<InstanceToolPolicyRecord | null> => null);
    const { deps, callWireTool } = makeDeps({ readPolicy, destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "totally-unclassified-tool", rawAnnotations: {} }]));
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "totally-unclassified-tool", args: {}, actor: ACTOR, sourceType: "chat" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_policy_denied" });
    // Denied at step 2 — step 3's hook never even runs.
    expect(fire).not.toHaveBeenCalled();
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

describe("invokeConnectorInstanceTool — serverId is NOT caller-mintable (cache-miss forged-serverId guard)", () => {
  it("on a cache MISS, a forged serverId cannot mint the default catalog under that id → tool_not_found (no policy bypass)", async () => {
    const { deps, callWireTool } = makeDeps();
    deps.cache.invalidate("inst-1"); // force a miss so loadServerSnapshot runs
    // loadServerSnapshot ALWAYS tags the snapshot with CATALOG_DEFAULT_SERVER_ID
    // (the host-owned id), never the caller's serverId. So a call with a forged
    // serverId filters to nothing → tool_not_found, never a mis-tagged catalog.
    await expect(
      invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, serverId: "attacker-picked", actor: ACTOR },
        deps,
      ),
    ).rejects.toMatchObject({ code: "tool_not_found" });
    expect(callWireTool).not.toHaveBeenCalled();
    // The minted snapshot carries the host-owned id, not the forged one.
    expect(deps.cache.get("inst-1", CATALOG_DEFAULT_SERVER_ID)).toBeDefined();
    expect(deps.cache.get("inst-1", "attacker-picked")).toBeUndefined();
  });
});

describe("invokeConnectorInstanceTool — destructive hook (step 3, cinatra#2020 S5 blocking)", () => {
  it("fires the hook when enabled AND the resolved tool classifies destructive; a VOID verdict (S2-era impls/mocks) executes", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const { deps, callWireTool } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).toHaveBeenCalledTimes(1);
    expect(callWireTool).toHaveBeenCalledTimes(1); // void = continue (back-compat)
  });

  it("does NOT fire for a read-classified tool", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const { deps } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "safe", rawAnnotations: { readOnlyHint: true } }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "safe", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).not.toHaveBeenCalled();
  });

  it("BLOCKS on a park verdict: typed pending_confirmation, verdict-message passthrough (§2.1 contract), NO wire call, NO step-5 audit", async () => {
    const message = buildPendingConfirmationMessage({
      toolName: "danger",
      serverId: CATALOG_DEFAULT_SERVER_ID,
      pendingCallId: "cipc_x1",
    });
    const fire = vi.fn<DestructiveHookFire>(async () => ({
      action: "park" as const,
      pendingCallId: "cipc_x1",
      expiresAt: "2026-07-28T10:15:00.000Z",
      message,
    }));
    const { deps, callWireTool, audit } = makeDeps({
      destructiveHook: { enabled: () => true, fire },
    });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: { id: 1 }, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("pending_confirmation");
    // The M1 path renders error.message as the model-facing tool result: the
    // STABLE prefix + the no-retry directive must survive the passthrough.
    expect((err as InvokerError).message).toBe(message);
    expect((err as InvokerError).message.startsWith(PENDING_CONFIRMATION_MESSAGE_PREFIX)).toBe(true);
    expect((err as InvokerError).message).toContain("Do NOT retry or re-issue this call");
    expect(callWireTool).not.toHaveBeenCalled();
    // The park path writes its own audit row inside the hook impl — the
    // invoker's step-5 execution audit must NOT record a parked call.
    expect(audit).not.toHaveBeenCalled();
  });

  it("a continue verdict (surface default off / org-disabled) executes normally", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => ({ action: "continue" as const, reason: "surface_default_off" as const }));
    const { deps, callWireTool, audit } = makeDeps({
      destructiveHook: { enabled: () => true, fire },
    });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    const result = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR },
      deps,
    );
    expect(result).toEqual({ success: true, data: { ok: 1 } });
    expect(callWireTool).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1); // ordinary step-5 success audit
  });

  it("FLOOR trigger (D9): a known-destructive NAME with EMPTY annotations (write-class) still fires — floorHit true, derivedClass write", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => ({
      action: "park" as const,
      pendingCallId: "cipc_f1",
      expiresAt: "2026-07-28T10:15:00.000Z",
      message: `${PENDING_CONFIRMATION_MESSAGE_PREFIX} parked`,
    }));
    const { deps, callWireTool } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "ewpa/delete-user", rawAnnotations: {} }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "ewpa/delete-user", args: {}, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect((err as InvokerError).code).toBe("pending_confirmation");
    expect(fire.mock.calls[0][0]).toMatchObject({ derivedClass: "write", floorHit: true });
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("annotation-destructive NON-floor name fires with floorHit false", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const { deps } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire.mock.calls[0][0]).toMatchObject({ derivedClass: "destructive", floorHit: false });
  });

  it("write-class NON-floor name: no fire, executes (the S2 write path is untouched)", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const { deps, callWireTool } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).not.toHaveBeenCalled();
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("enabled() false → never fires, executes (the S2 kill-switch semantics)", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const { deps, callWireTool } = makeDeps({ destructiveHook: { enabled: () => false, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "core/delete-post", rawAnnotations: { destructiveHint: true } }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "core/delete-post", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).not.toHaveBeenCalled();
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("fire input carries the full widened park material (§2.3): args, class flags, surface, endpoint, tool-shape, correlation", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {});
    const { deps } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: "danger",
        args: { id: 3 },
        actor: ACTOR,
        sourceType: "chat",
        causation: "run-1",
        intent: "cleanup",
      },
      deps,
    );
    expect(fire.mock.calls[0][0]).toMatchObject({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      serverId: CATALOG_DEFAULT_SERVER_ID,
      toolName: "danger",
      args: { id: 3 },
      derivedClass: "destructive",
      floorHit: false,
      sourceType: "chat",
      endpointUrl: "https://site/x", // URL string only — never the auth header
      inputSchema: {},
      rawAnnotations: { destructiveHint: true },
      intent: "cleanup",
      primitiveName: "connector_instance_tool_call",
      catalogRevision: "rev-1",
      causation: "run-1",
    });
    const serialized = JSON.stringify(fire.mock.calls[0][0]);
    expect(serialized).not.toContain("Basic zzz"); // the resolved auth header must not leak into the hook input
  });

  it("a typed refusal thrown inside fire (confirmation_unavailable) propagates fail-closed — no wire call", async () => {
    const fire = vi.fn<DestructiveHookFire>(async () => {
      throw new InvokerError("confirmation_unavailable", "subsystem unavailable — the call was NOT executed");
    });
    const { deps, callWireTool } = makeDeps({ destructiveHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect((err as InvokerError).code).toBe("confirmation_unavailable");
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("invokeConnectorInstanceTool — content-review hook (step 3b, cinatra#2022 S7 PR-σ slot)", () => {
  it("fires the hook when enabled AND the resolved tool is non-read (write-classified); an explicit continue verdict executes", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const }));
    const { deps, callWireTool } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).toHaveBeenCalledTimes(1);
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for a read-classified tool", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const }));
    const { deps } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "safe", rawAnnotations: { readOnlyHint: true } }]));
    await invokeConnectorInstanceTool({ connectorKey: "wordpress", toolName: "safe", args: {}, actor: ACTOR }, deps);
    expect(fire).not.toHaveBeenCalled();
  });

  it("absent hook (deps.contentReviewHook undefined) — never called, executes (identical to today)", async () => {
    const { deps, callWireTool } = makeDeps();
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    );
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("enabled() false → never fires, executes (the S2/S5 kill-switch semantics mirrored)", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const }));
    const { deps, callWireTool } = makeDeps({ contentReviewHook: { enabled: () => false, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    );
    expect(fire).not.toHaveBeenCalled();
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("a synchronously-throwing enabled() propagates uncaught, BEFORE any wire call (same latent posture step 3's destructive hook already has)", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const }));
    const enabled = () => {
      throw new Error("enabled() blew up");
    };
    const { deps, callWireTool } = makeDeps({ contentReviewHook: { enabled, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("enabled() blew up");
    expect(fire).not.toHaveBeenCalled();
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("an unrecognized verdict `action` at runtime (outside the TS contract) executes — SAME posture as step 3's `action === \"park\"`-only check", async () => {
    // A misbehaving hook impl (a JS caller unchecked by the TS contract) resolving
    // an unknown action shape. TypeScript's contract, not a runtime tag switch, is
    // the real guard on both hooks (documented explicitly on the deps-literal).
    const fire = vi.fn<ContentReviewHookFire>(
      async () => ({ action: "unknown-verdict" }) as unknown as Awaited<ReturnType<ContentReviewHookFire>>,
    );
    const { deps, callWireTool } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    const result = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    );
    expect(result).toEqual({ success: true, data: { ok: 1 } });
    expect(callWireTool).toHaveBeenCalledTimes(1);
  });

  it("BLOCKS on a hold verdict: typed content_review_hold, verdict-message passthrough, holdId threaded onto the error, NO wire call, NO step-5 audit", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({
      action: "hold" as const,
      holdId: "crh_x1",
      message: "held pending content review",
    }));
    const { deps, callWireTool, audit } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: { id: 1 }, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvokerError);
    expect((err as InvokerError).code).toBe("content_review_hold");
    expect((err as InvokerError).message).toBe("held pending content review");
    expect((err as InvokerError).reviewHoldId).toBe("crh_x1");
    expect(callWireTool).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("BLOCKS on a reject verdict: typed content_review_rejected, NO wire call", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({
      action: "reject" as const,
      message: "rejected — needs rework",
    }));
    const { deps, callWireTool } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect((err as InvokerError).code).toBe("content_review_rejected");
    expect((err as InvokerError).message).toBe("rejected — needs rework");
    expect((err as InvokerError).reviewHoldId).toBeUndefined();
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("a continue verdict executes normally and the ordinary step-5 audit still fires", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const, reason: "not_content_classified" }));
    const { deps, callWireTool, audit } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    const result = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    );
    expect(result).toEqual({ success: true, data: { ok: 1 } });
    expect(callWireTool).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("ORDERING: a destructive PARK short-circuits before step 3b — the content-review hook never fires", async () => {
    const destructiveFire = vi.fn<DestructiveHookFire>(async () => ({
      action: "park" as const,
      pendingCallId: "cipc_z1",
      expiresAt: "2026-07-28T10:15:00.000Z",
      message: `${PENDING_CONFIRMATION_MESSAGE_PREFIX} parked`,
    }));
    const reviewFire = vi.fn<ContentReviewHookFire>(async () => ({ action: "hold" as const, holdId: "crh_z1", message: "held" }));
    const { deps, callWireTool } = makeDeps({
      destructiveHook: { enabled: () => true, fire: destructiveFire },
      contentReviewHook: { enabled: () => true, fire: reviewFire },
    });
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect((err as InvokerError).code).toBe("pending_confirmation");
    expect(destructiveFire).toHaveBeenCalledTimes(1);
    expect(reviewFire).not.toHaveBeenCalled(); // step 3b never reached
    expect(callWireTool).not.toHaveBeenCalled();
  });

  it("ORDERING: a destructive CONTINUE lets step 3b still evaluate — both hooks fire in order for an overlapping call", async () => {
    const destructiveFire = vi.fn<DestructiveHookFire>(async () => ({ action: "continue" as const, reason: "org_disabled" }));
    const reviewFire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const }));
    const { deps, callWireTool } = makeDeps({
      destructiveHook: { enabled: () => true, fire: destructiveFire },
      contentReviewHook: { enabled: () => true, fire: reviewFire },
    });
    // "danger" is destructive-annotated (non-read) so BOTH triggers match.
    deps.cache.set("inst-1", triadSnapshot([{ name: "danger", rawAnnotations: { destructiveHint: true } }]));
    await invokeConnectorInstanceTool({ connectorKey: "wordpress", toolName: "danger", args: {}, actor: ACTOR }, deps);
    expect(destructiveFire).toHaveBeenCalledTimes(1);
    expect(reviewFire).toHaveBeenCalledTimes(1);
    expect(callWireTool).toHaveBeenCalledTimes(1);
    // step 3 ran strictly before step 3b (call-order proof, not just call counts).
    const destructiveOrder = destructiveFire.mock.invocationCallOrder[0];
    const reviewOrder = reviewFire.mock.invocationCallOrder[0];
    expect(destructiveOrder).toBeLessThan(reviewOrder);
  });

  it("fire input carries the full call material: args, class, surface, endpoint (no auth header), tool-shape, correlation", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => ({ action: "continue" as const }));
    const { deps } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing", rawAnnotations: { foo: "bar" } }]));
    await invokeConnectorInstanceTool(
      {
        connectorKey: "wordpress",
        toolName: "content/update-thing",
        args: { id: 3 },
        actor: ACTOR,
        sourceType: "agent_run",
        causation: "run-1",
        intent: "publish",
      },
      deps,
    );
    expect(fire.mock.calls[0][0]).toMatchObject({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      serverId: CATALOG_DEFAULT_SERVER_ID,
      toolName: "content/update-thing",
      args: { id: 3 },
      derivedClass: "write",
      sourceType: "agent_run",
      endpointUrl: "https://site/x",
      inputSchema: {},
      rawAnnotations: { foo: "bar" },
      intent: "publish",
      primitiveName: "connector_instance_tool_call",
      catalogRevision: "rev-1",
      causation: "run-1",
    });
    const serialized = JSON.stringify(fire.mock.calls[0][0]);
    expect(serialized).not.toContain("Basic zzz"); // the resolved auth header must never leak into the hook input
  });

  it("a typed refusal thrown inside fire (content_review_unavailable) propagates fail-closed — no wire call", async () => {
    const fire = vi.fn<ContentReviewHookFire>(async () => {
      throw new InvokerError("content_review_unavailable", "review subsystem unavailable — the call was NOT executed");
    });
    const { deps, callWireTool } = makeDeps({ contentReviewHook: { enabled: () => true, fire } });
    deps.cache.set("inst-1", triadSnapshot([{ name: "content/update-thing" }]));
    const err = await invokeConnectorInstanceTool(
      { connectorKey: "wordpress", toolName: "content/update-thing", args: {}, actor: ACTOR },
      deps,
    ).catch((e: unknown) => e);
    expect((err as InvokerError).code).toBe("content_review_unavailable");
    expect(callWireTool).not.toHaveBeenCalled();
  });
});

describe("invokeConnectorInstanceTool — audit-sink failures never mask execution outcome", () => {
  it("success path: audit rejection is swallowed — the completed wire result is still returned", async () => {
    const { deps, audit, callWireTool } = makeDeps();
    audit.mockRejectedValueOnce(new Error("sink down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await invokeConnectorInstanceTool(
        { connectorKey: "wordpress", toolName: "ewpa/create-post", args: { title: "t" }, actor: ACTOR },
        deps,
      );
      expect(result).toEqual({ success: true, data: { ok: 1 } });
      expect(callWireTool).toHaveBeenCalledTimes(1);
      // The audit was still attempted exactly once (M4), as a success row.
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0]).toMatchObject({ decision: "allowed" });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("failure path: audit rejection is swallowed — the typed InvokerError still propagates", async () => {
    const { deps, audit, callWireTool } = makeDeps();
    const wireErr = new InvokerError("tool_error", "site-side tool failed");
    callWireTool.mockRejectedValueOnce(wireErr);
    audit.mockRejectedValueOnce(new Error("sink down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        invokeConnectorInstanceTool(
          { connectorKey: "wordpress", toolName: "ewpa/create-post", args: {}, actor: ACTOR },
          deps,
        ),
      ).rejects.toBe(wireErr);
      // The denial audit was still attempted exactly once.
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0]).toMatchObject({ decision: "denied" });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Guard the InvokerError type surface is used (import-level).
it("InvokerError carries a typed code", () => {
  expect(new InvokerError("tool_not_found").code).toBe("tool_not_found");
});

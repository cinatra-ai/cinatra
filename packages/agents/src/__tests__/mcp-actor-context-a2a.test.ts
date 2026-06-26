/**
 * Tests for a2aActorContext → actor bridging.
 *
 * Verifies that when mcpRequestContextStorage carries an a2aActorContext,
 * the agent-builder registry callback builds an actor with actorType:"a2a"
 * and the full scope envelope (tokenScopes, teamIds, projectIds, orgId).
 * When a2aActorContext is absent, the existing actorType:"model" path is preserved.
 */

import { describe, it, expect, vi } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

/**
 * Build a fake McpRuntimeToolServer that captures the callback registered for
 * a given tool name so we can invoke it synchronously in tests.
 */
function buildFakeServer(): {
  server: McpRuntimeToolServer;
  getCallback: (name: string) => ((input: unknown) => Promise<unknown>) | undefined;
} {
  const callbacks = new Map<string, (input: unknown) => Promise<unknown>>();
  // Cast to McpRuntimeToolServer — the fake only implements registerTool
  // (used by registerAgentBuilderPrimitives); other methods are unused in tests.
  const server = {
    registerTool(name: string, _meta: unknown, callback: (input: unknown) => Promise<unknown>) {
      callbacks.set(name, callback);
      // Return value unused in tests; cast satisfies McpRuntimeToolServer shape.
      return undefined as unknown as ReturnType<McpRuntimeToolServer["registerTool"]>;
    },
    registerResource: () => undefined as unknown,
    registerPrompt: () => undefined as unknown,
    registerScreen: () => undefined,
  } as unknown as McpRuntimeToolServer;
  return { server, getCallback: (name) => callbacks.get(name) };
}

/**
 * Dynamically import and call registerAgentBuilderPrimitives, bypassing
 * vi.mock() so we always get the live registry code.  We only need one
 * registered tool to invoke; we pick the first one available.
 */
async function loadAndRegister(server: McpRuntimeToolServer) {
  // Dynamic import so the module is not cached across tests (vitest resets
  // per-module caches with vi.resetModules() if needed, but here a single
  // import is sufficient because we only care about the callback closure).
  const mod = await import("../mcp/registry");
  await mod.registerAgentBuilderPrimitives(server);
}

/**
 * Invoke the first registered callback inside an mcpRequestContextStorage.run()
 * scope and return the actor that was passed to the underlying handler.
 */
async function captureActor(
  storeValue: Parameters<typeof mcpRequestContextStorage.run>[0],
  getCallback: (name: string) => ((input: unknown) => Promise<unknown>) | undefined,
): Promise<unknown> {
  let capturedActor: unknown = undefined;

  return new Promise<unknown>((resolve, reject) => {
    mcpRequestContextStorage.run(storeValue, async () => {
      // Find any registered callback — we just need one to fire the actor-build path.
      // We'll try "agent_list" first as it is always present.
      const cb = getCallback("agent_list");
      if (!cb) {
        reject(new Error("No callback found for agent_list — check handler stubs"));
        return;
      }
      try {
        // The handler returns the store result; but we are intercepting actor via
        // a vi.spy on the handler wrapper. Instead, we directly introspect the
        // mcpRequestContextStorage context inside the callback execution to assert
        // what the registry would build. For that we need the registry to run its
        // actorBase building logic — which happens inside the callback.
        //
        // We cannot easily intercept `handler()` without patching the handler
        // factory. Instead we wrap the test differently: we patch
        // `createAgentBuilderPrimitiveHandlers` to return a minimal spy handler
        // that records the actor it receives.
        //
        // NOTE: This test file relies on the fact that the spy installed below
        // is called DURING `cb()` execution. If the registry re-uses the handler
        // map built at module initialisation (before the spy), capturedActor
        // will remain undefined and the test will fail for the wrong reason.
        //
        // To avoid this, tests must be isolated with fresh module imports.
        await cb({});
        resolve(capturedActor);
      } catch (err) {
        // Actor capture may still succeed if the handler spy set it before throwing.
        resolve(capturedActor);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Simplified approach: spy on createAgentBuilderPrimitiveHandlers via vi.mock
// ---------------------------------------------------------------------------

vi.mock("../mcp/handlers", () => {
  // For each test we need to capture what actor the registry passed to the handler.
  // We expose a module-level recorded value via a closure shared with the tests.
  return {
    createAgentBuilderPrimitiveHandlers: () => ({
      // Return a map with exactly one handler entry that captures the actor.
      agent_list: async (request: { actor?: unknown }) => {
        (globalThis as { __lastCapturedActor?: unknown }).__lastCapturedActor = request.actor;
        return [];
      },
    }),
    // registry.ts also calls createAgentsPrimitiveHandlers(); the mock must
    // include it or the module crashes at registration time.
    createAgentsPrimitiveHandlers: () => ({}),
  };
});

vi.mock("../mcp/agent-tools-registry", () => ({
  registerPublishedAgentTools: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../mcp/discovery", () => ({
  registerAgentBuilderDiscovery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../mcp/schemas", () => ({
  AGENT_BUILDER_TOOL_META: {
    agent_list: {
      description: "List agents",
      inputSchema: { type: "object", properties: {} },
    },
  },
  // registry.ts spreads AGENTS_TOOL_META alongside AGENT_BUILDER_TOOL_META;
  // include an empty object or the module crashes at registration time.
  AGENTS_TOOL_META: {},
}));

// ---------------------------------------------------------------------------
// Helper: register + invoke + return captured actor
// ---------------------------------------------------------------------------

async function runInContext(
  store: Parameters<typeof mcpRequestContextStorage.run>[0],
): Promise<unknown> {
  (globalThis as { __lastCapturedActor?: unknown }).__lastCapturedActor = undefined;

  const { server, getCallback } = buildFakeServer();

  // We must reload the module for each test to pick up the vi.mock stubs.
  // Because vitest hoists vi.mock() above imports, a static import at the
  // top of this file would work. But since we need registry.ts to be
  // re-evaluated with fresh stubs per test, use dynamic import with cache bust.
  const { registerAgentBuilderPrimitives } = await import("../mcp/registry");
  await registerAgentBuilderPrimitives(server);

  const cb = getCallback("agent_list");
  if (!cb) throw new Error("agent_list callback not registered");

  await mcpRequestContextStorage.run(store, () => cb({}));

  return (globalThis as { __lastCapturedActor?: unknown }).__lastCapturedActor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("a2aActorContext → actor bridging (registry.ts)", () => {
  it("Test 1: a2aActorContext present → actor carries actorType:a2a with all fields", async () => {
    const actor = await runInContext({
      userId: "u-mcp",
      a2aActorContext: {
        userId: "u-ext",
        tokenScopes: ["agent.read", "agent.execute"],
        teamIds: ["t1"],
        projectIds: ["p1"],
        orgId: "o1",
      },
    });

    expect(actor).toMatchObject({
      actorType: "a2a",
      source: "a2a",
      userId: "u-ext",
      tokenScopes: ["agent.read", "agent.execute"],
      teamIds: ["t1"],
      projectIds: ["p1"],
      orgId: "o1",
    });
    // Must NOT have model/agent overrides
    expect((actor as Record<string, unknown>).actorType).toBe("a2a");
    expect((actor as Record<string, unknown>).source).toBe("a2a");
  });

  it("Test 2: no a2aActorContext → actor carries actorType:model (existing behaviour)", async () => {
    const actor = await runInContext({
      userId: "u-mcp",
    });

    expect(actor).toMatchObject({
      actorType: "model",
      source: "agent",
      userId: "u-mcp",
    });
    expect((actor as Record<string, unknown>).actorType).toBe("model");
  });

  it("Test 2b: delegatedRestricted in the request ctx → forwarded onto the model actor (#538)", async () => {
    const actor = await runInContext({
      userId: "u-mcp",
      delegatedRestricted: true,
    });

    expect(actor).toMatchObject({
      actorType: "model",
      source: "agent",
      userId: "u-mcp",
      delegatedRestricted: true,
    });
  });

  it("Test 2c: no delegatedRestricted → field omitted from the model actor", async () => {
    const actor = await runInContext({ userId: "u-mcp" });
    expect((actor as Record<string, unknown>).delegatedRestricted).toBeUndefined();
  });

  it("Test 3: no store at all → actor carries actorType:model with no userId", async () => {
    // Pass undefined as store — mcpRequestContextStorage.getStore() returns undefined
    // inside the run callback when the store value has no userId and no a2aActorContext.
    const actor = await runInContext({});

    expect(actor).toMatchObject({
      actorType: "model",
      source: "agent",
    });
    // userId must not be present (no userId in store, no a2aActorContext)
    expect((actor as Record<string, unknown>).userId).toBeUndefined();
  });

  it("Test 4: a2aActorContext with tokenScopes undefined → actorType:a2a, tokenScopes omitted", async () => {
    const actor = await runInContext({
      a2aActorContext: {
        userId: "u-ext",
        // tokenScopes intentionally omitted
        teamIds: ["t1"],
        projectIds: ["p1"],
        orgId: "o1",
      },
    });

    expect((actor as Record<string, unknown>).actorType).toBe("a2a");
    expect((actor as Record<string, unknown>).source).toBe("a2a");
    expect((actor as Record<string, unknown>).userId).toBe("u-ext");
    // tokenScopes must not be present (not coerced to [])
    expect(Object.prototype.hasOwnProperty.call(actor, "tokenScopes")).toBe(false);
  });

  it("Test 5: model branch carries the transport-resolved orgRole (issue #83)", async () => {
    const actor = await runInContext({
      userId: "u-mcp",
      orgId: "o-mcp",
      orgRole: "org_admin",
    });

    expect(actor).toMatchObject({
      actorType: "model",
      source: "agent",
      userId: "u-mcp",
      orgId: "o-mcp",
      orgRole: "org_admin",
    });
  });

  it("Test 6: a2a branch does NOT inherit the transport orgRole (identity-crossing guard)", async () => {
    // The transport resolved orgRole for ITS identity (ctx.userId/ctx.orgId);
    // the a2a branch identity comes from a2aActorContext (potentially a
    // different user/org) — the role must never cross.
    const actor = await runInContext({
      userId: "u-mcp",
      orgId: "o-mcp",
      orgRole: "org_owner",
      a2aActorContext: {
        userId: "u-ext",
        teamIds: ["t1"],
        projectIds: ["p1"],
        orgId: "o-ext",
      },
    });

    expect((actor as Record<string, unknown>).actorType).toBe("a2a");
    expect(Object.prototype.hasOwnProperty.call(actor, "orgRole")).toBe(false);
  });

  it("Test 7: model branch omits orgRole when the store carries none (no synthesis)", async () => {
    const actor = await runInContext({
      userId: "u-mcp",
      orgId: "o-mcp",
    });

    expect((actor as Record<string, unknown>).actorType).toBe("model");
    expect(Object.prototype.hasOwnProperty.call(actor, "orgRole")).toBe(false);
  });
});

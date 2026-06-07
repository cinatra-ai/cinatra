import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Single mutable store stand-ins so each test can shape the resolved context.
const mcpStore: { current: unknown } = { current: undefined };
const llmActor: { current: unknown } = { current: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => mcpStore.current },
}));
vi.mock("@cinatra-ai/llm", () => ({ getActorContext: () => llmActor.current }));
vi.mock("@/lib/auth-session", () => ({ getActorContext: async () => undefined }));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: (
    actor: { actorType?: string; userId?: string; orgId?: string },
    runOrgId?: string | null,
  ) => ({
    principalType: actor.actorType === "a2a" ? "ExternalA2AAgent" : "model",
    principalId: actor.userId ?? "system",
    organizationId: actor.orgId ?? runOrgId ?? undefined,
  }),
}));

import { resolveExtensionActorSummary } from "@/lib/extension-host-actor";

describe("resolveExtensionActorSummary — single-store, A2A-strict subject resolution", () => {
  beforeEach(() => {
    mcpStore.current = undefined;
    llmActor.current = undefined;
  });

  it("A2A present with NO a2a.userId + a top-level ctx.userId → subject is null (no cross-identity mix)", async () => {
    // The exact tuple the strict-A2A rule must prevent: top-level user + A2A org.
    mcpStore.current = { a2aActorContext: { orgId: "a2a-org" }, userId: "top-level-user" };
    const s = await resolveExtensionActorSummary();
    expect(s?.userId).toBeNull(); // must NOT borrow the top-level userId
    expect(s?.organizationId).toBe("a2a-org"); // org from the SAME (A2A) store
  });

  it("A2A present WITH a2a.userId → subject is the a2a user, org is the a2a org", async () => {
    mcpStore.current = { a2aActorContext: { userId: "a2a-user", orgId: "a2a-org" }, userId: "top-level-IGNORED" };
    const s = await resolveExtensionActorSummary();
    expect(s?.userId).toBe("a2a-user");
    expect(s?.organizationId).toBe("a2a-org");
  });

  it("non-A2A MCP (cookie-delegated model) → subject is the top-level ctx.userId + org", async () => {
    mcpStore.current = { userId: "human-1", orgId: "org-1" };
    const s = await resolveExtensionActorSummary();
    expect(s?.userId).toBe("human-1");
    expect(s?.organizationId).toBe("org-1");
  });

  it("llm store (higher priority) wins for BOTH actor and subject — MCP is not consulted", async () => {
    llmActor.current = { principalType: "HumanUser", principalId: "llm-human", organizationId: "llm-org" };
    mcpStore.current = { userId: "mcp-other-user", orgId: "mcp-other-org" };
    const s = await resolveExtensionActorSummary();
    expect(s?.userId).toBe("llm-human");
    expect(s?.organizationId).toBe("llm-org");
  });
});

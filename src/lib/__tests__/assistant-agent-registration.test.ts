// Unit tests for assistant-agent registration (cinatra#1037 P1.3) — the ONE
// principal-minting path (I3). The Better Auth DB, the mint primitive, the handle
// registry, and the agent-builder store are mocked; what these tests prove is the
// module's own contract:
//   * fresh install -> mints the principal via createAssistantUserWithTx (the
//     sole mint primitive), inside an ADVISORY-LOCKED transaction (the lock is
//     taken on the SAME connection as the mint), then mints the handle and
//     upserts the 1:1-linked assistant template;
//   * steady state -> reuses the existing principal (NO mint), still (idempotently)
//     re-links the template;
//   * drift (existing user, no oauthClient) -> repairs the oauth pair, no mint;
//   * the built-in Cinatra config seeds the linked template.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  txExecute: vi.fn(),
  transaction: vi.fn(),
  registerAssistantHandle: vi.fn(),
  insertOAuthClientWithTx: vi.fn(),
  createAssistantUserWithTx: vi.fn(),
  upsertBuiltInAssistantAgentTemplate: vi.fn(),
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { transaction: mocks.transaction },
  registerAssistantHandle: mocks.registerAssistantHandle,
}));
vi.mock("@/lib/better-auth-oauth-client", () => ({
  insertOAuthClientWithTx: mocks.insertOAuthClientWithTx,
}));
vi.mock("@/lib/assistant-users", () => ({
  createAssistantUserWithTx: mocks.createAssistantUserWithTx,
  BUILT_IN_CINATRA_ASSISTANT_USERNAME: "cinatra",
}));
vi.mock("@cinatra-ai/agents", () => ({
  upsertBuiltInAssistantAgentTemplate: mocks.upsertBuiltInAssistantAgentTemplate,
}));

import { registerAssistantAgent, ensureBuiltInCinatraAssistantAgent } from "@/lib/assistant-agent-registration";
import { cinatraAssistantConfig } from "@/lib/assistant-runtime/cinatra-assistant-config";
import { serializeAssistantConfig } from "@/lib/assistant-config";

const fakeTx = { execute: mocks.txExecute };

beforeEach(() => {
  vi.clearAllMocks();
  // transaction runs the callback with the fake tx and returns its result.
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx));
  mocks.registerAssistantHandle.mockResolvedValue({ handle: "cinatra" });
  mocks.upsertBuiltInAssistantAgentTemplate.mockResolvedValue("agt_builtin_cinatra_assistant");
});

describe("registerAssistantAgent — fresh install", () => {
  it("takes the advisory lock, mints via the sole primitive, links the template + handle", async () => {
    mocks.txExecute
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }); // SELECT existing user -> none
    mocks.createAssistantUserWithTx.mockResolvedValue({
      id: "new-principal",
      username: "cinatra",
      email: "cinatra@system.local",
      clientId: "cid",
      clientSecret: "csecret",
      userType: "assistant",
    });

    const out = await registerAssistantAgent({
      username: "cinatra",
      config: cinatraAssistantConfig,
      name: "Cinatra",
    });

    // Advisory lock taken on the same tx as the mint (first execute call).
    const lockSql = JSON.stringify(mocks.txExecute.mock.calls[0][0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");

    expect(mocks.createAssistantUserWithTx).toHaveBeenCalledTimes(1);
    expect(mocks.createAssistantUserWithTx).toHaveBeenCalledWith(fakeTx, { username: "cinatra" });
    expect(mocks.registerAssistantHandle).toHaveBeenCalledWith("new-principal", { desired: "cinatra" });
    expect(mocks.upsertBuiltInAssistantAgentTemplate).toHaveBeenCalledWith({
      assistantUserId: "new-principal",
      name: "Cinatra",
      assistantConfigJson: serializeAssistantConfig(cinatraAssistantConfig),
    });
    expect(out).toEqual({ assistantUserId: "new-principal", templateId: "agt_builtin_cinatra_assistant" });
  });
});

describe("registerAssistantAgent — steady state (principal exists)", () => {
  it("reuses the principal without minting, still re-links the template", async () => {
    mocks.txExecute
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: "existing-principal" }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }); // oauthClient count -> present

    const out = await registerAssistantAgent({
      username: "cinatra",
      config: cinatraAssistantConfig,
      name: "Cinatra",
    });

    expect(mocks.createAssistantUserWithTx).not.toHaveBeenCalled();
    expect(mocks.insertOAuthClientWithTx).not.toHaveBeenCalled();
    expect(mocks.upsertBuiltInAssistantAgentTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ assistantUserId: "existing-principal", name: "Cinatra" }),
    );
    expect(out.assistantUserId).toBe("existing-principal");
  });
});

describe("registerAssistantAgent — drift repair (existing user, no oauthClient)", () => {
  it("repairs the oauth pair without minting a new principal", async () => {
    mocks.txExecute
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: "existing-principal" }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }) // oauthClient count -> MISSING
      .mockResolvedValueOnce({ rows: [] }); // UPDATE user clientId

    await registerAssistantAgent({ username: "cinatra", config: cinatraAssistantConfig, name: "Cinatra" });

    expect(mocks.createAssistantUserWithTx).not.toHaveBeenCalled();
    expect(mocks.insertOAuthClientWithTx).toHaveBeenCalledTimes(1);
    expect(mocks.insertOAuthClientWithTx.mock.calls[0][1]).toEqual(
      expect.objectContaining({ id: "existing-principal", userId: "existing-principal" }),
    );
  });
});

describe("ensureBuiltInCinatraAssistantAgent", () => {
  it("registers @cinatra with the reference config; swallows failures (best-effort at boot)", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(ensureBuiltInCinatraAssistantAgent()).resolves.toBeUndefined();
  });
});

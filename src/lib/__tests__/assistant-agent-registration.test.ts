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
  BUILT_IN_WORDPRESS_ASSISTANT_USERNAME: "wordpress",
  BUILT_IN_DRUPAL_ASSISTANT_USERNAME: "drupal",
}));
vi.mock("@cinatra-ai/agents", () => ({
  upsertBuiltInAssistantAgentTemplate: mocks.upsertBuiltInAssistantAgentTemplate,
  BUILT_IN_WORDPRESS_ASSISTANT_TEMPLATE_ID: "agt_builtin_wordpress_assistant",
  BUILT_IN_WORDPRESS_ASSISTANT_PACKAGE_NAME: "@cinatra-ai/wordpress-assistant",
  BUILT_IN_DRUPAL_ASSISTANT_TEMPLATE_ID: "agt_builtin_drupal_assistant",
  BUILT_IN_DRUPAL_ASSISTANT_PACKAGE_NAME: "@cinatra-ai/drupal-assistant",
}));

import {
  registerAssistantAgent,
  ensureBuiltInCinatraAssistantAgent,
  ensureBuiltInWordpressAssistantAgent,
  ensureBuiltInDrupalAssistantAgent,
} from "@/lib/assistant-agent-registration";
import { cinatraAssistantConfig } from "@/lib/assistant-runtime/cinatra-assistant-config";
import { wordpressAssistantConfig } from "@/lib/assistant-runtime/wordpress-assistant-config";
import { drupalAssistantConfig } from "@/lib/assistant-runtime/drupal-assistant-config";
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

// cinatra#1823 (epic #1037 P4.1) — the WordPress + Drupal built-in assistants are
// registered the SAME way @cinatra is (siblings), each through the sole
// registerAssistantAgent path (I3) with its OWN distinct principal handle,
// template id + package_name, and validated assistant_config.
describe("ensureBuiltInWordpressAssistantAgent / ensureBuiltInDrupalAssistantAgent", () => {
  function freshMint(principalId: string) {
    mocks.txExecute
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }); // SELECT existing user -> none
    mocks.createAssistantUserWithTx.mockResolvedValue({
      id: principalId,
      username: principalId,
      email: `${principalId}@system.local`,
      clientId: "cid",
      clientSecret: "csecret",
      userType: "assistant",
    });
  }

  it("registers @wordpress via the sole mint path with its own handle, template identity, and distinct config", async () => {
    freshMint("wp-principal");
    await ensureBuiltInWordpressAssistantAgent();

    expect(mocks.createAssistantUserWithTx).toHaveBeenCalledWith(fakeTx, { username: "wordpress" });
    expect(mocks.registerAssistantHandle).toHaveBeenCalledWith("wp-principal", { desired: "wordpress" });
    expect(mocks.upsertBuiltInAssistantAgentTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantUserId: "wp-principal",
        name: "WordPress",
        templateId: "agt_builtin_wordpress_assistant",
        packageName: "@cinatra-ai/wordpress-assistant",
        assistantConfigJson: serializeAssistantConfig(wordpressAssistantConfig),
      }),
    );
    // Distinct from @cinatra's persisted config.
    expect(serializeAssistantConfig(wordpressAssistantConfig)).not.toBe(
      serializeAssistantConfig(cinatraAssistantConfig),
    );
  });

  it("registers @drupal via the sole mint path with its own handle, template identity, and distinct config", async () => {
    freshMint("drupal-principal");
    await ensureBuiltInDrupalAssistantAgent();

    expect(mocks.createAssistantUserWithTx).toHaveBeenCalledWith(fakeTx, { username: "drupal" });
    expect(mocks.registerAssistantHandle).toHaveBeenCalledWith("drupal-principal", { desired: "drupal" });
    expect(mocks.upsertBuiltInAssistantAgentTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantUserId: "drupal-principal",
        name: "Drupal",
        templateId: "agt_builtin_drupal_assistant",
        packageName: "@cinatra-ai/drupal-assistant",
        assistantConfigJson: serializeAssistantConfig(drupalAssistantConfig),
      }),
    );
    expect(serializeAssistantConfig(drupalAssistantConfig)).not.toBe(
      serializeAssistantConfig(cinatraAssistantConfig),
    );
  });

  it("is best-effort at boot: a failure is swallowed (does not break bootstrap)", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(ensureBuiltInWordpressAssistantAgent()).resolves.toBeUndefined();
    mocks.transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(ensureBuiltInDrupalAssistantAgent()).resolves.toBeUndefined();
  });

  it("steady-state re-run converges: an existing principal is reused (NO re-mint), template re-linked idempotently", async () => {
    // wordpress principal already exists WITH an oauthClient (steady state).
    mocks.txExecute
      .mockResolvedValueOnce({ rows: [] }) // lock
      .mockResolvedValueOnce({ rows: [{ id: "wp-principal" }] }) // SELECT user -> exists
      .mockResolvedValueOnce({ rows: [{ count: "1" }] }); // oauthClient present

    await ensureBuiltInWordpressAssistantAgent();

    expect(mocks.createAssistantUserWithTx).not.toHaveBeenCalled();
    expect(mocks.upsertBuiltInAssistantAgentTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantUserId: "wp-principal",
        templateId: "agt_builtin_wordpress_assistant",
      }),
    );
  });
});

// The three built-in assistants converge on THREE distinct principals / handles /
// template ids / configs across a (mocked) full boot registration — the
// idempotent-convergence acceptance, exercised through the real registration path.
describe("three-assistant boot convergence (cinatra#1823)", () => {
  it("mints three distinct principals + handles + template identities, each with a distinct config", async () => {
    const principals: Record<string, string> = {
      cinatra: "p-cinatra",
      wordpress: "p-wordpress",
      drupal: "p-drupal",
    };
    // Each registerAssistantAgent call: lock + SELECT(none) -> mint the mapped principal.
    mocks.txExecute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes("pg_advisory_xact_lock")) return { rows: [] };
      return { rows: [] }; // SELECT existing user -> none (fresh mint each)
    });
    mocks.createAssistantUserWithTx.mockImplementation(async (_tx: unknown, p: { username: string }) => ({
      id: principals[p.username],
      username: p.username,
      email: `${p.username}@system.local`,
      clientId: "cid",
      clientSecret: "csecret",
      userType: "assistant",
    }));

    await ensureBuiltInCinatraAssistantAgent();
    await ensureBuiltInWordpressAssistantAgent();
    await ensureBuiltInDrupalAssistantAgent();

    const mintedUsernames = mocks.createAssistantUserWithTx.mock.calls.map((c) => c[1].username);
    expect(new Set(mintedUsernames)).toEqual(new Set(["cinatra", "wordpress", "drupal"]));

    const handleCalls = mocks.registerAssistantHandle.mock.calls.map((c) => [c[0], c[1].desired]);
    expect(handleCalls).toEqual(
      expect.arrayContaining([
        ["p-cinatra", "cinatra"],
        ["p-wordpress", "wordpress"],
        ["p-drupal", "drupal"],
      ]),
    );

    const upserts = mocks.upsertBuiltInAssistantAgentTemplate.mock.calls.map((c) => c[0]);
    const templateIds = upserts.map((u) => u.templateId ?? "agt_builtin_cinatra_assistant");
    expect(new Set(templateIds)).toEqual(
      new Set([
        "agt_builtin_cinatra_assistant",
        "agt_builtin_wordpress_assistant",
        "agt_builtin_drupal_assistant",
      ]),
    );
    const configs = upserts.map((u) => u.assistantConfigJson);
    expect(new Set(configs).size).toBe(3); // three DISTINCT persisted configs
    const principalIds = upserts.map((u) => u.assistantUserId);
    expect(new Set(principalIds)).toEqual(new Set(["p-cinatra", "p-wordpress", "p-drupal"]));
  });
});

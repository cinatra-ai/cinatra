/**
 * agent-run-mcp-actor-token mint + verify contract.
 *
 * Bug A (2026-05-23): chat-dispatched agents hit `not_org_member` at the
 * MCP boundary because the bridge minted a machine `client_credentials`
 * Bearer with no userId/orgId. This module mints a delegated agent-run
 * OBO token carrying the dispatching user's identity + the run's org +
 * the run id, and the MCP transport accepts it as a first-party
 * delegated actor.
 *
 * These tests pin:
 *  - TTL is 30 minutes (matches the chat token; a single agent step can
 *    span multiple MCP calls and the OpenAI hosted relay reuses the
 *    bearer for all of them)
 *  - A fresh token verifies for the audience+issuer it was minted with
 *  - An expired token is rejected
 *  - A token whose `t` claim says "cinatra.chat.mcp-obo" does NOT verify
 *    here (and vice versa: chat token verifier rejects agent-run tokens)
 *  - Missing `run` claim is rejected (would otherwise let an attacker mint
 *    an OBO token without binding it to a run)
 *  - Missing `org` claim is rejected (agent-run path is strictly
 *    org-scoped — orgId nullability is a chat-only relaxation)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const PUBLIC_BASE_URL = "https://cinatra-test.tailnet000.ts.net";
const PUBLIC_MCP_URL = `${PUBLIC_BASE_URL}/api/mcp`;
const PUBLIC_AUTH_URL = `${PUBLIC_BASE_URL}/api/auth`;

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalMcpServerUrl: (path: string) => `http://localhost:3000${path}`,
  getPublicMcpServerUrl: () => PUBLIC_MCP_URL,
}));

import {
  issueAgentRunMcpActorToken,
  verifyAgentRunMcpActorToken,
  type AgentRunMcpActor,
} from "../agent-run-mcp-actor-token";
import {
  issueChatMcpActorToken,
  verifyChatMcpActorToken,
  type ChatMcpActor,
} from "../chat-mcp-actor-token";

const AGENT_RUN_ACTOR: AgentRunMcpActor = {
  delegation: "agent_run",
  userId: "u-test",
  orgId: "org-test",
  runId: "run-test-uuid",
  platformRole: "member",
};

const CHAT_ACTOR: ChatMcpActor = {
  delegation: "chat",
  userId: "u-test",
  orgId: "org-test",
  platformRole: "member",
};

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-actor-token-unit";
});

afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
  }
});

function decodePayload(token: string): {
  t: string;
  exp: number;
  iat: number;
  run: string;
  org: string;
} {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("agent-run-mcp-actor-token mint", () => {
  it("issues a token with the 30-minute TTL (mirrors chat token)", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    const after = Math.floor(Date.now() / 1000);
    const { iat, exp, t, run, org } = decodePayload(token);
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(after);
    expect(exp - iat).toBe(30 * 60);
    expect(t).toBe("cinatra.agent-run.mcp-obo");
    expect(run).toBe("run-test-uuid");
    expect(org).toBe("org-test");
  });
});

describe("agent-run-mcp-actor-token verify", () => {
  it("verifies a freshly-minted token against its own audience/issuer", () => {
    const token = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${token}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toEqual(AGENT_RUN_ACTOR);
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-23T01:13:55Z"));
      const token = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
      vi.setSystemTime(new Date("2026-05-23T02:15:00Z")); // +60min
      const verified = verifyAgentRunMcpActorToken({
        authHeader: `Bearer ${token}`,
        request: new Request(PUBLIC_MCP_URL),
        expectedAudience: PUBLIC_MCP_URL,
        expectedIssuer: PUBLIC_AUTH_URL,
      });
      expect(verified).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a chat-typed token (cross-type forgery protection)", () => {
    // A token minted via `issueChatMcpActorToken` (t = "cinatra.chat.mcp-obo")
    // MUST NOT verify under the agent-run verifier — otherwise an attacker
    // who could mint a chat-OBO token (e.g. a chat user) could ride it as
    // an agent-run token and bypass the chat tool-policy allowlist.
    const chatToken = issueChatMcpActorToken(CHAT_ACTOR);
    const verifiedAsAgentRun = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${chatToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verifiedAsAgentRun).toBeNull();
  });

  it("rejects an agent-run token under the chat verifier (cross-type, reverse)", () => {
    // Symmetric protection: an agent-run token must not be accepted as a
    // chat token (which would change the MCP transport's tool-policy
    // mode). The chat verifier's `t` check pins to
    // `"cinatra.chat.mcp-obo"`.
    const agentRunToken = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    const verifiedAsChat = verifyChatMcpActorToken({
      authHeader: `Bearer ${agentRunToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verifiedAsChat).toBeNull();
  });

  it("rejects a wrong-audience token", () => {
    const token = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${token}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: "https://other-instance.example.com/api/mcp",
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });

  it("rejects a malformed token", () => {
    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer not-a-jwt`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });

  it("rejects an absent Authorization header", () => {
    const verified = verifyAgentRunMcpActorToken({
      authHeader: null,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });

  it("carries the runId on the resolved actor (for audit + request-store propagation)", () => {
    const token = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${token}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified?.runId).toBe(AGENT_RUN_ACTOR.runId);
    expect(verified?.delegation).toBe("agent_run");
  });

  it("rejects a token whose payload is mutated to drop the `run` claim", () => {
    // Forge a token by splicing the original signature onto a payload
    // missing `run`. The HMAC won't match → rejected. This pins the
    // signature-verification half. The CLAIM-shape half is also pinned
    // via the additional "manually-resigned" attack below.
    const token = issueAgentRunMcpActorToken(AGENT_RUN_ACTOR);
    const [header, payload, signature] = token.split(".");
    const payloadObj = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    delete payloadObj.run;
    const mutatedPayload = Buffer.from(
      JSON.stringify(payloadObj),
      "utf8",
    ).toString("base64url");
    const splicedToken = `${header}.${mutatedPayload}.${signature}`;
    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${splicedToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });

  it("rejects a token whose payload is re-signed without the `org` claim", () => {
    // The signature-mutation test above can be defeated by re-signing.
    // This test pins the CLAIM-shape half: even with a valid HMAC, the
    // verifier rejects a token missing `org` (which is REQUIRED on the
    // agent-run path — unlike the chat path where org may be null).
    //
    // We construct a payload by hand and HMAC-sign with the test secret.
    const { createHmac } = require("node:crypto");
    const secret = process.env.BETTER_AUTH_SECRET;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        t: "cinatra.agent-run.mcp-obo",
        sub: "u-test",
        // org INTENTIONALLY OMITTED — verifier must reject
        run: "run-test",
        prole: "member",
        scope: "mcp:connect",
        aud: PUBLIC_MCP_URL,
        iss: PUBLIC_AUTH_URL,
        iat: now,
        exp: now + 1800,
      }),
      "utf8",
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = createHmac("sha256", secret!)
      .update(signingInput)
      .digest("base64url");
    const handCraftedToken = `${signingInput}.${signature}`;

    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${handCraftedToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });

  it("rejects a token re-signed without the `run` claim (CLAIM-shape pinning)", () => {
    const { createHmac } = require("node:crypto");
    const secret = process.env.BETTER_AUTH_SECRET;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
      "utf8",
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        t: "cinatra.agent-run.mcp-obo",
        sub: "u-test",
        org: "org-test",
        // run INTENTIONALLY OMITTED — verifier must reject
        prole: "member",
        scope: "mcp:connect",
        aud: PUBLIC_MCP_URL,
        iss: PUBLIC_AUTH_URL,
        iat: now,
        exp: now + 1800,
      }),
      "utf8",
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = createHmac("sha256", secret!)
      .update(signingInput)
      .digest("base64url");
    const handCraftedToken = `${signingInput}.${signature}`;

    const verified = verifyAgentRunMcpActorToken({
      authHeader: `Bearer ${handCraftedToken}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toBeNull();
  });
});

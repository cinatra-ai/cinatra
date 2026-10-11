/**
 * cinatra#3745 — the run's on-behalf-of token carries the verified step of the
 * calling model step as its optional `stp` claim. The issuer writes it when the
 * actor carries `verifiedStepId`; the verifier reads it tolerantly (a
 * non-string or empty value reads as absent and the token stays valid).
 * These cases drive the real issuer and verifier.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";

const PUBLIC_BASE_URL = "https://example.test";
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

const SECRET = "test-secret-for-step-claim-unit";
const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = SECRET;
});

afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
  }
});

const ACTOR: AgentRunMcpActor = {
  delegation: "agent_run",
  userId: "u-test",
  orgId: "org-test",
  runId: "run-test",
  platformRole: "member",
  oboCeiling: [
    { tier: "user", id: "u-test" },
    { tier: "organization", id: "org-test" },
  ],
};

function verify(token: string) {
  return verifyAgentRunMcpActorToken({
    authHeader: `Bearer ${token}`,
    request: new Request(PUBLIC_MCP_URL),
    expectedAudience: PUBLIC_MCP_URL,
    expectedIssuer: PUBLIC_AUTH_URL,
  });
}

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

function signPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", SECRET).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("the on-behalf-of token's step claim", () => {
  // (k1)
  it("an actor with a verified step verifies back with that step", () => {
    const token = issueAgentRunMcpActorToken({
      ...ACTOR,
      verifiedStepId: "step-node-1",
    } as AgentRunMcpActor);
    expect(decodePayload(token).stp).toBe("step-node-1");
    const verified = verify(token) as (AgentRunMcpActor & { verifiedStepId?: string }) | null;
    expect(verified).not.toBeNull();
    expect(verified?.verifiedStepId).toBe("step-node-1");
    expect(verified?.runId).toBe(ACTOR.runId);
  });

  // (k2)
  it("an actor without a step verifies with no step and every other field as issued", () => {
    const token = issueAgentRunMcpActorToken(ACTOR);
    expect(decodePayload(token).stp).toBeUndefined();
    const verified = verify(token);
    expect(verified).toEqual(ACTOR);
    expect(verified && "verifiedStepId" in verified).toBe(false);
  });

  // (k3)
  it("a correctly signed token whose step claim is a number or empty verifies with no step", () => {
    const base = decodePayload(issueAgentRunMcpActorToken(ACTOR));
    for (const stp of [7, "", null, { node: "x" }]) {
      const verified = verify(signPayload({ ...base, stp }));
      expect(verified).not.toBeNull();
      expect(verified?.runId).toBe(ACTOR.runId);
      expect(
        verified && "verifiedStepId" in verified
          ? (verified as { verifiedStepId?: unknown }).verifiedStepId
          : undefined,
      ).toBeUndefined();
    }
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("@cinatra-ai/mcp-server/credentials");
  vi.resetModules();
});

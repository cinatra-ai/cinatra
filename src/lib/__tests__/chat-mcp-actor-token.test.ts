/**
 * chat-mcp-actor-token TTL & verifier regression tests.
 *
 * The OpenAI hosted MCP relay reuses the chat actor token as a static Bearer
 * header for every `mcp_call` in a single chat turn — there is no refresh
 * path. The TTL must therefore outlast a realistic chat turn. A 60s value
 * was too tight: workflow-creation turns with multi-validate loops routinely
 * took 60-90s and the final tool call landed with `exp < now`, returning
 * 401 "Authentication is required to access the Cinatra MCP server."
 *
 * These tests pin:
 *  - TTL is at least 10 minutes (well above any realistic chat turn)
 *  - A fresh token verifies for the audience+issuer it was minted with
 *  - An expired token is rejected (the original failure mode)
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
  chatMcpActorTokenIssuedAt,
  issueChatMcpActorToken,
  verifyChatMcpActorToken,
  type ChatMcpActor,
} from "../chat-mcp-actor-token";

const ACTOR: ChatMcpActor = {
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

function decodePayload(token: string): { exp: number; iat: number } {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("chat-mcp-actor-token TTL", () => {
  it("issues a token with the agreed 30-minute TTL", () => {
    const at = Math.floor(Date.now() / 1000);
    const token = issueChatMcpActorToken(ACTOR);
    const { iat, exp } = decodePayload(token);
    // cinatra#2771: `iat` is FLOORED to a bucket, so it is at or before the
    // mint instant — never after it, and never more than one bucket behind.
    expect(iat).toBeLessThanOrEqual(at);
    expect(at - iat).toBeLessThan(5 * 60);
    expect(iat).toBe(chatMcpActorTokenIssuedAt(Date.now()));
    expect(exp - iat).toBe(30 * 60);
  });

  it("verifies a freshly-minted token against its own audience/issuer", () => {
    const token = issueChatMcpActorToken(ACTOR);
    const verified = verifyChatMcpActorToken({
      authHeader: `Bearer ${token}`,
      request: new Request(PUBLIC_MCP_URL),
      expectedAudience: PUBLIC_MCP_URL,
      expectedIssuer: PUBLIC_AUTH_URL,
    });
    expect(verified).toEqual(ACTOR);
  });

  it("rejects a token whose exp has passed (the regression: 75s-elapsed turn)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-23T01:13:55Z"));
      const token = issueChatMcpActorToken(ACTOR);
      // Mirror the live failure: workflow_draft_create landed 75s into a turn,
      // long past the original 60s TTL. Advance 75s; the new TTL must still
      // verify, AND a 31-minute jump must now be the only thing that fails.
      vi.setSystemTime(new Date("2026-05-23T01:15:10Z"));
      const verifiedAfter75s = verifyChatMcpActorToken({
        authHeader: `Bearer ${token}`,
        request: new Request(PUBLIC_MCP_URL),
        expectedAudience: PUBLIC_MCP_URL,
        expectedIssuer: PUBLIC_AUTH_URL,
      });
      expect(verifiedAfter75s).toEqual(ACTOR);

      vi.setSystemTime(new Date("2026-05-23T01:45:00Z"));
      const verifiedAfter31m = verifyChatMcpActorToken({
        authHeader: `Bearer ${token}`,
        request: new Request(PUBLIC_MCP_URL),
        expectedAudience: PUBLIC_MCP_URL,
        expectedIssuer: PUBLIC_AUTH_URL,
      });
      expect(verifiedAfter31m).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// cinatra#2771 lever 2 — the token is part of the REQUEST PREFIX.
//
// The chat turn's first tool is the hosted MCP reference, and this token is its
// `headers.Authorization`. A provider caches the longest matching request
// prefix, so a token whose bytes changed every second re-billed the whole tool
// catalog on every turn however closely spaced. Quantizing the mint clock makes
// consecutive turns byte-identical, without ever extending a token's life.
// ---------------------------------------------------------------------------
describe("chat-mcp-actor-token prefix byte-stability", () => {
  it("mints byte-identical tokens for two turns inside one bucket", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T09:01:00Z"));
      const first = issueChatMcpActorToken(ACTOR);
      // A second turn 90 s later — the shape the issue measured as a cache miss.
      vi.setSystemTime(new Date("2026-08-17T09:02:30Z"));
      const second = issueChatMcpActorToken(ACTOR);
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mints a different token once the bucket rolls over", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T09:04:59Z"));
      const inBucket = issueChatMcpActorToken(ACTOR);
      vi.setSystemTime(new Date("2026-08-17T09:05:01Z"));
      const nextBucket = issueChatMcpActorToken(ACTOR);
      expect(nextBucket).not.toBe(inBucket);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never extends a token's life beyond the unquantized mint (non-widening)", () => {
    vi.useFakeTimers();
    try {
      const mintAt = new Date("2026-08-17T09:04:59Z");
      vi.setSystemTime(mintAt);
      const { iat, exp } = decodePayload(issueChatMcpActorToken(ACTOR));
      const unquantizedExp = Math.floor(mintAt.getTime() / 1000) + 30 * 60;
      expect(exp).toBeLessThanOrEqual(unquantizedExp);
      expect(exp - iat).toBe(30 * 60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still verifies well past the longest turn the runtime allows (120 s)", () => {
    vi.useFakeTimers();
    try {
      // Worst case: minted at the very END of a bucket, so the remaining life
      // is the shortest it can ever be.
      vi.setSystemTime(new Date("2026-08-17T09:04:59Z"));
      const token = issueChatMcpActorToken(ACTOR);
      vi.setSystemTime(new Date("2026-08-17T09:24:00Z"));
      expect(
        verifyChatMcpActorToken({
          authHeader: `Bearer ${token}`,
          request: new Request(PUBLIC_MCP_URL),
          expectedAudience: PUBLIC_MCP_URL,
          expectedIssuer: PUBLIC_AUTH_URL,
        }),
      ).toEqual(ACTOR);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still separates two different actors", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-17T09:01:00Z"));
      const mine = issueChatMcpActorToken(ACTOR);
      const theirs = issueChatMcpActorToken({ ...ACTOR, userId: "u-other" });
      expect(theirs).not.toBe(mine);
    } finally {
      vi.useRealTimers();
    }
  });
});

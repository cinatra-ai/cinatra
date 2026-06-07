import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getLocalMcpServerUrl,
  getPublicMcpServerUrl,
} from "@cinatra-ai/mcp-server/credentials";

// ---------------------------------------------------------------------------
// Chat → MCP delegated on-behalf-of (OBO) actor token.
//
// The chat surface is authenticated as a real human (better-auth session).
// When the chat dispatches an agent via native `type: "mcp"` injection,
// OpenAI's hosted MCP infra relays the call back to /api/mcp from OpenAI's
// servers — there is no cookie session, and the only auth would otherwise
// be the machine `client_credentials` token, which resolves to an anonymous
// machine actor (userId=null, no platformRole). That breaks Cinatra's
// human-user-centric authz (`run_by` ownership, platformRole, org scoping):
// chat-launched agent_run lands with run_by=null and the chat's follow-up
// agent_run_get is denied by enforceRunAccess.
//
// This module issues a HMAC-signed JWT that carries the CHAT USER's identity
// (the human using the chat — NOT the chat as its own identity, NOT a service
// account). The MCP transport accepts it as an alternate bearer and resolves
// the actor to that human. No new account, no new permission grant — pure
// identity propagation across the hosted-MCP boundary. Aligned with RFC 8693
// token-exchange semantics, simplified to a first-party signed token until
// full token-exchange is warranted.
// ---------------------------------------------------------------------------

export type ChatMcpPlatformRole = "platform_admin" | "member";

export type ChatMcpActor = {
  /**
   * Discriminator for the DelegatedMcpActor union. Always `"chat"` for
   * tokens minted/verified by this module. The matching `"agent_run"`
   * branch lives in `agent-run-mcp-actor-token.ts`.
   *
   * IMPORTANT: this field is REQUIRED. The token format is unchanged
   * (the `t` payload claim still distinguishes types over the wire);
   * `delegation` is the in-memory discriminator that downstream code
   * (MCP transport, audit log) reads to apply the correct policy.
   */
  delegation: "chat";
  userId: string;
  orgId: string | null;
  platformRole: ChatMcpPlatformRole;
};

type ChatMcpActorTokenClaims = {
  t: "cinatra.chat.mcp-obo";
  sub: string;
  org: string | null;
  prole: ChatMcpPlatformRole;
  scope: "mcp:connect";
  aud: string;
  iss: string;
  iat: number;
  exp: number;
};

const TOKEN_TYPE = "cinatra.chat.mcp-obo";
const TOKEN_SCOPE = "mcp:connect";
// TTL must outlast a single chat turn — the bearer is minted once per turn
// in runner.ts and OpenAI's hosted MCP relay reuses it as a static header for
// every `mcp_call` in that turn (there is no refresh path). A 60s value was
// too tight: multi-validate turns and agent-registry lookups routinely take
// 60-90s, so the final tool call landed with `exp < now` and the verifier
// fell through to OAuth, returning 401. 30 minutes comfortably outlasts any
// realistic turn while still bounding stale claims (a demoted admin / removed
// user / changed-org membership keeps the token's stale claims only this
// long). The actual authz surface is bounded server-side by
// `delegated-chat-tool-policy.ts`, not by the token TTL.
const TOKEN_TTL_SECONDS = 30 * 60;
const AUTH_BASE_PATH = "/api/auth";
const MCP_BASE_PATH = "/api/mcp";

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET. Cannot issue chat MCP actor token.",
    );
  }
  return secret;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(input: string): string {
  return createHmac("sha256", getSecret()).update(input).digest("base64url");
}

function deriveOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function issueAudience(): string {
  return getPublicMcpServerUrl() ?? getLocalMcpServerUrl(MCP_BASE_PATH);
}

function issueIssuer(): string {
  // Bind iss to the SAME origin as aud so the verifier's exact
  // origin-derived expectedIssuer matches.
  const origin = deriveOrigin(issueAudience());
  return `${origin}${AUTH_BASE_PATH}`;
}

export function issueChatMcpActorToken(input: ChatMcpActor): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: ChatMcpActorTokenClaims = {
    t: TOKEN_TYPE,
    sub: input.userId,
    org: input.orgId,
    prole: input.platformRole,
    scope: TOKEN_SCOPE,
    aud: issueAudience(),
    iss: issueIssuer(),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  return `${signingInput}.${sign(signingInput)}`;
}

function readBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function signatureMatches(
  signingInput: string,
  receivedSignature: string,
): boolean {
  try {
    const expected = Buffer.from(sign(signingInput), "base64url");
    const received = Buffer.from(receivedSignature, "base64url");
    return (
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    );
  } catch {
    return false;
  }
}

function isPlatformRole(value: unknown): value is ChatMcpPlatformRole {
  return value === "platform_admin" || value === "member";
}

export function verifyChatMcpActorToken(input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}): ChatMcpActor | null {
  try {
    const { authHeader, expectedAudience, expectedIssuer } = input;
    const token = readBearer(authHeader);
    if (!token) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    const header = parseJsonPart(encodedHeader);
    if (header?.alg !== "HS256" || header?.typ !== "JWT") return null;

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    if (!signatureMatches(signingInput, encodedSignature)) return null;

    const payload = parseJsonPart(encodedPayload);
    if (!payload) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.t !== TOKEN_TYPE) return null;
    if (payload.scope !== TOKEN_SCOPE) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (!(typeof payload.org === "string" || payload.org === null)) return null;
    if (!isPlatformRole(payload.prole)) return null;
    // Exact aud + iss binding to THIS request's canonical
    // origin (passed by the MCP transport). Membership-in-trusted-set is
    // NOT enough: it would let a token minted for the public funnel URL be
    // replayed against localhost (or another instance sharing the secret).
    if (typeof payload.aud !== "string" || payload.aud !== expectedAudience) {
      return null;
    }
    if (typeof payload.iss !== "string" || payload.iss !== expectedIssuer) {
      return null;
    }
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
      return null;
    }
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    if (payload.exp < now) return null;

    return {
      // Discriminator for the DelegatedMcpActor union — distinguishes
      // chat-OBO tokens from agent-run-OBO tokens at the MCP transport.
      // Chat tokens stay restricted to the chat tool-policy allowlist;
      // agent-run tokens are unrestricted at registration time. See
      // `src/lib/agent-run-mcp-actor-token.ts` for the matching agent
      // path and `packages/mcp-server/src/index.tsx` `DelegatedMcpActor`
      // for the union definition.
      delegation: "chat",
      userId: payload.sub,
      orgId: payload.org,
      platformRole: payload.prole,
    };
  } catch {
    return null;
  }
}

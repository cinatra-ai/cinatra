import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getLocalMcpServerUrl,
  getPublicMcpServerUrl,
} from "@cinatra-ai/mcp-server/credentials";
import {
  isOboCeilingChain,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";

// ---------------------------------------------------------------------------
// Agent-run → MCP delegated on-behalf-of (OBO) actor token.
//
// Mirrors `chat-mcp-actor-token.ts` but for the AGENT DISPATCH path. When the
// chat dispatches an agent and the agent (WayFlow Python container) calls
// `/api/llm-bridge`, the LLM the bridge invokes also gets a `type: "mcp"`
// tool reference for cinatra-mcp. Without this OBO token the cinatra-mcp
// reference uses an anonymous `client_credentials` machine bearer →
// `enforceMcpBoundary` step (2) denies with `not_org_member` because the
// machine actor has no userId / no orgId.
//
// This token carries the AGENT RUN'S identity claims (the human who
// dispatched the run + the run's org + the run id) so the MCP transport
// resolves to a real org member at boundary time. The audit log carries the
// runId so every cross-service MCP call is traceable back to the dispatching
// run.
//
// SECURITY MODEL — distinct from the chat token in three load-bearing ways:
//   1. Token type discriminator: `t = "cinatra.agent-run.mcp-obo"` (NOT
//      the chat type `cinatra.chat.mcp-obo`). The MCP transport verifier
//      MUST type-check before trusting the payload. Re-using the chat
//      token type would let a forged "agent_run" claim ride a chat-typed
//      token and inherit the chat path's `toolPolicyMode`.
//   2. `delegation: "agent_run"` discriminator on the resolved actor →
//      `toolPolicyMode: "unrestricted"` and `delegatedRestricted: false`
//      at the transport. (Chat tokens stay restricted to the chat
//      allowlist; agent runs bypass that allowlist because the agent
//      dispatcher's job is to run REAL operations, not chat-discoverable
//      reads.)
//   3. Live membership check at MINT time: even if the run's snapshot
//      claims `runBy` was a member of `runOrgId` at dispatch, mint MUST
//      re-verify membership against the LIVE `public.member` table (or
//      `user.role = 'admin'`). Otherwise a demoted user could replay a
//      stale token. This module is the verifier shape only — the live
//      check lives in the issuer at the bridge.
//
// Per-handler authz (e.g. ownership of an Apollo connector instance) is
// preserved by `enforceMcpBoundary` AND the per-handler guards. Bug A
// fixes identity propagation only; it does not add connector hardening.
// ---------------------------------------------------------------------------

export type AgentRunMcpPlatformRole = "platform_admin" | "member";

export type AgentRunMcpActor = {
  /**
   * Discriminator for the DelegatedMcpActor union. Always `"agent_run"`
   * for tokens minted/verified by this module. Distinguishes from the
   * chat-OBO branch at the MCP transport so tool-policy + audit
   * routing select the right path.
   */
  delegation: "agent_run";
  /** The run owner — the human who dispatched the run via the chat. */
  userId: string;
  /** The run's org — taken from `agent_runs.org_id`, never from session. */
  orgId: string;
  /** Run id — populated into the request store so audit logs carry it. */
  runId: string;
  /** Platform role at MINT time (live read of `public.user.role`). */
  platformRole: AgentRunMcpPlatformRole;
  /**
   * The agent's anchored scope-ceiling CHAIN. Re-derived from the run's locked
   * template anchor + project launch at mint, containment-checked against the
   * run's persisted dispatch ceiling, and — on pass — the PERSISTED chain is
   * minted into the token (the `cl` claim). A missing / malformed `cl` on an
   * agent-run token FAILS CLOSED at the verifier: the actor is never
   * reconstructed, so the caller falls back to the machine token (deny), never
   * an un-ceilinged OBO actor.
   */
  oboCeiling: OboCeilingChain;
  /**
   * The signed connector-instance pin (cinatra#2017 S2 / D6 / B1). OPTIONAL: an
   * absent pin ⇒ org scope (the governed invoker then requires an explicit
   * `instanceId`). When present it binds the token to ONE connector instance —
   * the invoker asserts `pin.connectorKey === boundConnectorKey` and derives
   * `effectiveInstanceId = input.instanceId ?? pin.instanceId` (§1.2 step 0). A
   * PRESENT-but-MALFORMED pin fails the WHOLE token closed at verify (matching the
   * `cl` treatment) — never an un-pinned reconstruction of a pinned token.
   */
  connectorInstancePin?: { connectorKey: string; instanceId: string };
  /**
   * The run's CURRENT execution attempt id at mint time (the `att` claim,
   * cinatra#1939 S3) — the stale-worker witness for the org-write run
   * authority: the mint refuses when this no longer matches the row's
   * current attempt. OPTIONAL for token validity (tokens minted before this
   * claim existed stay verifiable through their TTL), but the run authority
   * NEVER mints without it — absence just means an unstamped frame, and
   * org-write-seam writers refuse. Never widens anything.
   */
  executionAttemptId?: string;
};

type AgentRunMcpActorTokenClaims = {
  t: "cinatra.agent-run.mcp-obo";
  sub: string;
  org: string;
  run: string;
  prole: AgentRunMcpPlatformRole;
  /** Scope-ceiling chain claim — validated on verify; missing → fail closed. */
  cl: OboCeilingChain;
  /** Compact signed connector-instance pin (cinatra#2017 S2). OPTIONAL (absent ⇒
   * org scope); present-but-malformed fails the whole token closed at verify. */
  pin?: { ck: string; iid: string };
  /** Current execution attempt id (cinatra#1939 S3) — optional; see
   *  `AgentRunMcpActor.executionAttemptId` for the tolerance contract. */
  att?: string;
  scope: "mcp:connect";
  aud: string;
  iss: string;
  iat: number;
  exp: number;
};

/** A present pin claim is valid only when both `ck` (connectorKey) and `iid`
 * (instanceId) are non-blank strings; anything else is malformed → fail closed. */
function isValidPinClaim(value: unknown): value is { ck: string; iid: string } {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.ck === "string" &&
    p.ck.trim().length > 0 &&
    typeof p.iid === "string" &&
    p.iid.trim().length > 0
  );
}

export const AGENT_RUN_MCP_TOKEN_TYPE = "cinatra.agent-run.mcp-obo";
const TOKEN_SCOPE = "mcp:connect";
// Same TTL as the chat token. A single agent step can issue many MCP
// calls; OpenAI's hosted-MCP relay treats the Authorization header as
// static for the duration of the LLM step. 30 min comfortably outlasts
// any realistic step while still bounding stale-claim drift.
const TOKEN_TTL_SECONDS = 30 * 60;
const AUTH_BASE_PATH = "/api/auth";
const MCP_BASE_PATH = "/api/mcp";

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET. Cannot issue agent-run MCP actor token.",
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
  const origin = deriveOrigin(issueAudience());
  return `${origin}${AUTH_BASE_PATH}`;
}

export function issueAgentRunMcpActorToken(input: AgentRunMcpActor): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: AgentRunMcpActorTokenClaims = {
    t: AGENT_RUN_MCP_TOKEN_TYPE,
    sub: input.userId,
    org: input.orgId,
    run: input.runId,
    prole: input.platformRole,
    cl: input.oboCeiling,
    // Compact connector-instance pin (cinatra#2017 S2) — minted only when the
    // dispatch pins the run to one instance; absent ⇒ org scope.
    ...(input.connectorInstancePin
      ? {
          pin: {
            ck: input.connectorInstancePin.connectorKey,
            iid: input.connectorInstancePin.instanceId,
          },
        }
      : {}),
    ...(input.executionAttemptId ? { att: input.executionAttemptId } : {}),
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

function isPlatformRole(value: unknown): value is AgentRunMcpPlatformRole {
  return value === "platform_admin" || value === "member";
}

export function verifyAgentRunMcpActorToken(input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}): AgentRunMcpActor | null {
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
    if (payload.t !== AGENT_RUN_MCP_TOKEN_TYPE) return null;
    if (payload.scope !== TOKEN_SCOPE) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    // org is REQUIRED for agent-run tokens (unlike the chat token where
    // org may be null for org-less users) because the agent-run path is
    // explicitly org-scoped: the run row carries its org id and the
    // boundary requires `orgId` to allow membership-gated effects. A
    // missing `org` MUST fail closed.
    if (typeof payload.org !== "string" || payload.org.length === 0) return null;
    if (typeof payload.run !== "string" || payload.run.length === 0) return null;
    if (!isPlatformRole(payload.prole)) return null;
    // Scope-ceiling chain is REQUIRED on every agent-run OBO token. A missing or
    // malformed `cl` (empty array, unknown tier, blank id) FAILS CLOSED — the
    // actor is not reconstructed, so the caller falls back to the machine token
    // (denied at the boundary), never an un-ceilinged agent-run OBO actor.
    if (!isOboCeilingChain(payload.cl)) return null;
    // Connector-instance pin (cinatra#2017 S2 / B1): OPTIONAL (absent ⇒ org
    // scope). A PRESENT-but-MALFORMED pin fails the WHOLE token closed — never
    // reconstruct a pinned token as un-pinned (matching the `cl` treatment).
    const pinClaim: unknown = payload.pin;
    if (pinClaim !== undefined && !isValidPinClaim(pinClaim)) return null;
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
      delegation: "agent_run",
      userId: payload.sub,
      orgId: payload.org,
      runId: payload.run,
      platformRole: payload.prole,
      oboCeiling: payload.cl,
      // Surface the validated pin (cinatra#2017 S2); absent ⇒ no pin (org scope).
      ...(isValidPinClaim(pinClaim)
        ? {
            connectorInstancePin: {
              connectorKey: pinClaim.ck,
              instanceId: pinClaim.iid,
            },
          }
        : {}),
      // `att` is tolerated-absent (pre-claim tokens stay valid through their
      // TTL); a non-string/empty value reads as absent — the org-write run
      // mint then simply never fires for this frame. Fail-closed downstream,
      // never here.
      ...(typeof payload.att === "string" && payload.att.length > 0
        ? { executionAttemptId: payload.att }
        : {}),
    };
  } catch {
    return null;
  }
}

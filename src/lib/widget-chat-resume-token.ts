import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Public-site widget → assistant-run RESUME token (S5 follow-up, cinatra#1221).
//
// S5 moved the WordPress/Drupal public-site widget off the bespoke
// `/api/agents/{slug}/stream` relay onto the unified AG-UI assistant runtime
// (`POST /api/assistants/chat`) under broker auth. That turn streams over a
// durable Redis-Streams log; on a mid-run transport DROP the embedded chat
// reconnects to the AG-UI resume/tail route
// (`GET /api/assistants/runs/{runId}/stream`) with its cached `Last-Event-ID`.
//
// The resume route is SESSION-ONLY today — a cross-origin broker-auth widget
// has no Cinatra cookie, so it could not resume. The W3 design (§9.3) posed the
// audience question as a GATING decision, and the OWNER RULING (issue #1221,
// 2026-07-19) chose OPTION A: a DISTINCT, short-lived, RUN-BOUND resume token
// with its OWN audience — NOT the chat-audience broker token, which is REJECTED
// at the resume endpoint (option B, audience-widening, was rejected).
//
// This module is that token. It MIRRORS `widget-mcp-actor-token.ts` exactly (the
// merged #1848 mint/verify pattern): a DISTINCT token type, every claim required
// and fail-closed, the TTL bound AT VERIFY, a per-run `jti`, the platform-admin
// floor imposed at verify, and the SAME HMAC family/secret (`BETTER_AUTH_SECRET`)
// — no new secret. Load-bearing differences from the chat/mcp tokens:
//
//   1. Token type discriminator `t = "cinatra.widget.chat-resume"` (NOT the chat
//      broker token, NOT the mcp-obo type). The resume seam MUST type-check
//      before trusting the payload; a chat/mcp/agent-run token presented here
//      returns `null` (cross-type forgery, both directions).
//   2. `run` (the specific AG-UI runId) is REQUIRED and FAIL-CLOSED, and the
//      verifier binds it to the EXACT run being resumed (`expectedRunId`). A
//      token minted for run A can never tail run B's log — run-binding is the
//      core containment property the ruling demands.
//   3. `inst` (server-derived canonical instanceId) and `knd` (assistant/
//      connector KIND) are REQUIRED and FAIL-CLOSED — the SAME server-verified
//      values that ride the OBO token, carried so the resume actor is pinned to
//      the same instance + kind the turn authorized (never re-derived from a
//      forgeable field).
//   4. `prole` is DELIBERATELY OMITTED — the verifier hard-codes
//      `platformRole: "member"`. A widget user is NEVER `platform_admin` at any
//      boundary; the member floor is inherited from the mcp-obo token's mint-time
//      suppression (G5).
//   5. Its OWN audience — `WIDGET_CHAT_RESUME_ROUTE_PATH` (the resume route),
//      DISTINCT from the chat broker token's `/api/assistants/chat` audience.
//      This is precisely option A: the resume endpoint keeps its own audience;
//      the chat-audience token is not accepted here.
//   6. SHORT TTL (600 s) bound AT VERIFY. The token is minted at TURN START and
//      is only useful for the ONE-SHOT reconnect DURING or right after the run;
//      600 s comfortably covers a long assistant turn (LLM + CMS dispatch) plus a
//      transport-drop reconnect grace, while sitting far under the chat token's
//      30 min and the durable log's 1 h terminal TTL. A per-run `jti` is carried
//      for any future replay dedup; the short TTL bounds the residual window.
//
// `aud`/`iss` are route-path/issuer constants shared by mint and verify (they can
// never drift). The HMAC is IDENTICAL to the chat/mcp tokens (no new secret).
// This module is the token shape only; the resume seam owns run resolution +
// acceptance, and the broker-auth turn owns the mint.
// ---------------------------------------------------------------------------

/** The assistant/connector kind a resume token is bound to. */
export type WidgetChatResumeConnectorKind = "wordpress" | "drupal";

export type WidgetChatResumeActor = {
  /**
   * Discriminator — always `"public_site_widget"` for tokens minted/verified by
   * this module (the same delegation family as the mcp-obo token).
   */
  delegation: "public_site_widget";
  /** The authenticated end user (cwu_ claim), never session-derived. */
  userId: string;
  /** The end user's org (cwu_ claim). REQUIRED — the widget path is org-scoped. */
  orgId: string;
  /** SERVER-DERIVED canonical instance id (the verified-origin re-pin). */
  instanceId: string;
  /** The connector KIND (`knd` claim). Binds the token to its widget surface. */
  kind: WidgetChatResumeConnectorKind;
  /**
   * The AG-UI runId this token authorizes resuming. The verifier binds it to the
   * EXACT run being tailed (fail-closed) so a token can never tail another run.
   */
  runId: string;
  /** Per-run nonce (carried for future replay dedup; the short TTL bounds it). */
  jti: string;
  /**
   * ALWAYS `"member"` — hard-coded by the verifier because the token omits
   * `prole`. A widget user is NEVER `platform_admin` at the resume boundary.
   */
  platformRole: "member";
};

/**
 * The server-built inputs the broker-auth turn feeds the issuer. `platformRole`
 * is intentionally NOT an input — it is floored to `"member"` at mint by OMITTING
 * `prole` from the token entirely (there is no way to mint a platform-admin
 * resume token).
 */
export type WidgetChatResumeTokenInput = {
  userId: string;
  orgId: string;
  instanceId: string;
  kind: WidgetChatResumeConnectorKind;
  runId: string;
  jti: string;
};

type WidgetChatResumeTokenClaims = {
  t: "cinatra.widget.chat-resume";
  sub: string; // userId
  org: string; // orgId — REQUIRED (widget path is org-scoped)
  inst: string; // pinned canonical instanceId — REQUIRED, fail-closed
  knd: WidgetChatResumeConnectorKind; // connector KIND — REQUIRED, fail-closed
  run: string; // the bound AG-UI runId — REQUIRED, fail-closed
  src: "public_site_widget"; // fixed discriminator
  jti: string; // per-run nonce
  scope: "chat:resume";
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  // NOTE: `prole` is deliberately ABSENT — floored to "member" at verify.
};

export const WIDGET_CHAT_RESUME_TOKEN_TYPE = "cinatra.widget.chat-resume";
const TOKEN_SCOPE = "chat:resume";
const TOKEN_SOURCE = "public_site_widget";
// SHORT TTL — the resume token is minted at TURN START and is only useful for
// the ONE-SHOT reconnect during/just-after the run. 600 s covers a long
// assistant turn plus a transport-drop reconnect grace while sitting far under
// the chat token's 30 min and the durable log's 1 h terminal TTL. Bound AT
// VERIFY (below) so a signed token with a stretched lifetime is still rejected.
const TOKEN_TTL_SECONDS = 600;

/**
 * The resume route — the resume token's OWN audience, DISTINCT from the chat
 * broker token's `/api/assistants/chat` audience (option A). `[runId]` is the
 * Next.js route-segment template; the SPECIFIC run is bound by the `run` claim,
 * not the audience, so the audience stays a stable per-endpoint constant (the
 * same route-path-as-audience model the cit_/cwu_ broker tokens use).
 */
export const WIDGET_CHAT_RESUME_ROUTE_PATH =
  "/api/assistants/runs/[runId]/stream";
/** Fixed issuer — shared by mint + verify (exact-match; can never drift). */
const WIDGET_CHAT_RESUME_ISSUER = "cinatra:widget-chat-resume";

/**
 * The response header the broker-auth turn sets to DELIVER a freshly-minted
 * resume token to the embedded client. The client (Lane B embed) reads it and
 * PRESENTS it back on the resume GET's `Authorization: Bearer` header. The turn
 * POST is over an authenticated (cit_/cwu_) request, so the delivery ride is
 * already access-controlled.
 */
export const WIDGET_CHAT_RESUME_TOKEN_HEADER = "X-Cinatra-Chat-Resume-Token";

const CONNECTOR_KINDS = new Set<WidgetChatResumeConnectorKind>([
  "wordpress",
  "drupal",
]);

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET. Cannot issue widget chat-resume token.",
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

export function issueWidgetChatResumeToken(
  input: WidgetChatResumeTokenInput,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: WidgetChatResumeTokenClaims = {
    t: WIDGET_CHAT_RESUME_TOKEN_TYPE,
    sub: input.userId,
    org: input.orgId,
    inst: input.instanceId,
    knd: input.kind,
    run: input.runId,
    src: TOKEN_SOURCE,
    jti: input.jti,
    scope: TOKEN_SCOPE,
    aud: WIDGET_CHAT_RESUME_ROUTE_PATH,
    iss: WIDGET_CHAT_RESUME_ISSUER,
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
    // Compare the CANONICAL base64url ENCODING (not the decoded bytes): base64url
    // decoding is lenient (trailing `=`, whitespace, or a stray non-alphabet
    // character all decode to the SAME bytes), so a byte-compare would accept a
    // non-canonical re-encoding of a valid signature. The exact-encoding compare
    // fails closed on signature malleability and keeps the token string canonical
    // for any future jti/token-string replay dedup. timingSafeEqual requires
    // equal lengths; a mismatched length is an immediate reject.
    const expected = Buffer.from(sign(signingInput), "utf8");
    const received = Buffer.from(receivedSignature, "utf8");
    return (
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    );
  } catch {
    return false;
  }
}

/** A REQUIRED string claim: present, a string, and non-blank AFTER trimming (a
 *  whitespace-only identity/instance/run/nonce is treated as absent — fail
 *  closed). The widget ids are opaque tokens with no legitimate whitespace. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConnectorKind(
  value: unknown,
): value is WidgetChatResumeConnectorKind {
  return (
    typeof value === "string" &&
    CONNECTOR_KINDS.has(value as WidgetChatResumeConnectorKind)
  );
}

/**
 * Verify a resume token presented on the resume GET's `Authorization` header,
 * BINDING it to the exact run being tailed. Returns the resolved actor, or
 * `null` on ANY failure (fail-closed — the caller returns 401/409 and NEVER
 * falls through to a silent fresh mount).
 *
 * `expectedRunId` is the decoded runId of the resume route being hit; the token
 * MUST have been minted for exactly that run (`run === expectedRunId`).
 */
export function verifyWidgetChatResumeToken(input: {
  authHeader: string | null;
  expectedRunId: string;
}): WidgetChatResumeActor | null {
  try {
    const { authHeader, expectedRunId } = input;
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
    // Type + scope + source discriminators — the cross-type gate. A chat broker
    // token, an mcp-obo token, or an agent-run token all fail here (they carry a
    // different `t`), so the chat-audience token is REJECTED at the resume seam.
    if (payload.t !== WIDGET_CHAT_RESUME_TOKEN_TYPE) return null;
    if (payload.scope !== TOKEN_SCOPE) return null;
    if (payload.src !== TOKEN_SOURCE) return null;
    if (!isNonBlankString(payload.sub)) return null;
    // org is REQUIRED — the widget path is strictly org-scoped.
    if (!isNonBlankString(payload.org)) return null;
    // inst is REQUIRED and FAIL-CLOSED — the server-verified origin re-pin can
    // never be lost into an un-pinned resume actor. Whitespace-only is blank.
    if (!isNonBlankString(payload.inst)) return null;
    // knd is REQUIRED and FAIL-CLOSED — binds the token to its widget surface.
    if (!isConnectorKind(payload.knd)) return null;
    // run is REQUIRED and FAIL-CLOSED, and BOUND to the exact run being tailed.
    // A missing/blank run, or a token minted for a DIFFERENT run, is rejected —
    // cross-run replay can never tail another run's durable log.
    if (!isNonBlankString(payload.run)) return null;
    if (payload.run !== expectedRunId) return null;
    // jti is REQUIRED (carried for future replay dedup). Blank fails closed.
    if (!isNonBlankString(payload.jti)) return null;
    // Exact aud + iss binding — this token is for the RESUME route only, not the
    // chat turn route. A token minted for a different audience/issuer is rejected.
    if (typeof payload.aud !== "string" || payload.aud !== WIDGET_CHAT_RESUME_ROUTE_PATH) {
      return null;
    }
    if (typeof payload.iss !== "string" || payload.iss !== WIDGET_CHAT_RESUME_ISSUER) {
      return null;
    }
    if (typeof payload.iat !== "number" || !Number.isInteger(payload.iat)) {
      return null;
    }
    if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
      return null;
    }
    // Never accept a future-dated token (iat = mint second; issuer never mints
    // one in the future) — fail closed on a not-yet-valid token.
    if (payload.iat > now) return null;
    // Bind the SHORT TTL AT VERIFY, not merely by trusting the issuer: a
    // validly-signed token whose lifetime is NOT exactly the resume TTL is
    // rejected. This never rejects a legitimately-minted token (the issuer always
    // mints `exp = iat + TOKEN_TTL_SECONDS`); it fails closed on any signed token
    // — e.g. one minted under a compromised secret with a stretched lifetime —
    // that tries to widen the reconnect window.
    if (payload.exp - payload.iat !== TOKEN_TTL_SECONDS) return null;
    // Expired AT or after `exp` (RFC 7519: current time MUST be BEFORE exp). `<=`
    // closes the exact-expiry-second boundary a `<` would leave open.
    if (payload.exp <= now) return null;

    return {
      delegation: "public_site_widget",
      userId: payload.sub,
      orgId: payload.org,
      instanceId: payload.inst,
      kind: payload.knd,
      runId: payload.run,
      jti: payload.jti,
      // Floored at mint: the token omits `prole`, so a widget user is ALWAYS
      // resolved as `member` here — never `platform_admin` at the boundary.
      platformRole: "member",
    };
  } catch {
    return null;
  }
}

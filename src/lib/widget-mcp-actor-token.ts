import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getLocalMcpServerUrl,
  getPublicMcpServerUrl,
} from "@cinatra-ai/mcp-server/credentials";

// ---------------------------------------------------------------------------
// Public-site widget → MCP delegated on-behalf-of (OBO) actor token.
//
// S5 moves the WordPress/Drupal public-site widget off the bespoke
// `/api/agents/{slug}/stream` relay onto the unified AG-UI assistant runtime
// (`POST /api/assistants/chat`). That runtime drives an LLM turn whose
// wordpress/drupal persona calls the `*_content_editor_run` MCP tool; the CMS
// write reaches the connector through the MCP boundary. To preserve — with NO
// privilege widening — every guarantee the OLD route-as-orchestrator relay
// carried, the write must authorize AS THE END USER against the CORRECT
// (server-origin-pinned) instance. This module mints the token that carries
// those server-verified values across the hosted-MCP boundary.
//
// SECURITY MODEL — a DISTINCT token type is mandatory (same rationale as the
// agent-run token): reusing the chat type would let a forged widget claim
// inherit the chat path's broad tool policy, or a chat token skip the instance
// pin. Load-bearing differences from the chat token:
//
//   1. Token type discriminator `t = "cinatra.widget.mcp-obo"` (NOT the chat
//      type). The MCP transport verifier MUST type-check before trusting the
//      payload.
//   2. `delegation: "public_site_widget"` on the resolved actor → a dedicated
//      CLOSED, kind-keyed `delegated-widget` tool policy at the transport (NOT
//      the chat allowlist), capping a leaked token's blast radius to the one
//      CMS-edit primitive for its bound kind (G12).
//   3. `inst` (server-derived canonical instanceId) is REQUIRED and FAIL-CLOSED
//      — a missing/blank `inst` returns `null` from the verifier so the caller
//      falls back to the machine token (denied at the boundary), never an
//      un-pinned OBO actor. This re-imposes the OLD route's origin re-pin
//      across the model-chosen-instance seam (G2/G3).
//   4. `knd` (assistant/connector KIND) is REQUIRED and FAIL-CLOSED — binds the
//      token to `wordpress` | `drupal`; a `wordpress` token can never drive a
//      `drupal_content_editor_run` and vice versa (G9).
//   5. `prole` is DELIBERATELY OMITTED — the verifier hard-codes
//      `platformRole: "member"` on the resolved actor. A widget user is NEVER
//      `platform_admin` at the boundary; the platform-admin short-circuit is
//      suppressed at MINT time (defense-in-depth to the hop-1 belt-and-braces
//      `platform_admin_on_public_widget` deny) (G5).
//   6. SHORT TTL (120 s) + a per-turn `jti`. The widget turn is a SINGLE
//      blocking CMS-edit dispatch, not a 60-90 s multi-validate chat turn, so
//      the chat token's 30 min is far too loose for a cross-origin public
//      surface. Strict per-CALL single-use is INCOMPATIBLE with the hosted-MCP
//      relay (OpenAI/Anthropic reuse the Authorization header as a static value
//      for every `mcp_call` in the step), so binding to the turn — not per-call
//      burn — is the correct containment shape (G12).
//   7. THE TWO SEALS (cinatra#2687), REQUIRED and FAIL-CLOSED at verify:
//        · `pjti` — the `jti` of the `cwu_` widget token whose sign-in this
//          turn ran under. A credential derived from a sign-in must not outlive
//          that sign-in, so the token NAMES the row it came from.
//        · `run`  — the AG-UI run id of the turn that minted it. This is what
//          makes the token turn-bound in fact and not only in intent: until
//          #2687 the `jti` was carried and returned but nothing ever compared
//          it to anything, so the token worked for its whole 120 s including
//          after the turn had finished and after the user had signed out.
//      This module only PARSES both. The store reads that decide "is that
//      sign-in still there" and "is that turn still running" live one layer up
//      (`src/lib/widget-mcp-actor-authorization.ts`), exactly as the resume
//      token's parent check lives in its route (#2684) — this stays a pure
//      signing leaf with no database edge.
//
// `aud`/`iss` and the `BETTER_AUTH_SECRET` HMAC are IDENTICAL to the chat token
// (no new secret). Per-instance write authority + live-membership re-checks are
// preserved downstream by the MCP boundary and per-handler guards — this module
// is the token shape only.
// ---------------------------------------------------------------------------

/** The assistant/connector kind a widget token is bound to. */
export type WidgetMcpConnectorKind = "wordpress" | "drupal";

export type WidgetMcpActor = {
  /**
   * Discriminator for the DelegatedMcpActor union. Always
   * `"public_site_widget"` for tokens minted/verified by this module. The
   * matching branch lives in `packages/mcp-server/src/request-context.ts`.
   */
  delegation: "public_site_widget";
  /** The authenticated end user (cwu_ claim), never session-derived. */
  userId: string;
  /** The end user's org (cwu_ claim). REQUIRED — the widget path is org-scoped. */
  orgId: string;
  /**
   * The SERVER-DERIVED canonical instance id (the verified-origin re-pin). The
   * boundary asserts the model-supplied `content_editor_run` `instanceId` arg
   * equals THIS value (fail-closed `instance_pin_mismatch`) so a prompt-injected
   * page can't retarget a different origin-matched instance in the same org.
   */
  instanceId: string;
  /** The connector KIND (`knd` claim). Binds the token to its editor primitive. */
  kind: WidgetMcpConnectorKind;
  /**
   * Per-turn nonce (`jti`). Distinguishes two tokens minted for the same turn
   * and is the audit handle in the boundary's logs. It is NOT the turn binding —
   * `turnRunId` is, and mistaking the nonce for the binding is precisely the
   * defect #2687 closes.
   */
  jti: string;
  /**
   * THE PARENT `cwu_` TOKEN'S OWN `jti` (`pjti`, cinatra#2687). This token is
   * derived from one widget-token row; the authorization layer asks whether that
   * row's Better Auth session is still signed in before the token authorizes
   * anything, through the same predicate every other widget verifier uses.
   */
  parentJti: string;
  /**
   * THE AG-UI RUN ID OF THE TURN THAT MINTED IT (`run`, cinatra#2687). The
   * authorization layer refuses unless that turn is still running, so a token
   * whose turn has completed is dead inside its own 120 seconds.
   */
  turnRunId: string;
  /**
   * ALWAYS `"member"` — hard-coded by the verifier because the token omits
   * `prole`. A widget user is NEVER `platform_admin` at the boundary; this
   * union-narrowed literal makes the `mcp-boundary` immediate-allow for
   * platform admins un-triggerable for a widget delegation.
   */
  platformRole: "member";
  /**
   * Did the `cwu_` that authorized THIS turn carry the `lifecycle.read` grant
   * (cinatra#2577, epic #2564 S8d)? Minted as `lcr: true` ONLY when the route's
   * consumed user token already granted it; ABSENT otherwise, and the verifier
   * reads an absent claim as `false`. FAIL-CLOSED in every direction: a token
   * minted before the grant existed, a session whose consent predates it, and a
   * tampered claim of any other shape all resolve to `false`.
   *
   * It is a CLAIM rather than a second consume because the `cwu_` bearer does
   * not cross the MCP boundary — the widget OBO token does, and it is
   * turn-bound, 120 s-lived and signed, which is the same carrier the instance
   * pin and the connector kind already ride. The lifecycle handlers treat it as
   * the GRANT only; the actor and the per-row access check are still resolved
   * live against the reader's real standing.
   */
  lifecycleRead: boolean;
};

/**
 * The server-built inputs the seam feeds the issuer. `platformRole` is
 * intentionally NOT an input — it is floored to `"member"` at mint by OMITTING
 * `prole` from the token entirely (there is no way to mint a platform-admin
 * widget token).
 */
export type WidgetMcpActorTokenInput = {
  userId: string;
  orgId: string;
  instanceId: string;
  kind: WidgetMcpConnectorKind;
  jti: string;
  /** The `jti` of the `cwu_` widget token that authenticated the turn (#2687). */
  parentJti: string;
  /** The AG-UI run id of the turn this token is minted for (#2687). */
  turnRunId: string;
  /**
   * cinatra#2577 (S8d) — mint the `lcr` grant claim. The caller passes the
   * answer it already has (the consumed `cwu_`'s granted scopes); omitting it
   * mints no claim, which reads back as "no lifecycle grant".
   */
  lifecycleRead?: boolean;
};

type WidgetMcpActorTokenClaims = {
  t: "cinatra.widget.mcp-obo";
  sub: string; // userId
  org: string; // orgId — REQUIRED (widget path is org-scoped)
  inst: string; // pinned canonical instanceId — REQUIRED, fail-closed
  knd: WidgetMcpConnectorKind; // connector KIND — REQUIRED, fail-closed
  src: "public_site_widget"; // fixed discriminator
  jti: string; // per-turn nonce (audit handle)
  pjti: string; // the parent cwu_ token's jti — the revocation handle (#2687)
  run: string; // the minting turn's AG-UI run id — the turn seal (#2687)
  /**
   * cinatra#2577 (S8d) — the `lifecycle.read` grant the authorizing `cwu_`
   * carried. OPTIONAL and only ever minted as the literal `true`; absent means
   * no grant, and the verifier accepts nothing else (so a `"true"` string or a
   * `1` from a tampered payload reads as absent → no grant).
   */
  lcr?: true;
  scope: "mcp:connect";
  aud: string;
  iss: string;
  iat: number;
  exp: number;
  // NOTE: `prole` is deliberately ABSENT — floored to "member" at verify.
};

export const WIDGET_MCP_TOKEN_TYPE = "cinatra.widget.mcp-obo";
const TOKEN_SCOPE = "mcp:connect";
const TOKEN_SOURCE = "public_site_widget";
// SHORT TTL — a widget turn is a SINGLE blocking CMS-edit dispatch (plus its
// intra-turn reads), not a multi-validate chat turn. 120 s comfortably outlasts
// one blocking dispatch while sitting well under any human-review pause; it
// bounds the replay window of a leaked token on a cross-origin public surface
// far tighter than the chat token's 30 min. The `run` seal (checked against the
// live turn, #2687) contains replay WITHIN the window; the short TTL bounds what
// the seal cannot — the stretch between the relay's last call and the commit of
// the turn's terminal status.
const TOKEN_TTL_SECONDS = 120;
const AUTH_BASE_PATH = "/api/auth";
const MCP_BASE_PATH = "/api/mcp";

const CONNECTOR_KINDS = new Set<WidgetMcpConnectorKind>(["wordpress", "drupal"]);

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET. Cannot issue widget MCP actor token.",
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
  // Identical to the chat token — the widget OBO token's audience (the MCP URL)
  // is UNCHANGED. Only the broker (cit_/cwu_) token audience moves in S5.
  return getPublicMcpServerUrl() ?? getLocalMcpServerUrl(MCP_BASE_PATH);
}

function issueIssuer(): string {
  const origin = deriveOrigin(issueAudience());
  return `${origin}${AUTH_BASE_PATH}`;
}

export function issueWidgetMcpActorToken(input: WidgetMcpActorTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: WidgetMcpActorTokenClaims = {
    t: WIDGET_MCP_TOKEN_TYPE,
    sub: input.userId,
    org: input.orgId,
    inst: input.instanceId,
    knd: input.kind,
    src: TOKEN_SOURCE,
    jti: input.jti,
    pjti: input.parentJti,
    run: input.turnRunId,
    // Minted ONLY when the grant is genuinely held — never `lcr: false`, so the
    // "no grant" token is byte-identical to a pre-S8d one and the absent claim
    // is the single fail-closed reading of it.
    ...(input.lifecycleRead === true ? { lcr: true as const } : {}),
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
    // Compare the CANONICAL base64url ENCODING (not the decoded bytes): base64url
    // decoding is lenient (trailing `=`, whitespace, or a stray non-alphabet
    // character all decode to the SAME bytes), so a byte-compare would accept a
    // non-canonical re-encoding of a valid signature. That is not a forgery risk
    // on its own (an attacker must already possess a valid signature), but the
    // exact-encoding compare fails closed on signature malleability and keeps the
    // token string canonical for any future jti/token-string replay dedup.
    // timingSafeEqual requires equal lengths; a mismatched length is an
    // immediate reject.
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
 *  whitespace-only identity/instance/nonce is treated as absent — fail closed).
 *  The widget ids are opaque tokens with no legitimate surrounding whitespace. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConnectorKind(value: unknown): value is WidgetMcpConnectorKind {
  return (
    typeof value === "string" &&
    CONNECTOR_KINDS.has(value as WidgetMcpConnectorKind)
  );
}

export function verifyWidgetMcpActorToken(input: {
  authHeader: string | null;
  request: Request;
  expectedAudience: string;
  expectedIssuer: string;
}): WidgetMcpActor | null {
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
    if (payload.t !== WIDGET_MCP_TOKEN_TYPE) return null;
    if (payload.scope !== TOKEN_SCOPE) return null;
    if (payload.src !== TOKEN_SOURCE) return null;
    if (!isNonBlankString(payload.sub)) return null;
    // org is REQUIRED — the widget path is strictly org-scoped (the CMS write
    // is membership-gated). A missing/blank `org` MUST fail closed.
    if (!isNonBlankString(payload.org)) return null;
    // inst is REQUIRED and FAIL-CLOSED — a missing/blank pinned instance means
    // the origin re-pin was lost; reconstruct nothing so the caller falls back
    // to the machine token (denied). This is the server-verified-origin pin
    // that closes the model-chosen-instance loosening (G2/G3). Whitespace-only
    // is treated as blank.
    if (!isNonBlankString(payload.inst)) return null;
    // knd is REQUIRED and FAIL-CLOSED — binds the token to its connector kind so
    // a wordpress token can never drive a drupal editor primitive (G9).
    if (!isConnectorKind(payload.knd)) return null;
    // jti is REQUIRED — the per-turn nonce (audit handle). A missing/blank/
    // whitespace-only nonce fails closed.
    if (!isNonBlankString(payload.jti)) return null;
    // pjti is REQUIRED and FAIL-CLOSED (cinatra#2687) — it names the `cwu_` row
    // this token was derived from, and without it the authorization layer has
    // nothing to ask about. A token minted before this shipped carries none and
    // is refused; its 120-second life bounds that entirely.
    if (!isNonBlankString(payload.pjti)) return null;
    // run is REQUIRED and FAIL-CLOSED (cinatra#2687) — the turn seal. A token
    // that names no turn cannot be turn-bound by anybody downstream, so it never
    // resolves an actor at all rather than resolving one nothing can check.
    if (!isNonBlankString(payload.run)) return null;
    // Exact aud + iss binding to THIS request's canonical origin (passed by the
    // MCP transport). Membership-in-trusted-set is NOT enough: it would let a
    // token minted for the public funnel URL be replayed against localhost (or
    // another instance sharing the secret).
    if (typeof payload.aud !== "string" || payload.aud !== expectedAudience) {
      return null;
    }
    if (typeof payload.iss !== "string" || payload.iss !== expectedIssuer) {
      return null;
    }
    if (typeof payload.iat !== "number" || !Number.isInteger(payload.iat)) {
      return null;
    }
    if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
      return null;
    }
    // A widget token is NEVER future-dated by the issuer (iat = mint second);
    // reject one that is — fail closed, never accept a not-yet-valid token.
    if (payload.iat > now) return null;
    // Enforce the 120 s lifetime AT VERIFY, not merely by trusting the issuer.
    // The short TTL is a load-bearing replay-containment property on this
    // cross-origin PUBLIC surface, so the verifier binds it: a
    // validly-signed token whose lifetime is NOT exactly the widget TTL is
    // rejected. This can never reject a legitimately-minted token (the issuer
    // always mints `exp = iat + TOKEN_TTL_SECONDS`); it fails closed on any
    // signed token — e.g. one minted under a compromised secret with a
    // stretched lifetime — that tries to widen the replay window.
    if (payload.exp - payload.iat !== TOKEN_TTL_SECONDS) return null;
    // Expired AT or after `exp` (RFC 7519: the current time MUST be BEFORE exp).
    // `<=` closes the exact-expiry-second boundary a `<` would leave open.
    if (payload.exp <= now) return null;

    return {
      delegation: "public_site_widget",
      userId: payload.sub,
      orgId: payload.org,
      instanceId: payload.inst,
      kind: payload.knd,
      jti: payload.jti,
      parentJti: payload.pjti,
      turnRunId: payload.run,
      // Floored at mint: the token omits `prole`, so a widget user is ALWAYS
      // resolved as `member` here — never `platform_admin` at the boundary.
      platformRole: "member",
      // STRICT `=== true`: an absent claim, and any other shape a tampered or
      // older payload could carry, resolve to NO grant (cinatra#2577).
      lifecycleRead: payload.lcr === true,
    };
  } catch {
    return null;
  }
}

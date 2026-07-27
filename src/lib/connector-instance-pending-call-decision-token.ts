import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Connector-instance PENDING-CALL DECISION token (S5 destructive-confirmation,
// cinatra#2020, PR-2).
//
// When a destructive connector-instance tool call is parked pending the user's
// explicit confirmation (D2/D3), the server read that RENDERS the confirmation
// card mints this short-lived signed token — one per action family per row — and
// the chat server action (`decidePendingToolCall`, PR-4) presents it back when
// the user clicks Confirm / Deny / Cancel. It is HONESTLY a served-card
// CSRF-style nonce layered ON TOP of the live session + row-ownership checks —
// never a session substitute. What it adds over session+ownership alone:
//
//   (a) the decide action only works from a client the server actually SERVED
//       this card to, IN THIS SESSION (`sid`), FOR THIS ACTION (`act`) — injected
//       page content, a stray extension, or a cross-user script cannot decide a
//       row it was never served;
//   (b) it survives audit as an explicit "the card was rendered before the
//       decision" proof.
//
// SINGLE-USE is DB-CONSUME-BACKED (the pending-call row's `pending → executing`
// CAS, PR-4), NOT token-state-backed: per S5 grounding, signed tokens here are
// REPLAYABLE within their TTL BY DESIGN and the row CONSUME is the actual
// single-use edge (a replay after terminality returns the recorded outcome, no
// second execution). `jti` is carried only for parity / any future replay dedup.
//
// This module MIRRORS `widget-chat-resume-token.ts` (the merged #1848/#1855
// mint/verify family) exactly: the SAME HMAC family/secret (`BETTER_AUTH_SECRET`)
// — no new secret; a compact `<header>.<payload>.<sig>` HS256 form; EVERY claim
// REQUIRED and FAIL-CLOSED; the TTL bound AT VERIFY; `timingSafeEqual` +
// canonical-encoding signature compare. Load-bearing differences from the resume
// token (each a deliberate S5 requirement, §4.1):
//
//   1. Token type discriminator `t = "cinatra.connector-instance.pending-call-
//      decision"` (NOT the chat / mcp-obo / widget-resume / agent-run type). The
//      decide seam MUST type-check before trusting the payload; a foreign token
//      presented here verifies to `null` (cross-type forgery, both directions).
//   2. `pc` (the specific pendingCallId) is REQUIRED and FAIL-CLOSED, and the
//      verifier BINDS it to the EXACT row being decided (`expectedPendingCallId`)
//      — a token minted to decide call A can NEVER decide call B (the run-binding
//      analog; the core containment property).
//   3. `act` (`"confirm"` | `"reject"`) is REQUIRED and BOUND at verify. The
//      card read mints TWO tokens per row — one per button family — so a
//      reject-token can NEVER confirm and a confirm-token can NEVER reject; this
//      closes the action-confusion class (a UI bug that turned Deny into Confirm
//      is structurally impossible). `deny` and `cancel` are both `reject`-family
//      (the ONE exported mapping, `pendingCallDecisionActForAction`).
//   4. `sid` (the live better-auth session id at mint) is REQUIRED and BOUND at
//      verify to the CURRENT session — a token exfiltrated from one device is
//      useless on another even for the SAME user.
//   5. `sub` (userId) and `org` (orgId) are REQUIRED and BOUND at verify — the
//      requester + org-ownership binding (the caller additionally re-reads the
//      row and asserts `row.user_id`/`row.org_id`, PR-4 §4.2 step 3; this token
//      binding is the served-card layer on top of that).
//   6. Its OWN audience + issuer constants, exact-matched and fail-closed.
//   7. SHORT TTL (600 s) bound AT VERIFY. A stale card just re-reads and re-mints
//      (§6.1); 600 s comfortably covers the decide round-trip while bounding the
//      replay window under the row CAS.
//   8. It is presented as a SERVER-ACTION ARGUMENT, not on an HTTP
//      `Authorization` header (the resume token's channel), so `verify` takes the
//      token STRING directly. `jti` is SELF-GENERATED here (there is no external
//      per-run nonce as the resume token has); the row CONSUME, not the jti, is
//      the single-use edge.
//
// Session LIVENESS is the CALLER's responsibility (`requireAuthSession`, PR-4
// §4.2 step 1); this module binds the token to the session id the caller passes
// as `expectedSessionId`. The module is the token shape ONLY — no store, no
// invoker, no consumer imports (PR-4 owns those); it depends solely on node
// builtins + `server-only`.
//
// The module MATCHES the `src/lib/**/*token*.ts` high-risk glob DELIBERATELY: it
// IS a new signed-token surface, so it keeps the honest `*-token.ts` name and
// ships human-gated. Naming it around the glob would be exactly the evasion class
// the gate-suite record closed.
// ---------------------------------------------------------------------------

/**
 * The action FAMILY a decision token authorizes. The card mints one token per
 * family; `confirm` executes the parked call, `reject` terminates it negatively
 * (both `deny` and `cancel` map here — see `pendingCallDecisionActForAction`).
 */
export type PendingCallDecisionAct = "confirm" | "reject";

/**
 * The concrete decision a user takes on the card. `confirm` executes; `deny` and
 * `cancel` are both negative-terminal under the SAME (`reject`) token authority.
 */
export type PendingCallDecisionAction = "confirm" | "deny" | "cancel";

/**
 * The ONE mapping from a concrete decision action to its token action family
 * (§4.1). Exported so the card-mint site and the decide server action share a
 * single source of truth: a reject-family token authorizes BOTH `deny` and
 * `cancel`, and can NEVER authorize `confirm`.
 */
export function pendingCallDecisionActForAction(
  action: PendingCallDecisionAction,
): PendingCallDecisionAct {
  if (action === "confirm") return "confirm";
  if (action === "deny" || action === "cancel") return "reject";
  // Runtime-exhaustive + fail-closed: `expectedAction` reaches the verifier from
  // a server-action argument (runtime data the type system cannot enforce), so an
  // unknown / future action must NEVER silently collapse to `reject` — that would
  // let a reject-family token decide an action it was not minted for. The throw
  // is caught by `verifyPendingCallDecisionToken` and surfaces as `null`
  // (fail-closed); a direct caller sees the programming error instead.
  throw new Error(
    `Unknown pending-call decision action: ${String(action)}`,
  );
}

/** The server-built inputs the card read feeds the issuer (one call per `act`). */
export type PendingCallDecisionTokenInput = {
  /** The pending-call row id this token may decide (`pc` claim). */
  pendingCallId: string;
  /** The requesting user — the ONLY user who may decide the row (`sub` claim). */
  userId: string;
  /** The requester's org (`org` claim). */
  orgId: string;
  /** The live better-auth session id at mint (`sid` claim). */
  sessionId: string;
  /** Which button family this token authorizes (`act` claim). */
  act: PendingCallDecisionAct;
};

/** The resolved, verified decision authorization returned on a successful verify. */
export type PendingCallDecision = {
  pendingCallId: string;
  userId: string;
  orgId: string;
  sessionId: string;
  act: PendingCallDecisionAct;
  /** Per-mint nonce (carried for future replay dedup; the row CAS bounds it). */
  jti: string;
};

type PendingCallDecisionTokenClaims = {
  t: "cinatra.connector-instance.pending-call-decision";
  pc: string; // pendingCallId — REQUIRED, fail-closed, bound at verify
  sub: string; // userId — REQUIRED, bound at verify
  org: string; // orgId — REQUIRED, bound at verify
  act: PendingCallDecisionAct; // action family — REQUIRED, bound at verify
  sid: string; // live session id — REQUIRED, bound at verify
  jti: string; // per-mint nonce
  aud: string;
  iss: string;
  iat: number;
  exp: number;
};

export const PENDING_CALL_DECISION_TOKEN_TYPE =
  "cinatra.connector-instance.pending-call-decision";
// Fixed audience — the decide server action, DISTINCT from the token type and
// issuer, exact-matched and fail-closed at verify.
const PENDING_CALL_DECISION_AUDIENCE =
  "cinatra:connector-instance:pending-call-decision";
// Fixed issuer — shared by mint + verify (exact-match; can never drift).
const PENDING_CALL_DECISION_ISSUER =
  "cinatra:connector-instance-pending-call-decision-token";
// SHORT TTL — the token is minted when the card is rendered and is only useful
// for the decide round-trip. 600 s covers a slow click while bounding the replay
// window (the row CAS, not the token, is the single-use edge). Bound AT VERIFY
// (below) so a signed token with a stretched lifetime is still rejected.
const TOKEN_TTL_SECONDS = 600;

const DECISION_ACTS = new Set<PendingCallDecisionAct>(["confirm", "reject"]);

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET. Cannot issue connector-instance pending-call decision token.",
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

/**
 * Mint a decision token for ONE action family of ONE pending-call row. The card
 * read calls this twice per row (once with `act: "confirm"`, once with
 * `act: "reject"`) to produce the two per-action tokens in the card data shape.
 */
export function issuePendingCallDecisionToken(
  input: PendingCallDecisionTokenInput,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: PendingCallDecisionTokenClaims = {
    t: PENDING_CALL_DECISION_TOKEN_TYPE,
    pc: input.pendingCallId,
    sub: input.userId,
    org: input.orgId,
    act: input.act,
    sid: input.sessionId,
    jti: randomUUID(),
    aud: PENDING_CALL_DECISION_AUDIENCE,
    iss: PENDING_CALL_DECISION_ISSUER,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  return `${signingInput}.${sign(signingInput)}`;
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
    // fails closed on signature malleability. timingSafeEqual requires equal
    // lengths; a mismatched length is an immediate reject.
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
 *  whitespace-only id/nonce is treated as absent — fail closed). The ids are
 *  opaque tokens with no legitimate whitespace. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDecisionAct(value: unknown): value is PendingCallDecisionAct {
  return (
    typeof value === "string" &&
    DECISION_ACTS.has(value as PendingCallDecisionAct)
  );
}

/**
 * Verify a decision token presented by the decide server action, BINDING it to
 * the exact row, requester, org, live session, and action being decided. Returns
 * the resolved decision, or `null` on ANY failure (fail-closed — the caller
 * treats `null` as a typed refusal and audits `pending_call_decision_rejected`,
 * never falling through to a decision).
 *
 * The bindings are the served-card layer OVER session + row ownership (never
 * instead of them): the caller has already established a LIVE session
 * (`requireAuthSession`) and passes its user/org/session id here, and separately
 * re-reads the row to assert ownership (PR-4 §4.2). `expectedAction` is the
 * concrete action the user took; it is mapped to its `act` family internally via
 * the single exported mapping, so a reject-family token can decide `deny` OR
 * `cancel` but never `confirm`.
 */
export function verifyPendingCallDecisionToken(input: {
  token: string | null | undefined;
  expectedPendingCallId: string;
  expectedUserId: string;
  expectedOrgId: string;
  expectedSessionId: string;
  expectedAction: PendingCallDecisionAction;
}): PendingCallDecision | null {
  try {
    const {
      token,
      expectedPendingCallId,
      expectedUserId,
      expectedOrgId,
      expectedSessionId,
      expectedAction,
    } = input;
    if (!isNonBlankString(token)) return null;

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
    // Type + audience + issuer discriminators — the cross-type gate. A chat /
    // mcp-obo / widget-resume / agent-run token all fail here (different `t`), so
    // no foreign token can be replayed at the decide seam (both directions).
    if (payload.t !== PENDING_CALL_DECISION_TOKEN_TYPE) return null;
    if (payload.aud !== PENDING_CALL_DECISION_AUDIENCE) return null;
    if (payload.iss !== PENDING_CALL_DECISION_ISSUER) return null;
    // Required claims — present, correctly typed, non-blank; fail-closed even
    // under a valid HMAC (the claim-shape attack).
    if (!isNonBlankString(payload.pc)) return null;
    if (!isNonBlankString(payload.sub)) return null;
    if (!isNonBlankString(payload.org)) return null;
    if (!isNonBlankString(payload.sid)) return null;
    if (!isDecisionAct(payload.act)) return null;
    if (!isNonBlankString(payload.jti)) return null;
    if (typeof payload.iat !== "number" || !Number.isInteger(payload.iat)) {
      return null;
    }
    if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
      return null;
    }
    // Never accept a future-dated token (iat = mint second; the issuer never
    // mints one in the future) — fail closed on a not-yet-valid token.
    if (payload.iat > now) return null;
    // Bind the SHORT TTL AT VERIFY, not merely by trusting the issuer: a
    // validly-signed token whose lifetime is NOT exactly the decision TTL is
    // rejected. This never rejects a legitimately-minted token (the issuer always
    // mints `exp = iat + TOKEN_TTL_SECONDS`); it fails closed on any signed token
    // — e.g. one minted under a compromised secret with a stretched lifetime —
    // that tries to widen the decide window.
    if (payload.exp - payload.iat !== TOKEN_TTL_SECONDS) return null;
    // Expired AT or after `exp` (RFC 7519: current time MUST be BEFORE exp). `<=`
    // closes the exact-expiry-second boundary a `<` would leave open.
    if (payload.exp <= now) return null;

    // BINDINGS — the token must have been minted for exactly THIS decision. A
    // mismatch on any binding is a fail-closed reject: a token minted for another
    // row / requester / org / session / action can never decide this one.
    if (payload.pc !== expectedPendingCallId) return null;
    if (payload.sub !== expectedUserId) return null;
    if (payload.org !== expectedOrgId) return null;
    if (payload.sid !== expectedSessionId) return null;
    if (payload.act !== pendingCallDecisionActForAction(expectedAction)) {
      return null;
    }

    return {
      pendingCallId: payload.pc,
      userId: payload.sub,
      orgId: payload.org,
      sessionId: payload.sid,
      act: payload.act,
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}

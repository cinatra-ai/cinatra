import "server-only";

// ---------------------------------------------------------------------------
// THE REVIEW-ISLAND CREDENTIAL (cinatra#2674 scope addition, recorded
// 2026-08-12; epic #2564 S8e).
//
// THE PROBLEM, IN ONE SENTENCE. The review-target island is a same-origin
// Cinatra document the review card frames, and it authenticates by SESSION
// COOKIE — so on a genuinely cross-site CMS the browser sends no cookie into
// that frame and the island paints nothing, no matter how correct the framing
// wall is. Until this slice, island parity held only on same-site and subdomain
// deployments.
//
// WHY A CREDENTIAL AND NOT A HEADER. An `<iframe src>` load is like an `<img
// src>`: no Authorization header, no custom header, and — cross-site — no
// ambient cookie. The URL IS the whole request. So the URL has to carry the
// authorization, which makes it a bearer, and everything below exists to make
// that bearer as small as a bearer can be made. This is the same reasoning, and
// deliberately the same construction, as the capture capability
// (`capture-capability.ts`); the two are siblings, and a reader who understands
// one understands this.
//
// WHAT IS SEALED, AND WHY EACH FIELD:
//   orgId, userId, jti     — the PRINCIPAL, derived from the WIDGET principal
//                            and never from the parent. `jti` is the `cwu_`
//                            token's own id, so signing out, revoking the site
//                            or rotating its `cnx_` kills every outstanding
//                            island credential at the next paint.
//   siteId, client,        — the SITE BINDING. A credential minted for one
//   instanceId, agentSlug    registered site / CMS client / canonical instance /
//                            widget agent is refused once the live token row
//                            stops agreeing.
//   runId, reviewTaskId    — THE REF BINDING, and the reason the issue says
//                            "ref-bound". The island is asked for ONE gate; a
//                            credential minted for gate A cannot paint gate B,
//                            because the serving page compares the ref it was
//                            given against the gate sealed in here and refuses
//                            on any difference. Swapping the `ref` in the URL is
//                            not merely tamper-evident — a legitimately-minted
//                            credential for another gate refuses too.
//   exp                    — the SHORT TTL. A bearer in a URL cannot be made
//                            un-copyable; it can be made short-lived. The card
//                            re-resolves on mount, on focus and on reload, and
//                            each resolve re-mints, so a reader never meets the
//                            expiry — only a copied link does.
//
// IT AUTHENTICATES; IT DOES NOT AUTHORIZE. Opening the seal proves this host
// minted the URL and that it is still live. The island then re-runs the reader's
// real access from scratch — live principal, live org standing, and
// `loadReviewGateSurface`'s own run-access check — exactly as the cookie path
// does. A forged, replayed or stale credential buys one thing: an empty island.
//
// KEY SEPARATION. The derivation label is this module's own, so a lifecycle card
// ref, a capture capability and an island credential can never be opened as one
// another even though all three hang off the same app secret.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * How long a minted island credential stays usable, in seconds.
 *
 * Bounded well below the `cwu_` user token's own 15-minute life, for the same
 * reason the capture capability is: the URL must be the shorter-lived of the
 * two, so a frame src can never outlive the session that was allowed to see it.
 */
export const REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS = 120;

/** Ceiling on the encoded credential. A longer query value is not one of ours. */
export const REVIEW_ISLAND_CREDENTIAL_MAX_LENGTH = 1024;

/** The query parameter the island reads its credential from. */
export const REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM = "ic";

/** The island's own path — one route, one shape. */
export const REVIEW_ISLAND_ROUTE = "/lifecycle/review-island";

/** Everything an island credential binds. Every field is re-checked at paint. */
export interface ReviewIslandCredentialPayload {
  /** Tenant. The only org the sealed reads may ever run against. */
  orgId: string;
  /** The cinatra principal the widget login produced (never a CMS-chosen id). */
  userId: string;
  /** The `cwu_` token's own id — the revocation handle. */
  jti: string;
  /** The registered connect site the widget turn was authenticated for. */
  siteId: string;
  /** The CMS client ("wordpress" | "drupal" | …) bound to that site. */
  client: string;
  /** The canonical instance the origin resolved to at login. */
  instanceId: string;
  /** The widget agent the `cwu_` token is bound to (its `agent_slug`). */
  agentSlug: string;
  /** The gate this credential is scoped to — run half. */
  runId: string;
  /** The gate this credential is scoped to — gate half. */
  reviewTaskId: string;
}

/** A verified credential: the sealed payload plus its own expiry. */
export interface VerifiedReviewIslandCredential extends ReviewIslandCredentialPayload {
  /** Unix seconds the credential stops being usable. */
  expiresAt: number;
}

const FIELD_MAX = 128;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Key-derivation label — changing it rotates every credential by construction. */
const CREDENTIAL_KEY_INFO = "cinatra:review-island-credential:v1";

function credentialKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(CREDENTIAL_KEY_INFO).digest();
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= FIELD_MAX;
}

/** The wire form. Single-letter keys keep the sealed plaintext — and therefore
 *  the URL — small; the mapping never leaves this module. */
type SealedShape = {
  o: string;
  u: string;
  j: string;
  s: string;
  c: string;
  i: string;
  n: string;
  r: string;
  g: string;
  x: number;
};

/**
 * Mint an island credential for a reader the caller has ALREADY authorized for
 * this gate. Minting is not an authorization step; it is the transport for one
 * that already happened.
 *
 * Returns `null` when a field is out of bounds, when no key is available, or
 * when the encoded form would exceed the URL budget — a surface that cannot
 * express a credential renders no island rather than a broken frame.
 */
export function mintReviewIslandCredential(
  payload: ReviewIslandCredentialPayload,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): string | null {
  const fields: Array<unknown> = [
    payload.orgId,
    payload.userId,
    payload.jti,
    payload.siteId,
    payload.client,
    payload.instanceId,
    payload.agentSlug,
    payload.runId,
    payload.reviewTaskId,
  ];
  if (!fields.every((f) => boundedId(f))) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  const ttl = options?.ttlSeconds ?? REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS;
  if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0) return null;
  // A caller may only ever SHORTEN the life of a credential. Accepting a longer
  // ttl would let one careless surface hand out a URL that outlives the token
  // that authorized it.
  if (ttl > REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS) return null;

  const key = credentialKey();
  if (!key) return null;

  const sealed: SealedShape = {
    o: payload.orgId,
    u: payload.userId,
    j: payload.jti,
    s: payload.siteId,
    c: payload.client,
    i: payload.instanceId,
    n: payload.agentSlug,
    r: payload.runId,
    g: payload.reviewTaskId,
    x: now + ttl,
  };

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(sealed), "utf8"),
      cipher.final(),
    ]);
    const encoded = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return encoded.length <= REVIEW_ISLAND_CREDENTIAL_MAX_LENGTH ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Open an island credential and check its own expiry. `null` for anything that
 * is not a live one of ours — forged, tampered, sealed under a rotated key, and
 * expired are all the same answer, because the island must not distinguish them.
 *
 * THIS IS NOT THE AUTHORIZATION. It proves the URL was minted by this host and
 * has not expired; the ref binding, the live principal and the reader's run
 * access are all still checked afterwards.
 */
export function verifyReviewIslandCredential(
  encoded: string,
  options?: { nowSeconds?: number },
): VerifiedReviewIslandCredential | null {
  if (typeof encoded !== "string") return null;
  if (encoded.length === 0 || encoded.length > REVIEW_ISLAND_CREDENTIAL_MAX_LENGTH) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const key = credentialKey();
  if (!key) return null;

  let parsed: unknown;
  try {
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const s = parsed as Partial<SealedShape>;
  if (
    !boundedId(s.o) ||
    !boundedId(s.u) ||
    !boundedId(s.j) ||
    !boundedId(s.s) ||
    !boundedId(s.c) ||
    !boundedId(s.i) ||
    !boundedId(s.n) ||
    !boundedId(s.r) ||
    !boundedId(s.g)
  ) {
    return null;
  }
  if (typeof s.x !== "number" || !Number.isFinite(s.x)) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  // Expiry against the SERVER clock, never a value the holder supplies, and
  // inclusive-exclusive so a credential is dead the instant its second arrives.
  if (now >= s.x) return null;
  // A credential whose life exceeds the ceiling was not minted by this codec at
  // this version — refuse rather than honour a long-lived one.
  if (s.x - now > REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS) return null;

  return {
    orgId: s.o,
    userId: s.u,
    jti: s.j,
    siteId: s.s,
    client: s.c,
    instanceId: s.i,
    agentSlug: s.n,
    runId: s.r,
    reviewTaskId: s.g,
    expiresAt: s.x,
  };
}

/** The same-origin island URL a widget lifecycle card puts in `<iframe src>`.
 *  The ref addresses the gate; the credential authenticates the reader; the two
 *  must agree, which the island checks. */
export function reviewIslandUrl(input: { ref: string; credential: string }): string {
  return (
    `${REVIEW_ISLAND_ROUTE}?ref=${encodeURIComponent(input.ref)}` +
    `&${REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM}=${encodeURIComponent(input.credential)}`
  );
}

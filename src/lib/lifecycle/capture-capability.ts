import "server-only";

// ---------------------------------------------------------------------------
// The WIDGET CAPTURE CAPABILITY codec (cinatra#2576, epic #2564 S8c).
//
// WHY A CAPABILITY AND NOT A REF. Every other lifecycle address in this epic is
// deliberately NOT a capability (`lifecycle-card-ref.ts`: "the ref addresses a
// row; it grants nothing") because every consumer of a ref can present its own
// credential — the resolve POST rides the session cookie, the decide POST rides
// a fresh action capability. A CAPTURE has no such consumer. It is fetched by
// `<img src>`, and an image load carries no Authorization header, no custom
// header and — inside a cross-site iframe — no ambient cookie either. The URL
// IS the whole request. So the URL has to carry the authorization, which makes
// it a bearer capability, and every property below exists to keep the blast
// radius of that bearer as small as a bearer can be made.
//
// WHAT IS SEALED, AND WHY EACH FIELD. The capability is AES-256-GCM sealed
// (authenticated encryption, not a signature over cleartext) under a key
// derived from the app secret, so it is opaque as well as tamper-evident: a URL
// that lands in a CMS access log, a referrer chain or a support ticket must not
// disclose an org id, a run id or a gate id to whoever reads that log.
//
//   orgId, userId, jti     — the PRINCIPAL. `jti` is the `cwu_` user token's own
//                            id, so signing the user out, revoking the site or
//                            rotating its `cnx_` credential kills every
//                            outstanding capability at the next fetch. `userId`
//                            + `orgId` are what the run-read re-check runs as.
//   siteId, client,        — the SITE BINDING #2576 asks for. A capability
//   instanceId,              minted for one registered site / CMS client /
//   agentSlug                canonical instance / widget agent is refused when
//                            the live token row no longer agrees, so a re-bound
//                            or re-pointed site cannot keep serving pictures
//                            under the old binding. `agentSlug` is sealed for
//                            one reason: `consumeUserWidgetToken` rejects an
//                            agent mismatch, and a probe that could not make the
//                            same comparison would be the laxer of the pair.
//   runId, reviewTaskId    — the GATE SCOPE. This is the field that makes "a URL
//                            minted for gate A cannot fetch gate B's capture"
//                            true: the serving path proves the sealed capture is
//                            bound to a target THIS gate pinned, so swapping the
//                            capture id is not merely tamper-evident (the AEAD
//                            already gives that) — even a legitimately-minted
//                            capability for another gate refuses.
//   captureArtifactId,     — the ONE picture. Not a prefix, not a wildcard.
//   representationRevisionId
//   exp                    — the SHORT TTL. A bearer in a URL cannot be made
//                            un-copyable; it can be made short-lived, and the
//                            card re-mints on mount / focus / reload (S1's
//                            refetch cadence), so a 5-minute life is invisible
//                            to a reader and decisive for a copied link.
//
// KEY SEPARATION. The derivation label is this module's own, so a lifecycle card
// ref can never decode as a capture capability and vice versa, even though both
// hang off the same app secret. Rotating the secret retires outstanding
// capabilities; the pictures re-mint on the next card resolve.
//
// FAIL-CLOSED ON KEY TROUBLE. No secret, a rotated key, tampered bytes, a
// non-JSON plaintext, an out-of-bounds field: all `null`. The serving route
// turns every `null` into the same 404, so nothing here is an oracle.
//
// PURE-ish LEAF: `node:crypto` only, no store and no route imports, so the
// broker surface that MINTS a capability does not drag the serving path's store
// graph behind it (the `lifecycle-card-ref` precedent).
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * How long a minted capture capability stays fetchable, in seconds.
 *
 * Bounded WELL BELOW the `cwu_` user token's own 15-minute life on purpose: the
 * capability must be the shorter-lived of the two, so the picture URL can never
 * outlive the session that was allowed to see it. A card re-resolves on mount,
 * on focus and on reload, and each resolve re-mints, so a reader never sees an
 * expiry — only a copied link does.
 */
export const CAPTURE_CAPABILITY_TTL_SECONDS = 300;

/** Everything a capability binds. Every field is checked live at serve time. */
export interface CaptureCapabilityPayload {
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
  /** The gate this capability is scoped to — run half. */
  runId: string;
  /** The gate this capability is scoped to — gate half. */
  reviewTaskId: string;
  /** The one capture artifact this capability may fetch. */
  captureArtifactId: string;
  /** The one PNG representation revision of that capture. */
  representationRevisionId: string;
}

/** A verified capability: the sealed payload plus its own expiry. */
export interface VerifiedCaptureCapability extends CaptureCapabilityPayload {
  /** Unix seconds the capability stops being fetchable. */
  expiresAt: number;
}

// Bounds. Every id in this codebase is a uuid, a uuid-shaped digest or a short
// slug; 128 is generous for all of them and keeps a sealed capability inside a
// URL-sane length. Enforced on BOTH sides so a hostile plaintext cannot expand
// on decode either.
const FIELD_MAX = 128;
/** Ceiling on the encoded capability. A longer query value is not one of ours. */
export const CAPTURE_CAPABILITY_MAX_LENGTH = 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Key-derivation label — changing it rotates every capability by construction. */
const CAPABILITY_KEY_INFO = "cinatra:widget-capture-capability:v1";

/** The query parameter the serving route reads the capability from. */
export const CAPTURE_CAPABILITY_QUERY_PARAM = "c";

/** The same-origin serving path. One route, one shape, no path parameters —
 * the capability carries every identifier, so nothing about the picture is
 * readable from the URL's structure. */
export const CAPTURE_CAPABILITY_ROUTE = "/api/lifecycle-views/capture";

function capabilityKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(CAPABILITY_KEY_INFO).digest();
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= FIELD_MAX;
}

/**
 * The wire form. Single-letter keys keep the sealed plaintext (and therefore the
 * URL) small; the mapping is local to this module and never leaves it.
 */
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
  a: string;
  v: string;
  x: number;
};

/**
 * Mint a capture capability.
 *
 * The caller MUST already have authorized this reader for this gate — minting is
 * not an authorization step, it is the transport for one that already happened.
 * Returns `null` when a field is out of bounds, when no key is available or when
 * the encoded form would exceed the URL budget: a surface that cannot express a
 * capability renders the honest "no picture" state rather than a broken image.
 */
export function mintCaptureCapability(
  payload: CaptureCapabilityPayload,
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
    payload.captureArtifactId,
    payload.representationRevisionId,
  ];
  if (!fields.every((f) => boundedId(f))) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  const ttl = options?.ttlSeconds ?? CAPTURE_CAPABILITY_TTL_SECONDS;
  if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0) return null;
  // A caller may only ever SHORTEN the life of a capability. Accepting a longer
  // ttl would let one careless surface hand out a picture URL that outlives the
  // token that authorized it.
  if (ttl > CAPTURE_CAPABILITY_TTL_SECONDS) return null;

  const key = capabilityKey();
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
    a: payload.captureArtifactId,
    v: payload.representationRevisionId,
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
    return encoded.length <= CAPTURE_CAPABILITY_MAX_LENGTH ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Open a capture capability and check its own expiry. `null` for anything that
 * is not a live one of ours — a forged value, a tampered one, one sealed under a
 * rotated key, and an expired one are all the same answer, because the serving
 * route must not distinguish them.
 *
 * THIS IS NOT THE AUTHORIZATION. It proves the URL was minted by this host and
 * has not expired; the live principal, site, gate and capture-binding checks all
 * still run afterwards (`capture-capability-serving.ts`).
 */
export function verifyCaptureCapability(
  encoded: string,
  options?: { nowSeconds?: number },
): VerifiedCaptureCapability | null {
  if (typeof encoded !== "string") return null;
  if (encoded.length === 0 || encoded.length > CAPTURE_CAPABILITY_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const key = capabilityKey();
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
    // Wrong key, tampered bytes, non-JSON plaintext — "not one of ours".
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
    !boundedId(s.g) ||
    !boundedId(s.a) ||
    !boundedId(s.v)
  ) {
    return null;
  }
  if (typeof s.x !== "number" || !Number.isFinite(s.x)) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  // Expiry is checked against the SERVER clock, never a value the holder
  // supplies, and the comparison is inclusive-exclusive so a capability is dead
  // the instant its second arrives.
  if (now >= s.x) return null;
  // A capability whose life exceeds the ceiling was not minted by this codec at
  // this version — refuse rather than honour a long-lived one.
  if (s.x - now > CAPTURE_CAPABILITY_TTL_SECONDS) return null;

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
    captureArtifactId: s.a,
    representationRevisionId: s.v,
    expiresAt: s.x,
  };
}

/** The same-origin URL a broker surface puts in `<img src>`. */
export function captureCapabilityUrl(encoded: string): string {
  return `${CAPTURE_CAPABILITY_ROUTE}?${CAPTURE_CAPABILITY_QUERY_PARAM}=${encodeURIComponent(encoded)}`;
}

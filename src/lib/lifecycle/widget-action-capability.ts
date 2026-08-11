import "server-only";

// ---------------------------------------------------------------------------
// The WIDGET ACTION CAPABILITY codec (cinatra#2575, epic #2564 S8b).
//
// WHAT IT IS FOR. A widget reviewer's `cwu_` bearer authorizes READS (S8a). It
// cannot authorize a DECISION, and the reason is structural rather than a matter
// of degree: the CMS backend redeems that bearer and hands it to the iframe, so
// the site's own software necessarily possesses it. Anything the bearer alone
// can do, a hostile site admin can do unattended. A decision must therefore rest
// on something the site can never hold — a credential minted in a cinatra-origin
// window the site cannot script, read or replay.
//
// This module is that credential's shape. `capture-capability.ts` (S8c) already
// wrote the sentence this slice implements: "the resolve POST rides the session
// cookie, the decide POST rides a fresh action capability."
//
// HOW IT DIFFERS FROM THE CAPTURE CAPABILITY, and why both exist. A capture
// capability travels in a URL because an `<img>` load can carry nothing else; it
// is multi-fetch within its 5 minutes because a picture may be painted twice.
// This one travels in a REQUEST HEADER on a `fetch` the widget makes itself, so
// it is never in a URL, never in an access log and never in a referrer — and it
// is SINGLE-USE against a durable consume edge, because a decision is not a
// picture: replaying it is exactly the attack.
//
// WHAT IS SEALED, AND WHY EACH FIELD.
//
//   cid                    — the capability's OWN id, and the row the consume
//                            edge burns. Sealing it (rather than passing it
//                            beside the capability) means a caller cannot name
//                            one row while presenting another's binding.
//   purpose                — WHAT this capability may be spent on. One atom,
//                            compared for equality. A capability minted for a
//                            future non-decision action can never be spent here.
//   audience               — WHERE it may be spent: one endpoint path, compared
//                            for equality by that endpoint. A capability is not
//                            a bearer for "the widget API"; it is a bearer for
//                            ONE door.
//   orgId, userId          — the PRINCIPAL the decision is taken as. Re-derived
//                            live at redeem and required to agree.
//   jti                    — the `cwu_` widget session this capability was
//                            minted INSIDE. The redeem presents that same
//                            bearer, so signing out, revoking the site or
//                            rotating its credential kills the capability
//                            through the token verifier's own live re-checks.
//   siteId, client,        — the SITE BINDING. A capability minted on site A's
//   instanceId, agentSlug    widget cannot be spent from site B's, even by the
//                            same person in the same org.
//   runId, reviewTaskId    — the ONE gate. Not a run prefix, not a wildcard.
//   disposition            — WHAT was confirmed. Sealed because the hosted page
//                            SHOWS it ("You are about to approve…"): a
//                            confirmation that did not name the act would be a
//                            confirmation of nothing, and an approve capability
//                            must not be spendable as a reject.
//   targetsDigest          — the REPRESENTATION REVISIONS the gate had pinned
//                            when the confirmation was shown. Re-derived at
//                            redeem from the live gate; disagreement refuses.
//                            This is what makes "you decided the thing you were
//                            shown" true rather than hoped.
//   exp                    — the SHORT TTL. The mint→spend hop is one `fetch`
//                            after one click; 120 seconds is generous for it and
//                            far under the `cwu_`'s own 15 minutes, so a
//                            capability can never outlive the session that
//                            authorized it.
//
// THE SEAL IS NOT THE AUTHORIZATION. Opening a capability proves this host
// minted it and that it has not expired. Everything that makes it USABLE — the
// single-use burn, the live principal, the live gate, the run-access re-check —
// happens afterwards, in the broker endpoint, in that order.
//
// KEY SEPARATION. Its own derivation label, so a lifecycle card ref, a capture
// capability and an action capability can never open as one another even though
// all three hang off the same app secret. Rotating the secret retires every
// outstanding capability, which for a 120-second credential is invisible.
//
// PURE LEAF: `node:crypto` only. No store, no route, no actor imports — the
// broker endpoint that redeems a capability must not drag the mint surface's
// graph behind it, and the hosted page that mints one must not drag the
// decision core's.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import {
  WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH,
  WIDGET_LIFECYCLE_DECIDE_SCOPE,
} from "@/lib/widget-lifecycle-scope";

/**
 * How long a minted action capability stays spendable, in seconds.
 *
 * The whole life of this credential is: the person presses Confirm in a cinatra
 * window, the window hands the sealed value to the iframe that opened it, the
 * iframe POSTs it. That is one round trip. 120 seconds absorbs a slow network
 * and a slow hand without leaving a spendable decision credential lying around,
 * and it is an eighth of the `cwu_` token's own life.
 */
export const ACTION_CAPABILITY_TTL_SECONDS = 120;

/**
 * The ONE purpose this build mints and spends. A named constant on both sides so
 * the mint and the redeem cannot drift, and an atom (no whitespace) so it can
 * never be read as two.
 *
 * It is DELIBERATELY the same atom as the `cwu_`'s decide grant. The two are not
 * the same mechanism — the grant says a widget session may PARTICIPATE in a
 * decision at all, the capability says one particular decision was confirmed by
 * a person — but they name the same capability, and giving them two spellings
 * would invite a future surface to satisfy one while meaning the other.
 */
export const ACTION_CAPABILITY_PURPOSE_DECIDE = WIDGET_LIFECYCLE_DECIDE_SCOPE;

/**
 * The ONE endpoint an action capability may be spent at — the broker decision
 * entry, which is also the audience the `cwu_`'s decide GRANT unlocks. Aliased
 * from the scope vocabulary rather than restated, so the endpoint a session was
 * granted access to and the endpoint a capability may be spent at are one string
 * with one definition.
 */
export const ACTION_CAPABILITY_DECIDE_ROUTE_PATH = WIDGET_LIFECYCLE_DECIDE_ROUTE_PATH;

/**
 * The request header the sealed capability is presented on.
 *
 * A CUSTOM header, deliberately, and never `Authorization`: the widget's site
 * bearer already lives on `Authorization` at the chat route, and a decision
 * credential that shared that slot could be sent by a caller that thought it was
 * sending the other one. A custom header is also unreachable by a simple
 * cross-origin form or `<img>`, and the endpoint is fetched with
 * `credentials: "omit"` — see the route's own header note.
 */
export const ACTION_CAPABILITY_HEADER = "X-Cinatra-Action-Capability";

/**
 * The rationale cap on the WIDGET path — lower than the first-party 10,000.
 *
 * codex round 1, finding 1. The confirmation window shows the WHOLE rationale,
 * because an excerpt would let a benign opening hide a consequential ending
 * behind a click. So the cap is set to what a window can honestly present at
 * once, not to what a store can hold, and both widget endpoints enforce it: a
 * longer body is a 400, never a silent truncation.
 *
 * It lives here, beside the digest it feeds, so the two endpoints cannot drift
 * into accepting different amounts of the same text.
 */
export const WIDGET_COMMENT_MAX_CHARS = 2_000;

/** The dispositions a decision capability can carry — the review floor. */
export const ACTION_CAPABILITY_DISPOSITIONS = ["approve", "reject", "comment"] as const;
export type ActionCapabilityDisposition = (typeof ACTION_CAPABILITY_DISPOSITIONS)[number];

export function isActionCapabilityDisposition(
  value: unknown,
): value is ActionCapabilityDisposition {
  return (
    typeof value === "string" &&
    (ACTION_CAPABILITY_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/** Everything a capability binds. Every field is re-checked live at redeem. */
export interface ActionCapabilityPayload {
  /** The capability's own id — the row the single-use consume edge burns. */
  capabilityId: string;
  /** What it may be spent on. */
  purpose: string;
  /** The one endpoint path it may be spent at. */
  audience: string;
  /** Tenant. The only org the decision may run against. */
  orgId: string;
  /** The cinatra principal the widget login produced (never a CMS-chosen id). */
  userId: string;
  /** The `cwu_` widget session this capability was minted inside. */
  jti: string;
  /** The registered connect site the widget session was authenticated for. */
  siteId: string;
  /** The CMS client ("wordpress" | "drupal" | …) bound to that site. */
  client: string;
  /** The canonical instance the origin resolved to at login. */
  instanceId: string;
  /** The widget agent the `cwu_` token is bound to (its `agent_slug`). */
  agentSlug: string;
  /** The gate — run half. */
  runId: string;
  /** The gate — gate half. */
  reviewTaskId: string;
  /** The act that was confirmed. */
  disposition: ActionCapabilityDisposition;
  /** Digest of the gate's pinned targets as they stood at confirmation. */
  targetsDigest: string;
  /**
   * Digest of the DECISION PAYLOAD the person confirmed — the act, the
   * rationale, and the per-item suggestion partition. The broker endpoint
   * re-derives it from the body actually presented and refuses a mismatch, so
   * the request that is submitted is the request that was confirmed.
   */
  decisionDigest: string;
}

/** A verified capability: the sealed payload plus its own expiry. */
export interface VerifiedActionCapability extends ActionCapabilityPayload {
  /** Unix seconds the capability stops being spendable. */
  expiresAt: number;
}

// Bounds. Every id here is a uuid, a uuid-shaped digest or a short slug; 128 is
// generous for all of them. Enforced on BOTH sides so a hostile plaintext cannot
// expand on decode either.
const FIELD_MAX = 128;
/** Ceiling on the encoded capability. A longer header value is not one of ours. */
export const ACTION_CAPABILITY_MAX_LENGTH = 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Key-derivation label — changing it rotates every capability by construction. */
const CAPABILITY_KEY_INFO = "cinatra:widget-action-capability:v1";

function capabilityKey(): Buffer | null {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(CAPABILITY_KEY_INFO).digest();
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= FIELD_MAX;
}

/**
 * The canonical digest of a gate's PINNED TARGET SET.
 *
 * Sorted before hashing, because the pinned set is a SET: the store is free to
 * return it in any order, and a digest that depended on that order would refuse
 * a perfectly valid decision at random.
 *
 * The two separators are NUL and SOH — bytes no id in this codebase can contain
 * (every id is a uuid, a uuid-shaped digest or a slug) and DIFFERENT from each
 * other, so neither the pair boundary nor the element boundary is ambiguous:
 * `("a", "b c")` and `("a b", "c")` cannot digest alike. A length-prefixed
 * encoding would be equally sound; an unseparated concatenation would not.
 *
 * A gate with NO pinned targets digests to the empty-set digest rather than an
 * empty string — "no targets" is a real (and refusable) state, not an absence.
 *
 * PURE, and exported: the mint (hosted page) and the redeem (broker endpoint)
 * must compute it the same way, and a second implementation is exactly how the
 * two would drift into accepting a decision for content nobody was shown.
 */
export function pinnedTargetsDigest(
  targets: readonly { artifactId: string; representationRevisionId: string }[],
): string {
  const canonical = targets
    .map((t) => `${t.artifactId}\u0000${t.representationRevisionId}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join("\u0001");
  return createHash("sha256").update(`v1\u0002${canonical}`, "utf8").digest("hex");
}

/**
 * The client-supplied half of a decision, as both ends digest it.
 *
 * DELIBERATELY JUST THE ACT AND THE RATIONALE. The first-party decision entries
 * also carry the reviewer's per-item SUGGESTION partition (S6b), and the widget
 * path does NOT — see `decisionPayloadDigest` for why, and for where it joins.
 */
export interface ActionCapabilityDecisionPayload {
  disposition: ActionCapabilityDisposition;
  /** The rationale. `null` and `""` are the SAME decision and digest alike. */
  comment: string | null;
}

/**
 * The canonical digest of what a person CONFIRMED they were submitting.
 *
 * The confirmation window names the act and shows the rationale; without this,
 * the confirmed capability would authorize "a decision on this gate" and the
 * body presented afterwards could say something else. With it, the broker
 * endpoint re-derives the digest from the body it actually received and refuses
 * any disagreement, so the sentence the person read is the sentence that lands.
 *
 * CANONICALIZATION, and why each rule:
 *   - an absent rationale and an empty one are the SAME decision, so both digest
 *     as empty; a rationale is otherwise taken byte-for-byte (trimming here
 *     would make two different submissions digest alike).
 *   - the two fields are NUL-separated, so no rationale can be rearranged into a
 *     different act with the same digest.
 *
 * WHY THERE IS NO SUGGESTION PARTITION HERE, and it is not an oversight. A
 * confirmation is only worth taking for what the window can SHOW. This build's
 * confirmation window renders the act, the subject under review and the
 * rationale; it cannot render the reviewer's per-item suggestion marks, because
 * their labels live in the gate's pinned snapshot and the component that draws
 * them is the card (S6c) — which, on the widget, is S8d's. Digesting a partition
 * the person could not read would authorize invisible per-item choices on the
 * strength of a click about something else. So the widget path REFUSES a
 * partition outright (both widget endpoints reject the field at their schema),
 * and it joins in S8d together with the screen that can name it. The first-party
 * entries are unaffected: they carry the partition as they always have.
 */
export function decisionPayloadDigest(payload: ActionCapabilityDecisionPayload): string {
  const canonical = [payload.disposition, payload.comment ?? ""].join("\u0000");
  return createHash("sha256").update(`v1\u0002${canonical}`, "utf8").digest("hex");
}

/**
 * The wire form. Single-letter keys keep the sealed plaintext (and therefore the
 * header) small; the mapping is local to this module and never leaves it.
 */
type SealedShape = {
  k: string; // capabilityId
  p: string; // purpose
  d: string; // audience
  o: string; // orgId
  u: string; // userId
  j: string; // jti
  s: string; // siteId
  c: string; // client
  i: string; // instanceId
  n: string; // agentSlug
  r: string; // runId
  g: string; // reviewTaskId
  w: string; // disposition
  t: string; // targetsDigest
  y: string; // decisionDigest
  x: number; // exp
};

/**
 * Mint an action capability.
 *
 * The caller MUST already have authorized this person for this gate and MUST
 * already have created the single-use row this capability names — minting is not
 * an authorization step, it is the transport for one that already happened and
 * the handle to a burn that has not.
 *
 * Returns `null` when a field is out of bounds, when the purpose/audience are
 * not ones this build mints, when no key is available, or when the encoded form
 * would exceed the header budget. A surface that cannot express a capability
 * refuses the confirmation rather than shipping a decision nobody can spend.
 */
export function mintActionCapability(
  payload: ActionCapabilityPayload,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): string | null {
  const fields: Array<unknown> = [
    payload.capabilityId,
    payload.purpose,
    payload.audience,
    payload.orgId,
    payload.userId,
    payload.jti,
    payload.siteId,
    payload.client,
    payload.instanceId,
    payload.agentSlug,
    payload.runId,
    payload.reviewTaskId,
    payload.targetsDigest,
    payload.decisionDigest,
  ];
  if (!fields.every((f) => boundedId(f))) return null;
  if (!isActionCapabilityDisposition(payload.disposition)) return null;
  // A purpose or audience this build does not mint is refused at the MINT, not
  // merely at the redeem: a value that never existed cannot be replayed.
  if (payload.purpose !== ACTION_CAPABILITY_PURPOSE_DECIDE) return null;
  if (payload.audience !== ACTION_CAPABILITY_DECIDE_ROUTE_PATH) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  const ttl = options?.ttlSeconds ?? ACTION_CAPABILITY_TTL_SECONDS;
  if (!Number.isFinite(now) || !Number.isFinite(ttl) || ttl <= 0) return null;
  // A caller may only ever SHORTEN a capability's life. Accepting a longer ttl
  // would let one careless surface hand out a decision credential that outlives
  // the widget session that authorized it.
  if (ttl > ACTION_CAPABILITY_TTL_SECONDS) return null;

  const key = capabilityKey();
  if (!key) return null;

  const sealed: SealedShape = {
    k: payload.capabilityId,
    p: payload.purpose,
    d: payload.audience,
    o: payload.orgId,
    u: payload.userId,
    j: payload.jti,
    s: payload.siteId,
    c: payload.client,
    i: payload.instanceId,
    n: payload.agentSlug,
    r: payload.runId,
    g: payload.reviewTaskId,
    w: payload.disposition,
    t: payload.targetsDigest,
    y: payload.decisionDigest,
    x: now + ttl,
  };

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(sealed), "utf8"), cipher.final()]);
    const encoded = Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
    return encoded.length <= ACTION_CAPABILITY_MAX_LENGTH ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Open an action capability and check its own expiry, purpose and audience.
 *
 * `null` for anything that is not a live one of ours — forged, tampered, sealed
 * under a rotated key, expired, minted for another purpose, or presented at an
 * endpoint it was not minted for. All the same answer, because the broker
 * endpoint must not distinguish them.
 *
 * THIS IS NOT THE AUTHORIZATION. It proves the header was minted by this host,
 * for this door, and has not expired. The single-use burn, the live principal,
 * the live gate and the run-access re-check all still run afterwards.
 */
export function verifyActionCapability(
  encoded: string,
  expected: { audience: string; purpose: string },
  options?: { nowSeconds?: number },
): VerifiedActionCapability | null {
  if (typeof encoded !== "string") return null;
  if (encoded.length === 0 || encoded.length > ACTION_CAPABILITY_MAX_LENGTH) return null;
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
    !boundedId(s.k) ||
    !boundedId(s.p) ||
    !boundedId(s.d) ||
    !boundedId(s.o) ||
    !boundedId(s.u) ||
    !boundedId(s.j) ||
    !boundedId(s.s) ||
    !boundedId(s.c) ||
    !boundedId(s.i) ||
    !boundedId(s.n) ||
    !boundedId(s.r) ||
    !boundedId(s.g) ||
    !boundedId(s.t) ||
    !boundedId(s.y)
  ) {
    return null;
  }
  if (!isActionCapabilityDisposition(s.w)) return null;
  if (typeof s.x !== "number" || !Number.isFinite(s.x)) return null;

  // PURPOSE and AUDIENCE are checked HERE, against what the CALLER declares it
  // is, not against a module constant — so a second endpoint added later cannot
  // accidentally accept this one's capabilities by importing this verifier. The
  // caller's declaration is itself pinned to a constant by a structural test.
  if (s.p !== expected.purpose) return null;
  if (s.d !== expected.audience) return null;

  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  // Expiry against the SERVER clock, never a value the holder supplies, and
  // inclusive-exclusive so a capability is dead the instant its second arrives.
  if (now >= s.x) return null;
  // A capability whose life exceeds the ceiling was not minted by this codec at
  // this version — refuse rather than honour a long-lived one.
  if (s.x - now > ACTION_CAPABILITY_TTL_SECONDS) return null;

  return {
    capabilityId: s.k,
    purpose: s.p,
    audience: s.d,
    orgId: s.o,
    userId: s.u,
    jti: s.j,
    siteId: s.s,
    client: s.c,
    instanceId: s.i,
    agentSlug: s.n,
    runId: s.r,
    reviewTaskId: s.g,
    disposition: s.w,
    targetsDigest: s.t,
    decisionDigest: s.y,
    expiresAt: s.x,
  };
}

/**
 * The alphabet a REFERENCE CODE is written in.
 *
 * Crockford-ish: no `0`/`O`, no `1`/`I`/`L`, no `U`. A person is going to
 * compare this code against the one on the card by eye, and a pair that differ
 * only by a character nobody can tell apart is a pair that reads as equal.
 */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A short, stable, human-comparable code for ONE review gate.
 *
 * WHY IT EXISTS (codex round 1, finding 2). Naming the artifacts under review
 * is necessary but not sufficient: titles are neither unique nor immutable, so a
 * site that can ask for a capability on any gate the person may read can pick a
 * decoy whose title reads the same. A code derived from the GATE ITSELF is what
 * makes two confirmations distinguishable even when their prose is identical.
 *
 * WHAT IT IS AND IS NOT. It is a comparison aid, not a secret and not an
 * authorization: it is derived from ids the holder already has, so knowing it
 * grants nothing, and the person can only USE it once the same code appears
 * beside the decision on the card — which is the widget card S8d owns. Until
 * then it is honest but unpaired, and this slice says so rather than implying
 * more. It is deliberately NOT the raw gate id: a uuid is not something anyone
 * compares correctly, and the whole value here is that a person can.
 *
 * Stable across processes and deploys (a pure hash of the two ids), so the same
 * gate always reads the same, and unstable across gates, so a decoy does not.
 */
export function reviewReferenceCode(runId: string, reviewTaskId: string): string {
  const digest = createHash("sha256")
    .update(`cinatra:review-reference:v1\u0000${runId}\u0000${reviewTaskId}`, "utf8")
    .digest();
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += REFERENCE_ALPHABET[digest[i] % REFERENCE_ALPHABET.length];
    if (i === 3) out += "-";
  }
  return out;
}

/**
 * The digest a capability ROW stores instead of the binding itself.
 *
 * The sealed capability is authenticated, so the row does not need to re-state
 * what it binds — but comparing a digest at the burn closes a narrower hole: two
 * capabilities minted under the same key, for the same person, differing only in
 * the gate they name, must not be interchangeable at the consume edge. Storing a
 * digest rather than the columns also keeps the durable row from restating the
 * tenant's gate and run ids a second time.
 *
 * Pure, and derived from the SEALED values only — never from anything the
 * request supplies alongside them.
 */
export function actionCapabilityBindingDigest(payload: ActionCapabilityPayload): string {
  const canonical = [
    payload.purpose,
    payload.audience,
    payload.orgId,
    payload.userId,
    payload.jti,
    payload.siteId,
    payload.client,
    payload.instanceId,
    payload.agentSlug,
    payload.runId,
    payload.reviewTaskId,
    payload.disposition,
    payload.targetsDigest,
    payload.decisionDigest,
  ].join("\u0000");
  return createHash("sha256").update(`v1\u0002${canonical}`, "utf8").digest("hex");
}

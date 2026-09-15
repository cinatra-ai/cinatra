import "server-only";

// THE DATA CAPABILITY INSIDE THE ISLAND (enabler 0.12 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The data capability inside the island:
// a separate, short-lived capability sealed to the actor, the run, the gate, the
// artifact, the representation and the pinned configuration digest, which a
// display's data road accepts with a live access re-check on every call; the
// one-use island credential is never reused for data; a refused capability
// yields the named no-data state — the analytics route and the read-only portlet
// loaders are the first consumers, wired in the sibling plan."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "the island paints under a one-use
// credential consumed by the paint, while a display's data route requires a
// session cookie — on a third-party host the chrome paints and the data does
// not."
//
// SEPARATE FROM THE CREDENTIAL, AND THAT IS THE POINT. The island credential is
// worth exactly ONE PAINT and is spent by that paint; a display that then asks
// for data has nothing left to present, and reusing the credential would mean
// either making it multi-use (losing the replay bound the whole design rests on)
// or letting a paint token buy an unbounded number of queries. So the data road
// gets its OWN bearer, under its OWN key label, with its OWN short life — and
// the credential is never accepted on the data road, which is structural here
// rather than remembered: the two seals cannot open each other.
//
// SEALED TO THE PINNED CONFIGURATION DIGEST. This is the field that makes the
// capability tell the truth about WHICH work it may fetch data for. A display
// draws a configuration the content channel handed it (enabler 0.3) at the
// gate's pinned revision; the data road must serve THAT configuration and no
// other. Sealing its digest means a capability minted for the reviewed
// configuration cannot be replayed against a later one — the drawn chrome and
// the fetched numbers are on the same revision, or there are no numbers.
//
// THE LIVE RE-CHECK IS ON EVERY CALL, not once per island. A data road is a
// long-lived surface that may issue many calls; access can be withdrawn between
// two of them, and the enabler says the re-check happens per call for exactly
// that reason. The decision module owns that (`review-island-data-serving.ts`).

import {
  openCapability,
  sealCapability,
  type SealedCapabilitySpec,
} from "@/lib/lifecycle/island-sealed-capability";

/**
 * How long a minted data capability stays usable, in seconds.
 *
 * SHORT — one minute, the island credential's own life — because a data
 * capability is presented by code the display already has mounted, and that code
 * re-resolves when the card does. A reader never meets this clock; a copied
 * address does.
 */
export const REVIEW_ISLAND_DATA_CAPABILITY_TTL_SECONDS = 60;

/** The header a display's data road presents its capability on. A HEADER, not a
 *  query parameter: unlike a subresource `src`, a data call is a `fetch()` the
 *  display controls, so the capability need never enter a URL, an access log or
 *  a referrer chain. */
export const REVIEW_ISLAND_DATA_CAPABILITY_HEADER = "x-cinatra-island-data-capability";

const SPEC: SealedCapabilitySpec = {
  // This capability's OWN label — never the byte capability's, never the island
  // credential's, never the capture capability's.
  keyLabel: "cinatra:review-island-data-capability:v1",
  ttlSeconds: REVIEW_ISLAND_DATA_CAPABILITY_TTL_SECONDS,
};

/** Everything a data capability binds. Every field is re-checked on every call. */
export interface ReviewIslandDataCapabilityPayload {
  /** Tenant. The only org the sealed reads may ever run against. */
  orgId: string;
  /** THE ACTOR — the cinatra principal the widget login produced. */
  userId: string;
  /** The `cwu_` token's own id — the revocation handle. */
  jti: string;
  /** The registered connect site the widget turn was authenticated for. */
  siteId: string;
  /** The CMS client bound to that site. */
  client: string;
  /** The canonical instance the origin resolved to at login. */
  instanceId: string;
  /** The widget agent the `cwu_` token is bound to. */
  agentSlug: string;
  /** THE RUN. */
  runId: string;
  /** THE GATE. */
  reviewTaskId: string;
  /** THE ARTIFACT whose display is asking. */
  artifactId: string;
  /** THE REPRESENTATION the gate pinned. */
  representationRevisionId: string;
  /** THE PINNED CONFIGURATION DIGEST the display was handed on its props. */
  configurationDigest: string;
}

export interface VerifiedReviewIslandDataCapability
  extends ReviewIslandDataCapabilityPayload {
  expiresAt: number;
}

const FIELDS = ["o", "u", "j", "s", "c", "i", "n", "r", "g", "a", "v", "h"] as const;

/**
 * Mint a data capability for a reader the caller has ALREADY authorized for this
 * gate, this pinned target and this configuration. Minting is not an
 * authorization step; it is the transport for one that already happened.
 */
export function mintReviewIslandDataCapability(
  payload: ReviewIslandDataCapabilityPayload,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): string | null {
  return sealCapability(
    SPEC,
    {
      o: payload.orgId,
      u: payload.userId,
      j: payload.jti,
      s: payload.siteId,
      c: payload.client,
      i: payload.instanceId,
      n: payload.agentSlug,
      r: payload.runId,
      g: payload.reviewTaskId,
      a: payload.artifactId,
      v: payload.representationRevisionId,
      h: payload.configurationDigest,
    },
    options,
  );
}

/**
 * Open a data capability and check its own expiry. `null` for anything that is
 * not a live one of ours — including an island credential, a byte capability or
 * a capture capability presented here, which cannot decode under this label.
 */
export function verifyReviewIslandDataCapability(
  encoded: string | null | undefined,
  options?: { nowSeconds?: number },
): VerifiedReviewIslandDataCapability | null {
  const opened = openCapability(SPEC, encoded, FIELDS, options);
  if (!opened) return null;
  return {
    orgId: opened.fields.o,
    userId: opened.fields.u,
    jti: opened.fields.j,
    siteId: opened.fields.s,
    client: opened.fields.c,
    instanceId: opened.fields.i,
    agentSlug: opened.fields.n,
    runId: opened.fields.r,
    reviewTaskId: opened.fields.g,
    artifactId: opened.fields.a,
    representationRevisionId: opened.fields.v,
    configurationDigest: opened.fields.h,
    expiresAt: opened.expiresAt,
  };
}

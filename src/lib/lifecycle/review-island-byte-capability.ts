import "server-only";

// THE ISLAND-SCOPED BYTE CAPABILITY (enabler 0.6 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The island-scoped byte capability and
// its serving route, sealed to the exact gate, artifact and revision the gate
// pinned."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "both artifact byte routes are
// cookie-only, so inside a third-party application every media display paints
// nothing and the fallback's links are dead ends."
//
// WHY A BEARER IN A URL, AGAIN. A display paints bytes with `<img src>`,
// `<video src>` or an `<object data>` — subresource loads that carry no
// Authorization header, no custom header and, inside a cross-site frame, no
// ambient cookie. The URL IS the whole request. This is the same reasoning, and
// deliberately the same construction, as the capture capability and the island
// credential; the difference is what it may reach.
//
// WHAT IT MAY REACH, EXACTLY: ONE representation revision of ONE artifact that
// ONE gate pinned. Not a prefix, not a wildcard, not "the artifact's latest".
// The serving path proves the sealed (artifact, revision) pair is in that gate's
// FROZEN pinned set before a byte is read, so a capability minted for gate A
// cannot fetch gate B's bytes even when both capabilities are genuine.
//
// AND IT IS NOT THE ISLAND CREDENTIAL. The island credential is worth exactly
// one paint and is spent by that paint; a card that framed the island would have
// nothing left to hand its media displays. The byte capability is a SEPARATE
// bearer under its own key label with its own life — which is also why the two
// can never be opened as one another.
//
// DISPOSITION IS SEALED, NOT REQUESTED. `preview` (inline) and `download`
// (attachment) are two different answers about the same bytes, and letting the
// URL's holder choose would let a preview-only capability be turned into a
// download. The minting surface decides, and the seal carries the decision.

import {
  openCapability,
  sealCapability,
  type SealedCapabilitySpec,
} from "@/lib/lifecycle/island-sealed-capability";

/**
 * How long a minted byte capability stays fetchable, in seconds.
 *
 * FIVE MINUTES, the capture capability's life and for its reason: a media
 * element may be mounted, scrolled away from and re-fetched within one reading,
 * and the card re-resolves on mount, on focus and on reload — so a reader never
 * meets this clock and only a copied address does. It stays well below the
 * `cwu_` user token's own 15-minute life, so a byte URL can never outlive the
 * session that was allowed to see it.
 */
export const REVIEW_ISLAND_BYTE_CAPABILITY_TTL_SECONDS = 300;

/** The query parameter the byte route reads its capability from. */
export const REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM = "bc";

/** The island byte route's own path — one route, one shape. */
export const REVIEW_ISLAND_BYTE_ROUTE = "/api/lifecycle-views/artifact-bytes";

const SPEC: SealedCapabilitySpec = {
  // This capability's OWN label. A byte capability, a data capability, an island
  // credential, a capture capability and a card ref are five different keys.
  keyLabel: "cinatra:review-island-byte-capability:v1",
  ttlSeconds: REVIEW_ISLAND_BYTE_CAPABILITY_TTL_SECONDS,
};

/** How the bytes are served. Sealed by the minter, never chosen by the holder. */
export type IslandByteDisposition = "preview" | "download";

/** Everything an island byte capability binds. Every field is re-checked live. */
export interface ReviewIslandByteCapabilityPayload {
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
  /** The ONE artifact whose bytes this capability may fetch. */
  artifactId: string;
  /** The ONE representation revision of that artifact — the gate's pin. */
  representationRevisionId: string;
  /** Inline or attachment. Sealed, so the holder cannot upgrade one to the other. */
  disposition: IslandByteDisposition;
}

export interface VerifiedReviewIslandByteCapability
  extends ReviewIslandByteCapabilityPayload {
  /** Unix seconds the capability stops being fetchable. */
  expiresAt: number;
}

/** The wire form. Single-letter keys keep the sealed plaintext — and therefore
 *  the URL — small; the mapping never leaves this module. */
const FIELDS = ["o", "u", "j", "s", "c", "i", "n", "r", "g", "a", "v", "d"] as const;

/**
 * Mint a byte capability for a reader the caller has ALREADY authorized for this
 * gate and this pinned target. Minting is not an authorization step; it is the
 * transport for one that already happened.
 */
export function mintReviewIslandByteCapability(
  payload: ReviewIslandByteCapabilityPayload,
  options?: { nowSeconds?: number; ttlSeconds?: number },
): string | null {
  if (payload.disposition !== "preview" && payload.disposition !== "download") return null;
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
      d: payload.disposition,
    },
    options,
  );
}

/**
 * Open a byte capability and check its own expiry. `null` for anything that is
 * not a live one of ours; the serving path turns every `null` into the same 404.
 */
export function verifyReviewIslandByteCapability(
  encoded: string | null | undefined,
  options?: { nowSeconds?: number },
): VerifiedReviewIslandByteCapability | null {
  const opened = openCapability(SPEC, encoded, FIELDS, options);
  if (!opened) return null;
  const disposition = opened.fields.d;
  if (disposition !== "preview" && disposition !== "download") return null;
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
    disposition,
    expiresAt: opened.expiresAt,
  };
}

/** The same-origin byte URL a display puts in `<img src>` / `<video src>` /
 *  a download link. The capability is the whole request; there are no other
 *  identifiers in the address, so nothing about it can be edited into another
 *  artifact. */
export function reviewIslandByteUrl(capability: string): string {
  return `${REVIEW_ISLAND_BYTE_ROUTE}?${REVIEW_ISLAND_BYTE_CAPABILITY_QUERY_PARAM}=${encodeURIComponent(capability)}`;
}

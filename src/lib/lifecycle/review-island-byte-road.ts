import "server-only";

// ---------------------------------------------------------------------------
// THE BYTE ROAD'S ADOPTION — wave 3 of `PLAN: Agents Lifecycle (D) — Review`
// (cinatra#3091, epic #3087).
//
// THE PLAN'S OWN WORDS, §6.7: "Inside a third-party application every media
// display paints nothing until wave 3 retrofits it: the byte capability and its
// serving route landed with the sibling epic's W3 — sealed to the gate, the
// artifact and the revision — and wave 3 is the displays' adoption of them, not
// their construction. Displays never fetch host routes on their own after wave
// 3."
//
// SO THIS MODULE CONSTRUCTS NOTHING. The capability, its seal, its five-minute
// life and its serving route all exist; they simply had no caller. This is the
// caller: one minter, closed over ONE reader and ONE gate, that answers a pinned
// (artifact, revision) pair with the two addresses a display may paint from.
//
// A REFERENCE, NEVER A BYTE. Nothing here opens a blob, decodes a stream or
// buffers a payload. The minter's whole input is two identifiers and its whole
// output is a URL, so a byte of the reviewed work cannot enter this module, the
// props snapshot built from it, or anything assembled downstream from that
// snapshot. `assertNoInlineBytesInRendererProps` on the props contract is the
// machine-checked half of that sentence; this module's shape is the other half.
//
// THE SIX KINDS ARE A CLOSED SET, and they are the six the plan enumerates:
// "`audio-artifact`, `video-artifact`, `image-artifact`, `pdf-artifact`,
// `document-artifact`, `zip-artifact`". They are exactly the forms the content
// channel has NO class for — "a `file` revision whose mime is not a projected
// text form — an image, a pdf, an archive — has NO content class: its bytes
// reach the display through the byte capability of enabler 0.6, not through this
// channel". The two roads therefore partition the fleet's forms rather than
// overlapping, and a form that gained a text projection must lose the byte road
// in the same edit.
//
// THE SET IS SPELLED OUT HERE rather than derived from the channel's predicate
// on purpose: this module is reached from the island's own route graph, whose
// module budget the route-graph ratchet locks, and the channel's builder pulls
// the object-backed contract behind it. A lockstep test pins the partition.
// ---------------------------------------------------------------------------

import {
  mintReviewIslandByteCapability,
  reviewIslandByteUrl,
  type IslandByteDisposition,
} from "@/lib/lifecycle/review-island-byte-capability";

/**
 * The six media kinds of wave 3, by the forms their displays declare.
 *
 * A trailing `/` entry is a family prefix (the form the display registered for
 * is `image/*`); every other entry is an exact form.
 */
export const MEDIA_BYTE_ROAD_KINDS = Object.freeze({
  /** `image-artifact` — and the screenshot display's picture. */
  image: Object.freeze(["image/"]),
  /** `video-artifact`, whose declared forms this wave brings to its accepts. */
  video: Object.freeze(["video/"]),
  /** `audio-artifact`. */
  audio: Object.freeze(["audio/"]),
  /** `pdf-artifact` — and the slide deck's one accepted form. */
  pdf: Object.freeze(["application/pdf"]),
  /** `document-artifact` — the office forms, the presentation among them. */
  document: Object.freeze([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
  ]),
  /** `zip-artifact`. */
  archive: Object.freeze(["application/zip", "application/x-zip-compressed"]),
} as const);

/** One of the six kinds the byte road serves. */
export type MediaByteRoadKind = keyof typeof MEDIA_BYTE_ROAD_KINDS;

/**
 * Which of the six media kinds a form belongs to, or `null` for a form that is
 * NOT on the byte road — the three browser fetchers' text forms among them,
 * which travel the content channel instead.
 *
 * Parameters are stripped and the form is lower-cased before matching, because
 * a stored mime may carry a charset and a display's declared form never does.
 */
export function mediaByteRoadKindFor(mime: string | null | undefined): MediaByteRoadKind | null {
  if (typeof mime !== "string") return null;
  const form = mime.toLowerCase().split(";")[0].trim();
  if (!form) return null;
  for (const [kind, forms] of Object.entries(MEDIA_BYTE_ROAD_KINDS)) {
    for (const candidate of forms) {
      if (candidate.endsWith("/") ? form.startsWith(candidate) : form === candidate) {
        return kind as MediaByteRoadKind;
      }
    }
  }
  return null;
}

/** The verified island reader a byte capability is minted for. */
export interface IslandBytePrincipal {
  orgId: string;
  userId: string;
  /** The `cwu_` token's own id — the capability's revocation handle. */
  jti: string;
  siteId: string;
  client: string;
  instanceId: string;
  /** The widget agent the token is bound to — re-checked live at serve time. */
  agentSlug: string;
}

/** The two addresses one pinned revision is painted and saved from. */
export interface IslandArtifactByteUrls {
  preview: string | null;
  download: string | null;
}

/**
 * How a surface addresses one pinned revision's bytes.
 *
 * A FUNCTION, not a flag, for the reason the capture pair's minter is one: the
 * props builder must stay unable to construct an island address by itself. It
 * transports whatever the surface's minter returns and has no idea a capability
 * exists.
 */
export type ArtifactByteUrlMinter = (input: {
  artifactId: string;
  representationRevisionId: string;
  /** The pinned revision's stored form. The road serves the six media kinds
   *  and only those, so the minter has to be told which form it is looking at
   *  rather than assuming every file belongs to it. */
  mime: string | null;
}) => IslandArtifactByteUrls | null;

/**
 * Build the byte minter for ONE reader on ONE gate.
 *
 * Exported on its own because it is the whole trust statement of the mint half:
 * every field except the target's own two ids is FIXED by the closure, so a
 * loader walking a gate's pinned set cannot vary the principal, the site or the
 * gate between two panels.
 *
 * MINTING IS NOT AUTHORIZING. The serving path re-proves the live `cwu_` row,
 * live run READ access and the gate's own frozen pinned set before a byte is
 * read; a capability minted for a target the reader may not see produces an
 * address that 404s. The caller still authorizes first — that is the surface's
 * job — but a mistake there is contained rather than exploitable.
 *
 * A capability that cannot be sealed degrades to `null`, so the display draws
 * its named gap and never a broken picture.
 */
export function buildIslandArtifactByteMinter(params: {
  principal: IslandBytePrincipal;
  runId: string;
  reviewTaskId: string;
}): ArtifactByteUrlMinter {
  const { principal, runId, reviewTaskId } = params;
  const seal = (
    artifactId: string,
    representationRevisionId: string,
    disposition: IslandByteDisposition,
  ): string | null => {
    const sealed = mintReviewIslandByteCapability({
      orgId: principal.orgId,
      userId: principal.userId,
      jti: principal.jti,
      siteId: principal.siteId,
      client: principal.client,
      instanceId: principal.instanceId,
      agentSlug: principal.agentSlug,
      runId,
      reviewTaskId,
      artifactId,
      representationRevisionId,
      disposition,
    });
    return sealed ? reviewIslandByteUrl(sealed) : null;
  };
  return ({ artifactId, representationRevisionId, mime }) => {
    // THE PARTITION IS ENFORCED HERE, not merely described above. The plan puts
    // the byte capability behind "the six media displays and the CMS picture
    // pair", and the three browser fetchers' forms travel the content channel
    // under its cap instead. Minting for every file-backed revision would hand
    // a json, csv or cms-fields display a sealed capability to the FULL raw
    // revision beside its capped projection — a wider grant than the wave
    // authorizes, arrived at by omission. A form off the road gets no island
    // address and falls back to the session one, which is exactly what it had.
    if (mediaByteRoadKindFor(mime) === null) return null;
    return {
      // TWO SEALED ADDRESSES, never one address with a switch. The disposition
      // is part of the seal precisely so a preview cannot be edited into a
      // download.
      preview: seal(artifactId, representationRevisionId, "preview"),
      download: seal(artifactId, representationRevisionId, "download"),
    };
  };
}

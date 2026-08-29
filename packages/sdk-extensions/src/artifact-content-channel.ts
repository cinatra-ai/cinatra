// The VERSIONED SERVER CONTENT CHANNEL — the author-facing contract (enabler
// 0.3 of `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The versioned server content channel:
// a discriminated projection with caps, an asynchronous props builder that
// reads the pinned revision on the server, and a size assertion at the
// serialization boundary — carrying one projection per content class — text for
// text forms, configuration for platform-state types, and a versioned page
// projection for remote-content types — each a contract defined here and wired
// for its consumers in the sibling plan."
//
// WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "display props carry no content field
// at all today, so every display reaches bytes through the browser — which is
// exactly what dies inside a third-party application."
//
// WHY IT IS A LEAF. A display types its props against
// `@cinatra-ai/sdk-extensions/artifact-renderer-props`; the content it draws
// arrives on those props, so the projection has to be nameable from the same
// leaf tree. This module is SCHEMA-ONLY and HOST-NEUTRAL: pure types plus three
// integer constants and one pure predicate. It imports nothing, so it costs a
// browser bundle nothing.
//
// THE HOST OWNS THE BUILDER. `src/lib/artifacts/artifact-content-channel.ts`
// holds the asynchronous, server-side builder that reads the pinned revision
// and the assertion that runs at the serialization boundary. Nothing here reads
// anything.

/**
 * The projection ABI version. SEPARATE from the props-contract version: a
 * display that understands props v1 may still be handed a v1 content channel,
 * and this integer is what a future channel change ratchets.
 */
export const ARTIFACT_CONTENT_CHANNEL_VERSION = 1;

/**
 * The CAPS, in bytes of the serialized projection, one per content class.
 *
 * A cap is not a rendering preference — it is the reason this channel can exist
 * at all. The projection crosses the RSC→client serialization boundary inside
 * the props snapshot, so an uncapped projection would let one large artifact
 * turn every card that mentions it into a multi-megabyte payload. Over the cap
 * the channel degrades HONESTLY (`truncated`, or a `none` with `over-cap`)
 * rather than silently shipping a prefix that reads as the whole work.
 */
export const ARTIFACT_CONTENT_CHANNEL_CAPS = Object.freeze({
  /** Text forms — a draft, a plain-text idea, a csv, a json document. */
  text: 256 * 1024,
  /** Platform-state types — a dashboard's pinned configuration record. */
  configuration: 128 * 1024,
  /** Remote-content types — the versioned page projection. */
  page: 64 * 1024,
  /**
   * OBJECT-BACKED types — the entry's own structured data (enabler 0.13). The
   * same ceiling the snapshot mint already enforces on the normalized row
   * (`SNAPSHOT_MAX_BYTES`), so a row that CAN be snapshotted can always be
   * projected: a display would otherwise be told "over-cap" about work the
   * reviewer is holding a decision on.
   */
  object: 256 * 1024,
} as const);

/** The four content classes, plus the absence that is not one. */
export type ArtifactContentClass = "text" | "configuration" | "page" | "object";

/** Why a projection carries no content. Named, never blank. */
export type ArtifactContentAbsence =
  /** The artifact's form belongs to no content class this channel projects. */
  | "unsupported-form"
  /** There is no pinned revision, or its substance could not be read. */
  | "absent"
  /** The content exists but exceeds its class cap and is not projectable. */
  | "over-cap";

/**
 * The DISCRIMINATED PROJECTION a display receives on its props.
 *
 * ONE PROJECTION PER CONTENT CLASS, and a display switches on `kind` — it never
 * infers a class from a mime, and it never fetches. A display that does not
 * understand a kind renders its own floor; it is never handed bytes it did not
 * ask for.
 */
export type ArtifactContentProjection =
  | {
      kind: "text";
      /** The channel ABI version this projection was built at. */
      channelVersion: number;
      /** The pinned revision the text was read from — never "latest". */
      representationRevisionId: string;
      /** The text itself, already decoded. Always within the text cap. */
      text: string;
      /** `utf-8` today; named so a future encoding is a value, not a guess. */
      encoding: "utf-8";
      /** Bytes of the FULL content, before any truncation — what the pinned
       *  revision actually holds, so a display can say "showing the first N of
       *  M" rather than pretending it has the whole draft. */
      byteLength: number;
      /** Bytes ACTUALLY CARRIED on this projection. This is the number the cap
       *  binds, and the number the serialization-boundary assertion checks. */
      projectedByteLength: number;
      /** The cap this projection was built under, stamped by the host from the
       *  canonical class caps below. Carried rather than looked up so the
       *  assertion at the serialization boundary is pure arithmetic over the
       *  snapshot — the props module measures what it is holding and reaches for
       *  nothing — and so a display can say "the first N of M" honestly. */
      cap: number;
      /** True when `text` is a prefix of a larger content (cap reached). */
      truncated: boolean;
    }
  | {
      kind: "configuration";
      channelVersion: number;
      representationRevisionId: string;
      /** The pinned configuration record, as plain JSON data. */
      configuration: unknown;
      /** A stable digest of the pinned configuration — the value a data
       *  capability is sealed to, so a display's live-data road and its drawn
       *  configuration can never disagree about which revision they are on. */
      digest: string;
      byteLength: number;
      /** Bytes ACTUALLY CARRIED — the cap's subject. */
      projectedByteLength: number;
      /** The cap this projection was built under. */
      cap: number;
    }
  | {
      kind: "page";
      channelVersion: number;
      representationRevisionId: string;
      /** The page projection's OWN version, independent of the channel's: a
       *  remote-content type may ratchet its page shape without moving the
       *  channel, which is the whole point of calling it versioned. */
      pageVersion: number;
      /** The captured page fields, as plain JSON data. Never a live fetch. */
      page: unknown;
      byteLength: number;
      /** Bytes ACTUALLY CARRIED — the cap's subject. */
      projectedByteLength: number;
      /** The cap this projection was built under. */
      cap: number;
    }
  | {
      /**
       * THE OBJECT-BACKED PROJECTION (enabler 0.13 of `PLAN: Agents Lifecycle
       * (C)`): "the host and SDK props union (the live object projection, or a
       * minted snapshot revision, discriminated)".
       *
       * §3, on the contract: "Its display receives a discriminated projection —
       * the live object data, or a minted snapshot revision — AND SAYS WHICH OF
       * THE TWO IT IS SHOWING."
       *
       * `source` is that discriminator, and it is the whole point: an
       * object-backed row may be mutable, so a display drawing live data is
       * drawing something that can change under the reader, while a display
       * drawing a snapshot is drawing exactly what a decision binds. A display
       * that could not tell them apart would label a moving row as reviewed
       * work.
       */
      kind: "object";
      channelVersion: number;
      /**
       * THE DISCRIMINATOR, ENCODED IN THE TYPE and not merely described: the
       * `live` arm's revision is `null` and the `snapshot` arm's is a string, so
       * a display that has checked `source` has already narrowed the revision,
       * and neither wrong combination — a live projection naming a revision, a
       * snapshot naming none — is expressible at all.
       */
      source: "live";
      representationRevisionId: null;
      /** The object type whose declared object-data schema the data satisfies. */
      objectType: string;
      /** The entry's structured data, as plain JSON. */
      data: unknown;
      /** A stable digest of the projected data. On a snapshot this is the
       *  snapshot's own content digest, so a display and the reviewer's
       *  decision provably speak about the same bytes. */
      digest: string;
      byteLength: number;
      /** Bytes ACTUALLY CARRIED — the cap's subject. */
      projectedByteLength: number;
      /** The cap this projection was built under. */
      cap: number;
    }
  | {
      /** THE SNAPSHOT ARM of the object-backed projection: the pinned,
       *  immutable revision a decision binds. Its revision is a string by the
       *  type, so a display that has checked `source` needs no null check and
       *  cannot draw a snapshot that names no revision. */
      kind: "object";
      channelVersion: number;
      source: "snapshot";
      /** The pinned revision this projection draws. */
      representationRevisionId: string;
      /** The object type whose declared object-data schema the data satisfies. */
      objectType: string;
      /** The entry's structured data, as plain JSON. */
      data: unknown;
      /** The snapshot's own content digest, so a display and the reviewer's
       *  decision provably speak about the same bytes. */
      digest: string;
      byteLength: number;
      /** Bytes ACTUALLY CARRIED — the cap's subject. */
      projectedByteLength: number;
      /** The cap this projection was built under. */
      cap: number;
    }
  | {
      kind: "none";
      channelVersion: number;
      /** Null when there is no pinned revision at all. */
      representationRevisionId: string | null;
      reason: ArtifactContentAbsence;
    };

/**
 * The cap for a projection's own class. `none` has no cap — it carries no
 * content by construction.
 */
export function artifactContentCapFor(kind: ArtifactContentClass): number {
  return ARTIFACT_CONTENT_CHANNEL_CAPS[kind];
}

/**
 * Is this projection within its class cap?
 *
 * PURE, and deliberately available to both sides: the host asserts it at the
 * serialization boundary (a violation is a contract bug, not a render-time
 * surprise), and a display may cheaply re-check what it was handed.
 */
export function isArtifactContentWithinCap(projection: ArtifactContentProjection): boolean {
  if (projection.kind === "none") return true;
  // The cap binds what is CARRIED, never what the revision holds: a truncated
  // text projection is within cap precisely because the host cut it to fit,
  // and an untruncated one over cap is the contract violation this catches.
  // Both the STAMPED cap and the canonical one must hold, so a projection
  // cannot buy room by stamping a larger cap on itself.
  return (
    projection.projectedByteLength <= projection.cap &&
    projection.projectedByteLength <= artifactContentCapFor(projection.kind)
  );
}

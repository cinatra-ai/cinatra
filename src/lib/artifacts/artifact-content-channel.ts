// The VERSIONED SERVER CONTENT CHANNEL — the HOST half (enabler 0.3 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER: "a discriminated projection with caps, an ASYNCHRONOUS PROPS
// BUILDER THAT READS THE PINNED REVISION ON THE SERVER, and a SIZE ASSERTION AT
// THE SERIALIZATION BOUNDARY — carrying one projection per content class."
//
// THE SHAPE of the projection is the SDK leaf's
// (`@cinatra-ai/sdk-extensions/artifact-content-channel`) so a display can name
// it without reaching into the host. THIS module is the part a display must
// never be able to run: the class resolution, the server-side read of the
// pinned revision, the caps applied to real bytes, and the assertion the props
// builder runs before anything crosses to a client renderer.
//
// PURE OVER PORTS. The read is an injected port, so the whole matrix — every
// class, every cap, every absence — is provable without a database, and the
// server binder supplies the real blob/store read exactly once.
//
// IT READS THE PINNED REVISION, NEVER "LATEST". Every projection carries the
// `representationRevisionId` it was built from, which is the revision the gate
// froze. That is the difference between a card that shows what was approved and
// a card that shows whatever the artifact became afterwards.

import {
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  artifactContentCapFor,
  isArtifactContentWithinCap,
  type ArtifactContentClass,
  type ArtifactContentProjection,
} from "@cinatra-ai/sdk-extensions/artifact-content-channel";

export {
  ARTIFACT_CONTENT_CHANNEL_CAPS,
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  artifactContentCapFor,
  isArtifactContentWithinCap,
  type ArtifactContentAbsence,
  type ArtifactContentClass,
  type ArtifactContentProjection,
} from "@cinatra-ai/sdk-extensions/artifact-content-channel";

/**
 * The TEXT forms this channel projects, by mime.
 *
 * A CLOSED SET on purpose. "Text for text forms" is a statement about what may
 * be handed to a display as a decoded string, not about what happens to be
 * valid UTF-8: an `image/svg+xml` is text on the wire and is emphatically NOT a
 * text projection, because a display that treats it as prose would be handed
 * active markup. Every entry here is a non-executable document form the host
 * already serves inline.
 */
const TEXT_PROJECTION_MIMES: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "text/csv",
  "application/json",
]);

/** The representation forms the substrate admits (`representation_form_chk`). */
export type ArtifactRepresentationForm = "file" | "connectorRef" | "dashboard";

/**
 * Resolve the CONTENT CLASS for a pinned revision from its form and mime — the
 * plan's three classes and nothing else.
 *
 *   file + a text mime  → `text`          (text forms)
 *   dashboard           → `configuration` (platform-state types)
 *   connectorRef        → `page`          (remote-content types)
 *
 * A `file` revision whose mime is not a projected text form — an image, a pdf,
 * an archive — has NO content class: its bytes reach the display through the
 * byte capability of enabler 0.6, not through this channel. Returning null here
 * is the honest answer, and the projection that follows says `unsupported-form`.
 */
export function resolveArtifactContentClass(input: {
  form: ArtifactRepresentationForm;
  mime: string;
}): ArtifactContentClass | null {
  switch (input.form) {
    case "dashboard":
      return "configuration";
    case "connectorRef":
      return "page";
    case "file":
      return TEXT_PROJECTION_MIMES.has(input.mime.toLowerCase().split(";")[0].trim())
        ? "text"
        : null;
  }
}

/** What the server read of a pinned revision yields, per class. */
export type PinnedRevisionSubstance =
  | { class: "text"; text: string }
  | { class: "configuration"; configuration: unknown; digest: string }
  | { class: "page"; pageVersion: number; page: unknown };

/** The one injected read. Null ⇒ the substance could not be read at all. */
export interface ArtifactContentChannelPorts {
  /**
   * Read the substance of ONE pinned revision, already tenant-checked by the
   * caller. Asynchronous BY CONTRACT: the text arm streams bytes off the blob
   * store, and the plan asks for an asynchronous builder precisely so no
   * display is ever tempted to fetch them itself.
   */
  readPinnedSubstance(input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    contentClass: ArtifactContentClass;
  }): Promise<PinnedRevisionSubstance | null> | PinnedRevisionSubstance | null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    // A circular or otherwise unserializable configuration is not projectable.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Truncate a string to at most `capBytes` UTF-8 bytes WITHOUT splitting a code
 * point. A prefix that ends mid-sequence would reach the client as a replacement
 * character and read as corruption of the work, so the cut walks back to the
 * last whole character.
 */
export function truncateToUtf8Bytes(value: string, capBytes: number): string {
  if (capBytes <= 0) return "";
  if (utf8Bytes(value) <= capBytes) return value;
  const buf = Buffer.from(value, "utf8");
  // WALK THE CUT BACK OFF A CONTINUATION BYTE, never off a rendered character.
  // A UTF-8 continuation byte is `10xxxxxx`; while the byte AT the cut is one,
  // the cut lands inside a code point, so step back until it lands on a lead
  // byte (or on 0) — at which point every byte before it is a whole character.
  //
  // The earlier rule compared the decoded tail with the input's own last
  // character, and that was wrong in a way the cap could not survive: a value
  // whose LAST character is itself a genuine U+FFFD kept the replacement
  // character the split had produced, and the returned prefix was then TWO bytes
  // OVER the cap — which `assertContentProjectionWithinCap` throws on, turning
  // one artifact into a broken card. Counting bytes cannot be fooled by content.
  let end = capBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

// The NAMED ABSENCE lives on the props contract (`artifact-renderer-props.ts`),
// which every consumer of it already imports and which imports nothing at value
// level — the route-graph ratchet's reason, stated there. Re-exported here so a
// reader of the channel finds it where they look for it, and so there is still
// exactly one implementation.
export { absentArtifactContent } from "@/lib/artifacts/artifact-renderer-props";

// The object-backed projection's digest lives with the contract that mints it
// (enabler 0.13), so a snapshot's digest and a live read's digest are derived by
// one function.
import { objectProjectionDigest } from "@/lib/artifacts/object-backed-contract";

const none = (
  representationRevisionId: string | null,
  reason: "unsupported-form" | "absent" | "over-cap",
): ArtifactContentProjection => ({
  kind: "none",
  channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
  representationRevisionId,
  reason,
});

/**
 * BUILD the content projection for one pinned revision — the asynchronous props
 * builder the enabler names.
 *
 * Order is load-bearing: the class is resolved from the FORM the substrate
 * recorded (never from a caller claim), the read runs only for a class this
 * channel projects, and the cap is applied to the bytes that actually came back.
 * Every failure is a NAMED absence, never a throw and never a silent empty
 * string — a display must be able to tell "there is nothing pinned" from "it was
 * too large to carry".
 */
export async function buildArtifactContentProjection(
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string | null;
    form: ArtifactRepresentationForm | null;
    mime: string | null;
  },
  ports: ArtifactContentChannelPorts,
): Promise<ArtifactContentProjection> {
  const { representationRevisionId } = input;
  if (!representationRevisionId || !input.form || !input.mime) {
    return none(representationRevisionId ?? null, "absent");
  }

  const contentClass = resolveArtifactContentClass({ form: input.form, mime: input.mime });
  if (!contentClass) return none(representationRevisionId, "unsupported-form");

  const substance = await ports.readPinnedSubstance({
    orgId: input.orgId,
    artifactId: input.artifactId,
    representationRevisionId,
    contentClass,
  });
  if (!substance) return none(representationRevisionId, "absent");

  const cap = artifactContentCapFor(contentClass);

  if (substance.class === "text") {
    const byteLength = utf8Bytes(substance.text);
    const text = byteLength <= cap ? substance.text : truncateToUtf8Bytes(substance.text, cap);
    return {
      kind: "text",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId,
      text,
      encoding: "utf-8",
      byteLength,
      projectedByteLength: utf8Bytes(text),
      cap,
      truncated: byteLength > cap,
    };
  }

  if (substance.class === "configuration") {
    const byteLength = jsonBytes(substance.configuration);
    // A CONFIGURATION IS NOT TRUNCATABLE. Half a dashboard configuration is not
    // a smaller dashboard, it is a broken one — so an over-cap configuration is
    // an honest absence with its own reason, never a prefix.
    if (!Number.isFinite(byteLength) || byteLength > cap) {
      return none(representationRevisionId, "over-cap");
    }
    return {
      kind: "configuration",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId,
      configuration: substance.configuration,
      digest: substance.digest,
      byteLength,
      projectedByteLength: byteLength,
      cap,
    };
  }

  const byteLength = jsonBytes(substance.page);
  if (!Number.isFinite(byteLength) || byteLength > cap) {
    return none(representationRevisionId, "over-cap");
  }
  return {
    kind: "page",
    channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
    representationRevisionId,
    pageVersion: substance.pageVersion,
    page: substance.page,
    byteLength,
    projectedByteLength: byteLength,
    cap,
  };
}

/**
 * THE SIZE ASSERTION AT THE SERIALIZATION BOUNDARY.
 *
 * Called by `assertSerializableRendererProps` before a props snapshot crosses
 * into a client renderer. A projection over its own class cap is a HOST bug —
 * the builder above cannot produce one — so this throws rather than degrading:
 * silently shipping it would put the payload this channel exists to bound onto
 * every card that mentions the artifact.
 */
export function assertContentProjectionWithinCap(
  projection: ArtifactContentProjection,
): void {
  if (isArtifactContentWithinCap(projection)) return;
  const cap = projection.kind === "none" ? 0 : artifactContentCapFor(projection.kind);
  throw new Error(
    `renderer props: content projection "${projection.kind}" carries ` +
      `${projection.kind === "none" ? 0 : projection.projectedByteLength} bytes over its ${cap}-byte cap`,
  );
}

// ---------------------------------------------------------------------------
// THE OBJECT-BACKED PROJECTION (enabler 0.13 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3028 / epic #3023).
//
// §3, verbatim: "Its display receives a discriminated projection — the live
// object data, or a minted snapshot revision — and says which of the two it is
// showing."
//
// WHY IT IS NOT A `resolveArtifactContentClass` ARM. The other three classes are
// resolved from the SUBSTRATE'S recorded form and mime, because the substance
// lives in a representation. An object-backed row's substance is the row, and
// before its first mint there is no representation to read a form off at all —
// so the class cannot be derived from the substrate, and the caller who KNOWS
// which of the two it holds is the one that says so. That is the discriminator,
// and building it any other way would be guessing.
// ---------------------------------------------------------------------------

/**
 * Build the object-backed content projection.
 *
 * The `source` is the caller's, and the two arms are not interchangeable: a
 * `snapshot` names the pinned revision a decision binds, a `live` names none
 * because there is none. Passing a revision id with `live` is refused rather
 * than dropped — a projection that claimed to be live while naming a pinned
 * revision is precisely the confusion this discriminator exists to prevent.
 */
export function buildObjectContentProjection(input: {
  objectType: string;
  data: unknown;
  source: "live" | "snapshot";
  /** Required for `snapshot`; must be absent/null for `live`. */
  representationRevisionId?: string | null;
  /** The snapshot's own content digest. Computed from the carried data when the
   *  caller has none (the live arm always does). */
  digest?: string;
}): ArtifactContentProjection {
  const revisionId = input.representationRevisionId ?? null;
  if (input.source === "snapshot" && !revisionId) {
    return none(null, "absent");
  }
  if (input.source === "live" && revisionId) {
    throw new Error(
      "artifact content channel: a live object projection must name no pinned revision",
    );
  }

  const byteLength = jsonBytes(input.data);
  const cap = artifactContentCapFor("object");
  // AN OBJECT IS NOT TRUNCATABLE, for the configuration's reason: half a record
  // is not a smaller record, it is a wrong one. Over the cap is a named absence.
  if (!Number.isFinite(byteLength) || byteLength > cap) {
    return none(revisionId, "over-cap");
  }

  const common = {
    kind: "object",
    channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
    objectType: input.objectType,
    data: input.data,
    digest: input.digest ?? objectProjectionDigest(input.data),
    byteLength,
    projectedByteLength: byteLength,
    cap,
  } as const;
  // THE TWO ARMS ARE BUILT SEPARATELY because the props union states them
  // separately: `live` carries a null revision by its own type and `snapshot`
  // carries a string, so neither wrong combination can be constructed here
  // either. The guards above are what make the narrowing sound.
  return input.source === "snapshot"
    ? { ...common, source: "snapshot", representationRevisionId: revisionId! }
    : { ...common, source: "live", representationRevisionId: null };
}

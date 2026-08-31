import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

/**
 * The versioned, normalized, SERIALIZABLE props snapshot an extension-shipped
 * artifact renderer receives (cinatra#1629, epic #1620 S2, AC-5).
 *
 * A v1 renderer requests NO host ports (the S1 manifest contract) — it renders
 * ONLY from this host-supplied authorized snapshot. Every field here is plain
 * JSON data: row metadata, the resolved representation/content ref, host-
 * authorized URLs, and sanctioned action handles as navigational HREFS (never
 * closures / host context). Non-serializable host context (DB handles, the
 * request, server-action closures over `ctx`) NEVER crosses this boundary — the
 * renderer may run as a client component, so the RSC→client serialization
 * boundary must hold. {@link assertSerializableRendererProps} pins that.
 */
/**
 * The props-contract version this host builds at its ceiling.
 *
 * IT IS 2 SINCE WAVE 3 of `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091,
 * epic #3087): "the props version (0.4) on every display; the byte capability
 * and its serving route (0.6) for the six media displays and the CMS picture
 * pair". The version moved because the SNAPSHOT moved — it now carries the
 * island-scoped byte REFERENCE below, which a v1 snapshot has no field for.
 *
 * NOT A FLAG DAY, and that is the whole point of enabler 0.4's window: the host
 * still BUILDS v1 for a display that declares v1, so a fleet that has not moved
 * keeps drawing exactly as it did. What a v1 display does not get is the island
 * road — which is the incentive to move, not a regression.
 */
export const ARTIFACT_RENDERER_PROPS_API_VERSION = 2;

/**
 * The version at which the snapshot began carrying the byte reference.
 *
 * A SEPARATE NAME from the ceiling above, so the two can be read apart: the
 * ceiling is "what this host builds", and this is "the version a display must
 * declare to be handed the island road". They are equal today and the code
 * below compares against THIS one, so a later ceiling bump for an unrelated
 * field cannot silently retire the byte reference from v2 displays.
 */
export const ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION = 2;

/**
 * The CONTENT-CHANNEL ABI version (enabler 0.3 of `PLAN: Agents Lifecycle (C)`,
 * cinatra#3027), mirrored here.
 *
 * WHY A MIRROR AND NOT AN IMPORT. The canonical constant lives in the SDK leaf
 * (`@cinatra-ai/sdk-extensions/artifact-content-channel`) beside the projection
 * type and the class caps, and this module deliberately imports NOTHING at value
 * level: it is reachable from four route graphs whose module budgets are locked
 * by the route-graph ratchet, and every value import here lands on all four. So
 * the props contract keeps the integer and a lockstep test pins the two equal —
 * exactly the arrangement the props ABI version itself already has between this
 * module and its SDK-leaf mirror.
 */
export const ARTIFACT_CONTENT_CHANNEL_VERSION = 1;

/**
 * The CANONICAL per-class byte caps, mirrored here for the same route-budget
 * reason as the version above and pinned equal to the SDK leaf's
 * `ARTIFACT_CONTENT_CHANNEL_CAPS` by the enabler 0.3 suite.
 *
 * WHY THE ASSERTION BELOW NEEDS THEM. A projection carries the cap it was
 * stamped with, and checking only against that stamp lets a projection buy room
 * by stamping a larger number on itself — the boundary would then pass a payload
 * the channel exists to bound. The SDK leaf's own predicate already requires
 * BOTH the stamped cap and the canonical one; the host boundary must require
 * both too, or the two halves of one contract disagree.
 */
export const ARTIFACT_CONTENT_CHANNEL_CAPS_MIRROR: Readonly<Record<string, number>> =
  Object.freeze({
    text: 256 * 1024,
    configuration: 128 * 1024,
    page: 64 * 1024,
  });

/**
 * The NAMED ABSENCE of a content projection — what a caller that has not wired
 * the content channel passes, so that it is VISIBLY unwired ("each a contract
 * defined here and wired for its consumers in the sibling plan") rather than
 * reading as a wired caller that found nothing.
 *
 * It is exported from HERE, not from the channel module, for the same
 * route-budget reason as the constant above: the consumers that need it — the
 * artifact page, the library glyph, the review binder — already import this
 * module, and the ratchet is what says so.
 */
export function absentArtifactContent(
  representationRevisionId: string | null,
  reason: "unsupported-form" | "absent" | "over-cap" = "absent",
): ArtifactContentProjection {
  return {
    kind: "none",
    channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
    representationRevisionId,
    reason,
  };
}

export interface ArtifactRendererProps {
  /** The props-contract version this snapshot conforms to. A renderer declares
   * the `propsApiVersion` it expects; the host refuses to mount a renderer whose
   * expected version this snapshot does not satisfy (loader compat check). */
  propsApiVersion: number;
  /** Row metadata (a projection of the authorized `ArtifactSummary`). */
  artifact: {
    id: string;
    title: string | null;
    objectType: string;
    mime: string;
    size: number;
    createdAt: string;
    updatedAt: string;
    ownerLevel: ArtifactSummary["ownerLevel"];
    visibility: ArtifactSummary["visibility"];
    sourceUrl: string | null;
  };
  /** The resolved representation to serve (null when the artifact has no
   * materialized representation). */
  representation: {
    revisionId: string;
    mime: string;
  } | null;
  /** Host-authorized URLs. Already access-checked by the host before this
   * snapshot is built — the renderer just references them. */
  urls: {
    preview: string | null;
    download: string | null;
  };
  /** The resolved effective identity, flattened to plain data (epic #1785):
   * the type's defining `extension`, or `no-primary` with a null extension.
   * The retired binding/classic `basis` + the `selectable` activation barrier
   * are gone — a type-driven identity is either an installed extension or not. */
  identity: {
    kind: EffectiveIdentity["kind"];
    extension: string | null;
  };
  /** Sanctioned action handles — SERIALIZABLE navigational hrefs only. v1
   * renderers request no ports, so actions are host-authorized links, never
   * server-action closures. */
  actions: {
    download: string | null;
    openInSource: string | null;
  };
  /**
   * THE VERSIONED SERVER CONTENT CHANNEL (enabler 0.3 of
   * `PLAN: Agents Lifecycle (C)`, cinatra#3027).
   *
   * The discriminated content projection, read from the PINNED revision ON THE
   * SERVER and carried here. Before this field existed "display props carry no
   * content field at all, so every display reaches bytes through the browser —
   * which is exactly what dies inside a third-party application".
   *
   * A display switches on `content.kind`; it never infers a class from the mime
   * and it never fetches. `none` is a first-class answer with a named reason.
   * The projection is capped per content class and the cap is asserted at the
   * serialization boundary below.
   */
  content: ArtifactContentProjection;
  /**
   * THE ISLAND-SCOPED BYTE REFERENCE (props v2, wave 3 of
   * `PLAN: Agents Lifecycle (D) — Review`, cinatra#3091).
   *
   * WHAT IT FIXES, IN THE PLAN'S OWN WORDS: "Inside a third-party application
   * every media display paints nothing until wave 3 retrofits it." `urls` above
   * are the SESSION byte routes, and a subresource load from inside somebody
   * else's website carries no cookie — so a media display painting from them
   * draws a blank plate. This field carries the address the reader may actually
   * fetch on the surface they are on.
   *
   * `road` NAMES WHICH ONE IT IS, because the two are not interchangeable: an
   * `island` address is a sealed, five-minute, single-(artifact, revision)
   * capability, and a `session` address is the cookie-gated route. A display
   * that must know whether it may offer a copyable link can read it; a display
   * that only paints does not have to care.
   *
   * IT IS AN ADDRESS AND NEVER A PAYLOAD. `assertNoInlineBytesInRendererProps`
   * below is the machine-checked form of that: no field of this snapshot may
   * carry the work's bytes, in any encoding, on any road.
   *
   * ABSENT AT v1, deliberately: a display that declared v1 agreed to a snapshot
   * without this field, and handing it one anyway would be the flag day the
   * version window exists to prevent.
   */
  bytes?: {
    road: "session" | "island";
    preview: string | null;
    download: string | null;
  };
}

function identityExtension(identity: EffectiveIdentity): string | null {
  return identity.kind === "extension" ? identity.extension : null;
}

/**
 * Build the normalized renderer props from the authorized row + resolved
 * representation + host-authorized hrefs. Pure data assembly — imports nothing
 * server-only, closes over nothing.
 */
export function buildArtifactRendererProps(input: {
  artifact: ArtifactSummary;
  representation: { revisionId: string; mime: string } | null;
  previewHref: string | null;
  downloadHref: string | null;
  propsApiVersion?: number;
  /**
   * The content projection (enabler 0.3), built ASYNCHRONOUSLY by
   * `buildArtifactContentProjection` — it reads the pinned revision on the
   * server, and this builder is a pure, synchronous data assembly.
   *
   * REQUIRED, and deliberately not defaulted. A caller that has not wired the
   * channel passes `absentArtifactContent(...)` and is therefore VISIBLY
   * unwired ("each a contract defined here and wired for its consumers in the
   * sibling plan"); a default here would let an unwired consumer read as a
   * wired one that found nothing.
   */
  content: ArtifactContentProjection;
  /**
   * The BYTE REFERENCE for this pinned revision, from the surface's own road
   * (wave 3). Absent ⇒ the cookie surfaces' default: the session hrefs above,
   * named as the `session` road so the snapshot always says which one it is on.
   */
  bytes?: { road: "session" | "island"; preview: string | null; download: string | null };
}): ArtifactRendererProps {
  const { artifact } = input;
  const propsApiVersion = input.propsApiVersion ?? ARTIFACT_RENDERER_PROPS_API_VERSION;
  // THE BYTE REFERENCE, AT THE VERSION THAT ASKED FOR IT. A display negotiated
  // down to v1 gets a snapshot with no `bytes` key AT ALL — not a null one —
  // because "the field is absent" and "the field is empty" are different facts
  // about the contract and only the first is true of a v1 snapshot.
  // THE COOKIE SURFACES' DEFAULT — and it is a default only where there is an
  // address to default TO. A NON-FILE revision has neither href (enabler 0.10:
  // "non-file props carry no preview or download address"), so defaulting it
  // would put `bytes: { road: "session", preview: null, download: null }` on a
  // dashboard's snapshot: a road named over nothing, which reads to a display
  // as "there is a session road here and it is empty" rather than the truth,
  // "this revision has no bytes". Absent and empty are different facts, and the
  // rule that governs `urls` governs this field identically.
  const sessionBytes =
    input.previewHref === null && input.downloadHref === null
      ? null
      : {
          road: "session" as const,
          preview: input.previewHref,
          download: input.downloadHref,
        };
  const bytes =
    propsApiVersion >= ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION
      ? (input.bytes ?? sessionBytes)
      : null;
  const props: ArtifactRendererProps = {
    propsApiVersion,
    artifact: {
      id: artifact.artifactId,
      title: artifact.title,
      objectType: artifact.objectType,
      mime: artifact.mime,
      size: artifact.size,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      ownerLevel: artifact.ownerLevel,
      visibility: artifact.visibility,
      sourceUrl: artifact.sourceUrl,
    },
    representation: input.representation,
    urls: {
      preview: input.previewHref,
      download: input.downloadHref,
    },
    identity: {
      kind: artifact.effectiveIdentity.kind,
      extension: identityExtension(artifact.effectiveIdentity),
    },
    actions: {
      download: input.downloadHref,
      openInSource: artifact.sourceUrl,
    },
    content: input.content,
    ...(bytes ? { bytes } : {}),
  };
  // THE RULE IS CHECKED WHERE THE SNAPSHOT IS MADE, not only where one is
  // serialized. `assertSerializableRendererProps` is a test-time pin with no
  // production caller, so hanging the byte rule off it alone would have left it
  // running on no snapshot at all. Every host-built snapshot goes through here.
  assertNoInlineBytesInRendererProps(props);
  return props;
}

/**
 * The SAME snapshot, rebuilt at an OLDER contract version (enabler 0.4).
 *
 * THE SECOND HALF OF THE ENABLER'S SENTENCE: "resolve the display, read its
 * declared props version, then build the snapshot at that version." A seam that
 * receives an already-built snapshot cannot re-run the builder, but it can drop
 * the fields the older version has no place for — which is the whole of what a
 * version step adds today — and hand the display the shape it agreed to.
 *
 * PURE and NARROWING ONLY. It never invents a field and never raises a version:
 * a request for a version at or above the snapshot's own returns the snapshot
 * unchanged, because widening a snapshot to a version it was not built at would
 * be a guess.
 */
export function artifactRendererPropsAtVersion(
  props: ArtifactRendererProps,
  version: number,
): ArtifactRendererProps {
  if (version >= props.propsApiVersion) return props;
  const next: ArtifactRendererProps = { ...props, propsApiVersion: version };
  // The byte reference is the one field the v1 shape has no place for.
  if (version < ARTIFACT_RENDERER_PROPS_BYTE_REFERENCE_VERSION) delete next.bytes;
  return next;
}

/**
 * Assert the props are JSON-serializable (no functions, symbols, undefined-only
 * shapes, circular refs). Used by the loader before crossing into a client
 * renderer and pinned by a unit test — a non-serializable field is a contract
 * violation, not a render-time surprise.
 */
/**
 * ASSERT THAT NO BYTE OF THE WORK IS IN THE SNAPSHOT (wave 3 of
 * `PLAN: Agents Lifecycle (D) — Review`, cinatra#3091).
 *
 * The whole shape of the byte road is that a display is handed a REFERENCE and
 * fetches under it — "displays never fetch host routes on their own after wave
 * 3", and the host never hands the bytes over either. The two failure modes
 * that would quietly undo it are the two this checks:
 *
 *   · A BINARY VALUE on any field — a `Buffer`, a typed array, an
 *     `ArrayBuffer`, a `Blob`. It would cross the RSC→client boundary as the
 *     work itself, and every consumer assembled from the snapshot would carry
 *     it: a card, a transcript payload, anything a prompt is later built from.
 *   · A NON-TEXT `data:` URI in place of an address. It is a string, so the
 *     serializability walk is happy with it, and it is the bytes inline.
 *
 * A `data:` URI whose media type is textual is NOT refused: the content channel
 * legitimately projects capped text, and a display may compose a text document
 * URL from it. The rule is about the WORK'S BYTES, not about the scheme.
 *
 * WHAT IT DOES NOT CLAIM, stated so no reader mistakes its reach: it is a check
 * on the SHAPES a host builder can produce, not a decoder. A base64 string with
 * no `data:` prefix, or bytes hidden behind a getter or on a prototype, are not
 * detected — detecting them would mean guessing at every string the reviewed
 * work contains, and the guess would refuse legitimate documents. The narrow
 * rule is the enforceable one; the broad claim would be a false comfort.
 *
 * THROWS, never degrades. A snapshot carrying bytes is a host bug the builders
 * above cannot produce, and shipping it would put the payload on every surface
 * that mentions the artifact.
 */
export function assertNoInlineBytesInRendererProps(props: ArtifactRendererProps): void {
  // WHERE AN ADDRESS BELONGS — and nowhere else. Every field a display may
  // fetch or link from is here; the content projection deliberately is NOT,
  // because a text artifact whose first characters happen to be
  // `data:application/pdf;base64,` is a document the reviewer must be able to
  // read, not bytes the host smuggled. Scoping the string rule to the address
  // fields is what keeps the assertion from throwing an entire review surface
  // over the reviewed work's own first line.
  const isAddress = (path: string): boolean =>
    path.startsWith("props.urls.") ||
    path.startsWith("props.actions.") ||
    path.startsWith("props.bytes.") ||
    path === "props.artifact.sourceUrl";
  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (isAddress(path) && /^\s*data:/i.test(value)) {
        const media = value.slice(value.indexOf(":") + 1).split(/[;,]/, 1)[0].toLowerCase();
        // An empty media type defaults to `text/plain` per the data URL grammar.
        if (media !== "" && !media.startsWith("text/")) {
          throw new Error(
            `renderer props: inline bytes at ${path} (a "${media}" data: URI where an address belongs)`,
          );
        }
      }
      return;
    }
    if (typeof value !== "object") return;
    if (
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      (typeof Blob !== "undefined" && value instanceof Blob)
    ) {
      throw new Error(`renderer props: inline bytes at ${path} (a binary value)`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, `${path}.${k}`);
    }
  };
  walk(props, "props");
}

export function assertSerializableRendererProps(props: ArtifactRendererProps): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (value === null) return;
    const t = typeof value;
    if (t === "function" || t === "symbol" || t === "bigint") {
      throw new Error(`renderer props: non-serializable ${t} at ${path}`);
    }
    if (t !== "object") return;
    if (seen.has(value as object)) {
      throw new Error(`renderer props: circular reference at ${path}`);
    }
    seen.add(value as object);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, `${path}.${k}`);
    }
  };
  walk(props, "props");
  // THE SIZE ASSERTION AT THE SERIALIZATION BOUNDARY (enabler 0.3). It runs
  // AFTER the serializability walk on purpose: a snapshot carrying host context
  // is the older and blunter contract violation, and it must keep reporting
  // itself as one. A projection over the cap it was built under is a host bug
  // the channel's builder cannot produce, so this throws rather than degrading —
  // shipping it would put the payload the channel exists to bound onto every
  // card that mentions the artifact.
  //
  // PURE ARITHMETIC, ON PURPOSE. The projection carries the cap it was stamped
  // with, so this module measures what it is holding and imports nothing to do
  // it. That keeps the props contract a leaf of the locked route graphs that
  // reach it (the route-graph ratchet is the gate that says so) — the canonical
  // caps stay in the SDK leaf, where the builder reads them.
  const content = props.content as ArtifactContentProjection | undefined;
  if (content && content.kind !== "none") {
    // BOTH CAPS, never only the stamped one: a projection that stamps a larger
    // cap on itself must not buy room at the boundary. This is the same rule the
    // SDK leaf's `isArtifactContentWithinCap` applies, mirrored rather than
    // imported for the route-budget reason stated on the constants above.
    const canonical = ARTIFACT_CONTENT_CHANNEL_CAPS_MIRROR[content.kind];
    const bound =
      typeof canonical === "number" ? Math.min(content.cap, canonical) : content.cap;
    if (content.projectedByteLength > bound) {
      throw new Error(
        `renderer props: content projection "${content.kind}" carries ` +
          `${content.projectedByteLength} bytes over its ${bound}-byte cap`,
      );
    }
  }
  // AND THE BYTE ROAD'S OWN BAR (wave 3). It runs LAST because it is the
  // narrowest of the three: a snapshot that is not serializable, or whose
  // projection is over its cap, is broken for reasons that have nothing to do
  // with the road — and those two must keep reporting themselves first.
  assertNoInlineBytesInRendererProps(props);
}

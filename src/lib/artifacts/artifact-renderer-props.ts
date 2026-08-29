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
export const ARTIFACT_RENDERER_PROPS_API_VERSION = 1;

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
}): ArtifactRendererProps {
  const { artifact } = input;
  return {
    propsApiVersion: input.propsApiVersion ?? ARTIFACT_RENDERER_PROPS_API_VERSION,
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
  };
}

/**
 * Assert the props are JSON-serializable (no functions, symbols, undefined-only
 * shapes, circular refs). Used by the loader before crossing into a client
 * renderer and pinned by a unit test — a non-serializable field is a contract
 * violation, not a render-time surprise.
 */
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
}

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
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
  /** The resolved effective identity, flattened to plain data. */
  identity: {
    kind: EffectiveIdentity["kind"];
    extension: string | null;
    basis: string | null;
    selectable: boolean;
  };
  /** Sanctioned action handles — SERIALIZABLE navigational hrefs only. v1
   * renderers request no ports, so actions are host-authorized links, never
   * server-action closures. */
  actions: {
    download: string | null;
    openInSource: string | null;
  };
}

function identityExtension(identity: EffectiveIdentity): string | null {
  return identity.kind === "extension" ? identity.extension : null;
}

function identityBasis(identity: EffectiveIdentity): string | null {
  return identity.kind === "extension" ? identity.basis : null;
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
      basis: identityBasis(artifact.effectiveIdentity),
      selectable: artifact.effectiveIdentity.selectable,
    },
    actions: {
      download: input.downloadHref,
      openInSource: artifact.sourceUrl,
    },
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
}

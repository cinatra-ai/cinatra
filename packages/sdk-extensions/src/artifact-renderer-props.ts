// The AUTHOR-FACING artifact-renderer props contract (cinatra#1629, epic #1620
// S2/M1 — "artifact extensions own their UI").
//
// WHY THIS LIVES IN THE SDK LEAF: an extension that ships a `cinatra.artifact.ui`
// renderer (`./src/renderers/detail.tsx`) types its default-export component's
// single argument against THIS `ArtifactRendererProps` — so it depends ONLY on
// `@cinatra-ai/sdk-extensions` and never reaches into the host. The scaffolder's
// opt-in `--with-ui` renderer stub imports the type from this exact subpath
// (`@cinatra-ai/sdk-extensions/artifact-renderer-props`); before this leaf
// existed the type was host-internal only, which is why the opt-in ui template
// (cinatra#1627 AC3) was blocked until the first renderer wave.
//
// SCHEMA-ONLY / HOST-NEUTRAL: this module is a pure type + one integer constant.
// It imports nothing (not even zod) so it can be pulled into a browser/RSC
// renderer bundle with zero runtime weight, and it inlines the concrete string
// unions (ownerLevel / visibility / identity kind) rather than referencing any
// host type — a leaf package has no host dependency to reference.
//
// STRUCTURALLY IDENTICAL to the HOST source of truth
// (`src/lib/artifacts/artifact-renderer-props.ts`, which additionally owns the
// server-side `buildArtifactRendererProps` builder + `assertSerializableRendererProps`
// pin). The host keeps its own copy for the runtime the same way
// `./artifact-contract` mirrors `@cinatra-ai/objects`; a host-side
// mutual-assignability test keeps the two in lockstep, so a field added on
// either side that is not mirrored fails the host typecheck.

/**
 * The props-contract ABI version this leaf describes. A renderer declares the
 * `propsApiVersion` it expects in its `cinatra.artifact.ui` manifest entry; the
 * host refuses to mount a renderer whose expected version the supplied snapshot
 * does not satisfy. This is a SEPARATE version axis from `SDK_EXTENSIONS_ABI_VERSION`
 * (the host-port ABI) — the props snapshot has its own contract version.
 */
export const ARTIFACT_RENDERER_PROPS_API_VERSION = 1;

/**
 * The versioned, normalized, SERIALIZABLE props snapshot an extension-shipped
 * artifact renderer receives.
 *
 * A v1 renderer requests NO host ports (the S1 manifest contract) — it renders
 * ONLY from this host-supplied, already-access-checked snapshot. Every field is
 * plain JSON data: row metadata, the resolved representation/content ref,
 * host-authorized URLs, and sanctioned action handles as navigational HREFS
 * (never closures / host context). Non-serializable host context (DB handles,
 * the request, server-action closures over `ctx`) NEVER crosses this boundary —
 * the renderer may run as a client component, so the RSC→client serialization
 * boundary must hold (the host pins this).
 */
export interface ArtifactRendererProps {
  /** The props-contract version this snapshot conforms to. A renderer declares
   * the `propsApiVersion` it expects; the host refuses to mount a renderer whose
   * expected version this snapshot does not satisfy (loader compat check). */
  propsApiVersion: number;
  /** Row metadata (a projection of the host-authorized artifact summary). */
  artifact: {
    id: string;
    title: string | null;
    objectType: string;
    mime: string;
    size: number;
    createdAt: string;
    updatedAt: string;
    /** Canonical ownership level projection (read-only). */
    ownerLevel: "user" | "team" | "organization" | "workspace";
    /** Canonical visibility projection (read-only). */
    visibility: "private" | "team" | "organization" | "public";
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
    kind: "extension" | "default-artifact" | "plain-object";
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

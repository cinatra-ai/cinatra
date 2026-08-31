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

import type { ArtifactContentProjection } from "./artifact-content-channel";

/**
 * The props-contract ABI version this leaf describes. A renderer declares the
 * `propsApiVersion` it expects in its `cinatra.artifact.ui` manifest entry; the
 * host refuses to mount a renderer whose expected version the supplied snapshot
 * does not satisfy. This is a SEPARATE version axis from `SDK_EXTENSIONS_ABI_VERSION`
 * (the host-port ABI) — the props snapshot has its own contract version.
 *
 * IT IS 2 SINCE WAVE 3 of `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091):
 * the snapshot gained the island-scoped byte reference below, which is what lets
 * a media display paint inside a third-party application at all. A display still
 * declaring 1 is admitted at 1 and handed a v1 snapshot — the host's version
 * window, not a flag day — it simply is not handed the island road.
 */
export const ARTIFACT_RENDERER_PROPS_API_VERSION = 2;

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
  /** The resolved effective identity, flattened to plain data (epic #1785):
   * the type's defining `extension`, or `no-primary` with a null extension. The
   * retired binding/classic `basis` + the `selectable` activation barrier are
   * gone — a type-driven identity is either an installed extension or not. */
  identity: {
    kind: "extension" | "no-primary";
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
   * `PLAN: Agents Lifecycle (C)`).
   *
   * The discriminated content projection, read from the PINNED revision on the
   * server. A display switches on `content.kind` and never fetches; `none` is a
   * first-class answer with a named reason. Capped per content class by the
   * host, which asserts the cap before this snapshot crosses to a renderer.
   */
  content: ArtifactContentProjection;
  /**
   * THE ISLAND-SCOPED BYTE REFERENCE (props v2, wave 3 of
   * `PLAN: Agents Lifecycle (D) — Review`).
   *
   * `urls` above are the host's SESSION byte routes, and a subresource load
   * from inside a third-party application carries no cookie — which is why a
   * media display painting from them draws a blank plate there. This is the
   * address the reader may actually fetch on the surface they are on: on the
   * island it is a sealed, short-lived capability bound to exactly this
   * artifact and this revision, and on a first-party surface it is the session
   * route named as such.
   *
   * A DISPLAY PAINTS FROM `bytes` WHERE IT IS PRESENT and falls back to `urls`
   * where it is not, and it never fetches a host route on its own.
   *
   * ABSENT AT v1: a display that declared v1 agreed to a snapshot without it.
   */
  bytes?: {
    road: "session" | "island";
    preview: string | null;
    download: string | null;
  };
}

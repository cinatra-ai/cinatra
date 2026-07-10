// ---------------------------------------------------------------------------
// Renderable-view SCHEMA registry (cinatra#1220, S4).
//
// The S1 seam (`../renderable-views.ts`) defines the OPEN type registry and the
// pure discriminator guards. This module is the S4 fill: it registers each
// assistant-specific view's VERSIONED zod schema and exposes a single safe
// validator, `parseRenderableView`, that turns an untrusted `DATA_PART` payload
// off the wire into a typed, bounded, sanitized view — or `null` when the
// payload is not a known, valid view (unknown `viewType`, wrong `schemaVersion`,
// missing/oversized fields, hostile URL scheme, …). The renderer (S3/S4) shows
// its safe fallback for a `null`.
//
// Each concrete view module declaration-merges its type into
// `RenderableViewRegistry` (see the per-view files); importing this index pulls
// those augmentations in, so `isRenderableViewOfType(data, "content_change_proposal")`
// narrows correctly at every call site that also imports the package.
// ---------------------------------------------------------------------------

import type { z } from "zod";

import { renderableViewType } from "../renderable-views";
import {
  contentChangeProposalViewSchema,
  CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION,
} from "./content-change-proposal";
import {
  artifactPreviewViewSchema,
  ARTIFACT_PREVIEW_SCHEMA_VERSION,
} from "./artifact-preview";
import {
  citationGroupViewSchema,
  CITATION_GROUP_SCHEMA_VERSION,
} from "./citation-group";
import {
  changeHistoryViewSchema,
  CHANGE_HISTORY_SCHEMA_VERSION,
} from "./change-history";

// Re-export the S1 seam (types + pure guards) so the `/renderable-views`
// subpath is the single self-contained entry S4 consumers import — WITHOUT
// pulling the zod schema graph into the package's MAIN index (which the locked
// dev-perf route-graph budgets reach; see scripts/audit/route-graph-ratchet).
export * from "../renderable-views";
export * from "./safe-url";
export * from "./content-change-proposal";
export * from "./artifact-preview";
export * from "./citation-group";
export * from "./change-history";

/**
 * The registered renderable-view schemas keyed by `viewType`. The key MUST
 * equal the schema's `viewType` literal (checked by the round-trip test). Each
 * entry pairs the zod schema with its current schema version for negotiation.
 */
export const RENDERABLE_VIEW_SCHEMAS = {
  content_change_proposal: {
    schema: contentChangeProposalViewSchema,
    version: CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION,
  },
  artifact_preview: {
    schema: artifactPreviewViewSchema,
    version: ARTIFACT_PREVIEW_SCHEMA_VERSION,
  },
  citation_group: {
    schema: citationGroupViewSchema,
    version: CITATION_GROUP_SCHEMA_VERSION,
  },
  change_history: {
    schema: changeHistoryViewSchema,
    version: CHANGE_HISTORY_SCHEMA_VERSION,
  },
} as const satisfies Record<
  string,
  { schema: z.ZodType<{ viewType: string }>; version: number }
>;

/** A registered `viewType` discriminator. */
export type KnownRenderableViewType = keyof typeof RENDERABLE_VIEW_SCHEMAS;

/** The parsed (validated + sanitized) output of a registered view schema. */
export type ParsedRenderableView = {
  [K in KnownRenderableViewType]: z.output<
    (typeof RENDERABLE_VIEW_SCHEMAS)[K]["schema"]
  >;
}[KnownRenderableViewType];

/** The set of registered view discriminators (runtime list). */
export const KNOWN_RENDERABLE_VIEW_TYPES = Object.keys(
  RENDERABLE_VIEW_SCHEMAS,
) as KnownRenderableViewType[];

export function isKnownRenderableViewType(
  viewType: string | undefined,
): viewType is KnownRenderableViewType {
  return (
    viewType !== undefined &&
    Object.prototype.hasOwnProperty.call(RENDERABLE_VIEW_SCHEMAS, viewType)
  );
}

/**
 * Safely validate an untrusted `DATA_PART` payload against the registered view
 * schemas. Returns the typed, bounded, sanitized view on success, or `null`
 * when the payload is not a known valid view. NEVER throws — a hostile or
 * forward-incompatible payload yields `null` and the caller renders a fallback.
 */
export function parseRenderableView(
  data: unknown,
): ParsedRenderableView | null {
  // Wrapped so the "NEVER throws" contract holds even against an adversarial
  // payload — a throwing getter or a `Proxy` `get` trap on `viewType`, or a
  // hostile property access inside `safeParse`, degrades to the fallback.
  try {
    const viewType = renderableViewType(data);
    if (!isKnownRenderableViewType(viewType)) return null;
    const result = RENDERABLE_VIEW_SCHEMAS[viewType].schema.safeParse(data);
    return result.success ? (result.data as ParsedRenderableView) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// content_change_proposal — the change-diff renderable (cinatra#1220, S4).
//
// The PRIMARY porting target of S4: the CMS widgets' frozen top-level `changes`
// frame (`{ fields: [{field, before, after}], postId | nodeId }`, rendered by
// the vanilla `renderDiffCard`) becomes a typed `DATA_PART` renderable-view
// payload on THE one wire, so `/chat`, the generic embedded view and every CMS
// iframe draw it through the S3 shared renderer identically.
//
// SCOPE (this slice): the schema + typed DATA_PART + a display renderer. The
// no-reload APPLY half — a surface-registered apply capability that writes the
// change through the CMS MCP integration under OBO — is OUT of this slice
// (gated on #1214 + #1037 P4.1 + the per-surface capability/token/OBO model).
// This view is therefore DISPLAY-ONLY here; it carries no apply-intent wiring.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { RenderableViewBase } from "../renderable-views";

/** Current schema version. Bump on a breaking payload change; older renderers
 * fall back to the safe unknown-view render when they see a newer version. */
export const CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION = 1 as const;

/** A single proposed field change. `before`/`after` are LLM/tool-controlled
 * text and are rendered as inert text nodes by the component (never HTML). */
export const contentChangeFieldSchema = z.object({
  field: z.string().min(1).max(200),
  before: z.string().max(20_000).optional(),
  after: z.string().max(20_000).optional(),
});

export const contentChangeProposalViewSchema = z.object({
  viewType: z.literal("content_change_proposal"),
  schemaVersion: z.literal(CONTENT_CHANGE_PROPOSAL_SCHEMA_VERSION),
  /** Originating CMS surface, when known — informational only. */
  surface: z.enum(["wordpress", "drupal", "generic"]).optional(),
  /** WordPress post id (the widget's `postId`). */
  postId: z.string().max(200).optional(),
  /** Drupal node id (the widget's `nodeId`). */
  nodeId: z.string().max(200).optional(),
  /** True when the edit is rich content with no field-level diff available
   * (the widget's `fields.length === 0` branch). */
  rich: z.boolean(),
  /** Optional heading override (defaults chosen by the renderer). */
  title: z.string().max(300).optional(),
  fields: z.array(contentChangeFieldSchema).max(200),
});

export type ContentChangeProposalView = z.infer<
  typeof contentChangeProposalViewSchema
>;

// Compile-time proof the schema output satisfies the S1 base seam.
type _AssertBase = ContentChangeProposalView extends RenderableViewBase
  ? true
  : never;
const _assertBase: _AssertBase = true;
void _assertBase;

declare module "../renderable-views" {
  interface RenderableViewRegistry {
    content_change_proposal: ContentChangeProposalView;
  }
}

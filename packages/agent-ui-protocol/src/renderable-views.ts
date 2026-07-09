// ---------------------------------------------------------------------------
// Renderable-view extension points (cinatra#1217, epic #1216 S1).
//
// Assistant-specific views (the CMS change-diff, artifact previews, …) are
// carried as typed `DATA_PART` payloads on the one wire, discriminated by a
// namespaced `viewType`. This module is the SEAM S4 fills: a later stage
// registers a concrete view payload type by DECLARATION-MERGING into
// `RenderableViewRegistry` — WITHOUT forking the contract or adding a new
// top-level event. Registration is a type-map augmentation plus (in the
// renderer, S3/S4) a component keyed by the same `viewType`; neither touches
// this contract module.
//
// Example — how S4 registers the change-diff (the frozen `changes` frame's
// successor) without a contract fork:
//
//   // (in S4, e.g. packages/chat/src/renderable-views/content-change-proposal.ts)
//   import type { RenderableViewBase } from "@cinatra-ai/agent-ui-protocol";
//   export type ContentChangeProposalView = RenderableViewBase & {
//     viewType: "content_change_proposal";
//     fields: Array<{ field: string; before: string; after: string }>;
//     nodeId?: string;
//     postId?: string;
//     rich: boolean;
//   };
//   declare module "@cinatra-ai/agent-ui-protocol" {
//     interface RenderableViewRegistry {
//       content_change_proposal: ContentChangeProposalView;
//     }
//   }
//
// After that augmentation `isRenderableViewOfType(data, "content_change_proposal")`
// narrows `data` to `ContentChangeProposalView` at every call site.
//
// Tier-neutral: types + pure guards only. No server-only constraint.
// ---------------------------------------------------------------------------

import type { DataPartEvent } from "./events";

/**
 * The common shape of every renderable-view payload: a namespaced string
 * discriminator. Concrete views extend this and are registered in
 * `RenderableViewRegistry`.
 */
export type RenderableViewBase = {
  /**
   * Namespaced view discriminator, e.g. `"content_change_proposal"`. The key of
   * the corresponding `RenderableViewRegistry` entry MUST equal this literal.
   */
  viewType: string;
};

/**
 * The open registry of renderable-view payload types, keyed by `viewType`.
 *
 * Empty in S1 BY DESIGN — this is the extension point. A later stage registers
 * a view by declaration-merging a keyed entry (see the module header example);
 * nothing in this contract changes when a view is added, so surfaces never fork.
 *
 * Each merged entry's value MUST extend `RenderableViewBase` with its `viewType`
 * fixed to the entry's key.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merge seam: entries are added by later stages via `declare module`, so this interface is intentionally empty here.
export interface RenderableViewRegistry {}

/** The union of every registered renderable-view payload type. */
export type RegisteredRenderableView =
  RenderableViewRegistry[keyof RenderableViewRegistry];

/** The set of registered `viewType` discriminators (the registry's keys). */
export type RegisteredRenderableViewType = keyof RenderableViewRegistry & string;

/**
 * Any renderable-view payload on the wire: a registered one when the `viewType`
 * is known, or an unknown-but-well-formed one (forward compatible — a surface
 * may receive a view a newer producer emits and MUST fall back gracefully
 * rather than crash).
 */
export type RenderableView =
  | RegisteredRenderableView
  | (RenderableViewBase & Record<string, unknown>);

/**
 * Read the `viewType` discriminator from an arbitrary `DATA_PART` payload.
 * Returns `undefined` when the payload is not a renderable view (no non-empty
 * string `viewType`) — i.e. it is a plain structured data part.
 */
export function renderableViewType(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const vt = (data as { viewType?: unknown }).viewType;
    if (typeof vt === "string" && vt.length > 0) return vt;
  }
  return undefined;
}

/**
 * Type guard: `event` is a `DATA_PART` whose payload is a renderable view
 * (carries a non-empty string `viewType`). A `DATA_PART` without a `viewType`
 * is a plain data part and returns `false` here.
 */
export function isRenderableViewDataPart(event: {
  type?: unknown;
  data?: unknown;
}): event is DataPartEvent & {
  data: RenderableViewBase & Record<string, unknown>;
} {
  return (
    event.type === "DATA_PART" && renderableViewType(event.data) !== undefined
  );
}

/**
 * Type guard narrowing a renderable-view payload to a specific REGISTERED type.
 * Only compiles for a `viewType` present in `RenderableViewRegistry`, so a
 * caller cannot narrow to a view the contract does not (yet) know — while an
 * unknown `viewType` on the wire simply fails every registered check and the
 * renderer shows its safe fallback.
 */
export function isRenderableViewOfType<K extends RegisteredRenderableViewType>(
  data: unknown,
  viewType: K,
): data is RenderableViewRegistry[K] {
  return renderableViewType(data) === viewType;
}

/**
 * Build a `DATA_PART` event carrying a renderable view. Producer-side
 * convenience so a surface-specific view is emitted on the one wire with the
 * correct shape (`type: "DATA_PART"`, payload under `data`).
 */
export function renderableViewDataPart(
  view: RenderableViewBase & Record<string, unknown>,
  partIndex?: number,
): DataPartEvent {
  return {
    type: "DATA_PART",
    data: view,
    ...(partIndex !== undefined ? { partIndex } : {}),
  };
}

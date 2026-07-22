// ---------------------------------------------------------------------------
// Renderable-view component registry + dispatcher (cinatra#1220, S4).
//
// The single seam that turns a `DATA_PART` renderable-view payload off the one
// wire into a rendered card, keyed by `viewType`. `RenderableViewCard`:
//   1. safely validates+sanitizes the raw payload via the S1/S4 schema registry
//      (`parseRenderableView` — never throws),
//   2. dispatches to the registered component for the (now typed) view, or
//   3. renders `RenderableViewFallback` for an unknown / invalid / forward-
//      incompatible payload — so a newer producer's view never crashes an older
//      surface (the epic's forward-compat requirement).
//
// This is the S3-side counterpart to the S1 schema seam: adding a view is a
// registry entry here + a schema entry in the protocol package; no surface
// forks. Every registered component renders LLM/tool text as React text nodes,
// so the union is XSS-safe by construction.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import {
  parseRenderableView,
  renderableViewType,
  type KnownRenderableViewType,
  type ParsedRenderableView,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { ContentChangeProposalCard, type ApplyIntentRef } from "./content-change-proposal-card";
import { ArtifactPreviewCard } from "./artifact-preview-card";
import { CitationGroupCard } from "./citation-group-card";
import { ChangeHistoryCard } from "./change-history-card";

type ComponentFor<K extends KnownRenderableViewType> = (props: {
  view: Extract<ParsedRenderableView, { viewType: K }>;
  // §6e (cinatra#1221 S5 Lane B): the apply-intent gesture seam, passed OPAQUELY
  // to every dispatched card (dispatch stays identity-agnostic — core never
  // branches on a view-type identity). Only the apply-eligible card reads it; the
  // display-only cards accept-and-ignore it (structurally assignable). This keeps
  // the artifact-ui presentation-identity-keying boundary intact.
  onApplyIntent?: (ref: ApplyIntentRef) => void;
}) => ReactElement;

/** Component per registered `viewType`. Keys MUST match the schema registry. */
const RENDERABLE_VIEW_COMPONENTS: {
  [K in KnownRenderableViewType]: ComponentFor<K>;
} = {
  content_change_proposal: ContentChangeProposalCard,
  artifact_preview: ArtifactPreviewCard,
  citation_group: CitationGroupCard,
  change_history: ChangeHistoryCard,
};

/**
 * Safe fallback for a payload that is a renderable view but not a known/valid
 * one — an unknown `viewType`, a wrong `schemaVersion`, or a payload that fails
 * validation. Shows a neutral note (naming the raw viewType when present) rather
 * than crashing. Any raw viewType string is rendered as a text node.
 */
export function RenderableViewFallback({
  rawViewType,
}: {
  rawViewType?: string;
}) {
  return (
    <div
      className="my-3 rounded-lg border border-line bg-surface-muted p-3 text-xs text-muted-foreground"
      data-view-type="__fallback__"
    >
      This assistant view{rawViewType ? ` (${rawViewType})` : ""} can’t be
      displayed on this surface.
    </div>
  );
}

/**
 * Render a renderable-view `DATA_PART` payload. Pass the raw `data` off the
 * wire; validation + sanitization + dispatch happen here.
 */
export function RenderableViewCard({
  data,
  onApplyIntent,
}: {
  data: unknown;
  /** §6e (cinatra#1221 S5 Lane B): injected ONLY by a surface that owns an apply
   *  flow (the embed). Wired to the `content_change_proposal` card — the ONLY
   *  apply-eligible view — so its explicit apply gesture emits the intent. Card
   *  DISPATCH stays definitional (unchanged) — this is an orthogonal gesture
   *  seam, not a host-injected renderer. Absent → every card is DISPLAY-ONLY. */
  onApplyIntent?: (ref: ApplyIntentRef) => void;
}): ReactElement {
  const parsed = parseRenderableView(data);
  if (parsed === null) {
    let rawViewType: string | undefined;
    try {
      rawViewType = renderableViewType(data);
    } catch {
      rawViewType = undefined;
    }
    return <RenderableViewFallback rawViewType={rawViewType} />;
  }
  // `parsed.viewType` is a KnownRenderableViewType; index the component map.
  const key = parsed.viewType as KnownRenderableViewType;
  // §6e: pass the apply-intent seam OPAQUELY through the SAME dispatch — no
  // identity branch. Only the apply-eligible card acts on it; the others ignore
  // it (accept-and-ignore, structurally assignable).
  const Component = RENDERABLE_VIEW_COMPONENTS[key] as ComponentFor<typeof key>;
  return <Component view={parsed as never} onApplyIntent={onApplyIntent} />;
}

export { RENDERABLE_VIEW_COMPONENTS };

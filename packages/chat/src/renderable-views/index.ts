// ---------------------------------------------------------------------------
// Renderable-view components — public barrel (cinatra#1220, S4).
//
// The S3 renderer-side registration of the S4 first-class renderable views.
// `RenderableViewCard` is the single entry a surface calls with a raw
// `DATA_PART` payload; it validates + dispatches + falls back. Individual cards
// and the component map are exported for direct/fixture use.
// ---------------------------------------------------------------------------

export {
  RenderableViewCard,
  RenderableViewFallback,
  RENDERABLE_VIEW_COMPONENTS,
} from "./registry";

export { ContentChangeProposalCard } from "./content-change-proposal-card";
export { ArtifactPreviewCard } from "./artifact-preview-card";
export { CitationGroupCard } from "./citation-group-card";
export { ChangeHistoryCard } from "./change-history-card";

export {
  validRenderableViewFixtures,
  hostileRenderableViewFixtures,
} from "./fixtures";

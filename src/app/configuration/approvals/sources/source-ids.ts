// ---------------------------------------------------------------------------
// Stable approval-source ids — the data-layer constants shared by the surviving
// source adapters and the unified /notifications feed view-model.
//
// Relocated here from the retired `resolve-active-view.ts` in the E8 cutover
// (cinatra#1558): the `/configuration/approvals` page + its `?direction`/`?tab`
// machinery were deleted, but these ids are consumed independently of that page
// — by `sources/agent-creation-requests(.contract).ts` (the agent-creation
// source) and by `src/app/notifications/feed-view-model.ts` (the E7 feed). This
// module is import-light (pure string constants, no server graph) so it can be
// pulled into any of those consumers without dragging in the decide/render
// surface.
// ---------------------------------------------------------------------------

/** The agent-creation-requests source id (the local agent approval source). */
export const AGENT_SOURCE_ID = "agent-creation-requests";

/**
 * The legacy workflow source id. The workflow approval source itself was
 * deleted whole by #1035; the id survives only as the constant the feed
 * view-model uses to recognise (and gate) any residual workflow-legacy row.
 */
export const WORKFLOW_SOURCE_ID = "workflow-legacy";

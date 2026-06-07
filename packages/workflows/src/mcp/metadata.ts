// Read vs proposal-write classification for the release-workflow primitives.
// Proposal-only: NONE of these can start/approve/reject a workflow (those tools
// are not registered at all). The mutating tools only create/edit DRAFTS.
export const WORKFLOW_PRIMITIVE_METADATA = [
  { name: "workflow_template_list", mutatesState: false },
  { name: "workflow_template_instantiate", mutatesState: true },
  { name: "workflow_draft_create", mutatesState: true },
  { name: "workflow_draft_update", mutatesState: true },
  { name: "workflow_draft_get", mutatesState: false },
  { name: "workflow_draft_list", mutatesState: false },
  { name: "workflow_validate", mutatesState: false },
  { name: "workflow_preview", mutatesState: false },
  { name: "workflow_status_get", mutatesState: false },
  { name: "workflow_status_list", mutatesState: false },
  { name: "workflow_artifacts_list", mutatesState: false },
  { name: "workflow_cascade_preview", mutatesState: false },
  { name: "workflow_copy", mutatesState: true },
  { name: "workflow_save_as_template", mutatesState: true },
] as const;

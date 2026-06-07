// Public surface of @cinatra-ai/workflows. Explicit named re-exports
// (no `export *`, per repo convention). Add new public symbols here explicitly.

export {
  workflowTemplate,
  workflow,
  workflowTask,
  workflowDependency,
  workflowGate,
  workflowEvent,
  workflowTaskAttempt,
  workflowArtifact,
  workflowApproval,
  releaseWorkflowsSchemaTables,
} from "./schema";
export { db, releaseWorkflowsPool } from "./db";

export {
  lintWorkflowSpecForTriggerBundling,
  lintManifestForTriggerBundling,
} from "./lint/trigger-bundling";
export type { TriggerLintFinding } from "./lint/trigger-bundling";

export { computeCriticalPath } from "./schedule/critical-path";
export type { CpmTaskRow, CpmEdge, CriticalPathResult } from "./schedule/critical-path";

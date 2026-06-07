// @cinatra-ai/workflows/scope — ownership/read-visibility + the
// delegated execution actor.

export {
  buildWorkflowResourceRef,
  isReadable,
  filterReadable,
  canManage,
  assertWorkflowProjectWritable,
} from "./resource-ref";
export type {
  WorkflowResourceRef,
  ScopedRow,
  WorkflowActor,
  AssertProjectWritable,
} from "./resource-ref";

export {
  WORKFLOW_EXECUTION_SOURCE,
  buildExecutionActor,
  buildChildRunProvenance,
} from "./execution-actor";
export type {
  WorkflowExecutionActor,
  WorkflowProvenanceRow,
  ChildRunProvenance,
} from "./execution-actor";

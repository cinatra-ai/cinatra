// Delegated workflow execution actor. The reconciler runs as a
// delegated, auth-derived identity; child agent runs carry this provenance and
// are NEVER machine-anonymous. The tenant key (orgId) is auth-derived from the
// owning workflow, never a body identifier.

export const WORKFLOW_EXECUTION_SOURCE = "workflow-reconciler" as const;

export type WorkflowExecutionActor = {
  orgId: string;
  projectId: string | null;
  /** The principal the workflow runs on behalf of (the workflow's created_by / owner). */
  runBy: string | null;
  source: typeof WORKFLOW_EXECUTION_SOURCE;
  workflowId: string;
};

export type WorkflowProvenanceRow = {
  id: string;
  orgId: string;
  projectId?: string | null;
  createdBy?: string | null;
  ownerId?: string | null;
};

/**
 * Build the delegated execution actor from the owning workflow row. `runBy`
 * prefers created_by, falling back to owner_id; both are stamped on child runs
 * for cost attribution + audit downstream.
 */
export function buildExecutionActor(workflow: WorkflowProvenanceRow): WorkflowExecutionActor {
  return {
    orgId: workflow.orgId,
    projectId: workflow.projectId ?? null,
    runBy: workflow.createdBy ?? workflow.ownerId ?? null,
    source: WORKFLOW_EXECUTION_SOURCE,
    workflowId: workflow.id,
  };
}

/** The provenance fields stamped on a child agent_run. */
export type ChildRunProvenance = {
  orgId: string;
  projectId: string | null;
  runBy: string | null;
  source: typeof WORKFLOW_EXECUTION_SOURCE;
  workflowId: string;
  workflowTaskId: string;
};

export function buildChildRunProvenance(
  actor: WorkflowExecutionActor,
  workflowTaskId: string,
): ChildRunProvenance {
  return {
    orgId: actor.orgId,
    projectId: actor.projectId,
    runBy: actor.runBy,
    source: actor.source,
    workflowId: actor.workflowId,
    workflowTaskId,
  };
}

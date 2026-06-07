"use server";
// Thin server-action bridge for HITL approval callable from client components
// (e.g. AgenticRunPanel). Uses "use server" at file level so Next.js/Turbopack
// serializes these as opaque server action references rather than bundling them
// into the client chunk.
//
// The optional `values?: unknown` argument lets setup-field renderers forward
// the user's input. Mid-run HITL renderers continue to call with no value
// argument; the approve path short-circuits when values is undefined.

import { approveReviewTask as _approveReviewTask, rejectReviewTask as _rejectReviewTask } from "./actions";

/**
 * Optional 3rd arg `fieldName` is forwarded when a real UUID task needs to
 * merge user input into agent_runs.inputParams without reading
 * planned_action.provenance. Synthetic (lg-*) IDs ignore this param because
 * the checkpointer owns state for those runs.
 */
export async function approveReviewTask(
  taskId: string,
  values?: unknown,
  fieldName?: string,
  schemaSnapshot?: Record<string, unknown> | null,
): Promise<void> {
  return _approveReviewTask(taskId, values, fieldName, schemaSnapshot);
}

export async function rejectReviewTask(
  taskId: string,
  reason?: string,
): Promise<void> {
  return _rejectReviewTask(taskId, reason);
}

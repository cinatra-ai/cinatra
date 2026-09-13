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
import { classifyGateRejection, type GateSubmitOutcome } from "./hitl-gate-submit";

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
): Promise<GateSubmitOutcome> {
  // cinatra#3219 — THE STALE-GATE REFUSAL LEAVES HERE AS DATA.
  //
  // Someone presses Continue in the window where the run has already moved on,
  // and the approval is correctly refused. That is an expected race with a
  // drawn state, not a fault, and the framework's own guidance is to return an
  // expected Server Action failure as data rather than throw it: an ordinary
  // thrown error crosses this boundary in production as a generic masked error
  // carrying an opaque digest, so nothing downstream can read what it was.
  //
  // The classification happens HERE, on the server side of the boundary, where
  // the typed error is still intact. What crosses is a discriminated result the
  // caller can act on — which is why every submit path can draw the surface's
  // blocked state without pattern-matching a message.
  //
  // Every other failure still throws, so nothing real is swallowed.
  try {
    await _approveReviewTask(taskId, values, fieldName, schemaSnapshot);
    return { ok: true };
  } catch (err) {
    const blocked = classifyGateRejection(err);
    if (blocked) return { ok: false, blocked };
    throw err;
  }
}

/**
 * THE REJECT TWIN ANSWERS THE SAME WAY (cinatra#3423).
 *
 * Declining a gate is the other half of deciding it, and it loses the same race:
 * the gate was approved, rejected or overtaken somewhere else between the moment
 * this screen drew it and the moment the button was pressed. The approve half
 * above has returned that refusal as DATA since cinatra#3219; this half threw it
 * away — the underlying action swallowed the lost compare-and-swap and returned
 * `void`, so no caller could tell a landed decline from a refused one, and the
 * review surface had nothing to draw its blocked state from.
 *
 * Same classification, same discriminated result, same reason from the surface's
 * closed set. Every other failure still throws.
 */
export async function rejectReviewTask(
  taskId: string,
  reason?: string,
): Promise<GateSubmitOutcome> {
  try {
    await _rejectReviewTask(taskId, reason);
    return { ok: true };
  } catch (err) {
    const blocked = classifyGateRejection(err);
    if (blocked) return { ok: false, blocked };
    throw err;
  }
}

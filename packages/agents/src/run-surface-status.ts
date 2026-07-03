/**
 * Shared run-surface status/HITL-context resolution (cinatra#853).
 *
 * `agentic-run-panel.tsx` maintains BOTH a poll loop and (when
 * agUiEnabled) an AG-UI SSE stream, and must reconcile the two into one
 * effective status / error / HITL context; `orchestrator-stepper-panel.tsx`
 * shares the badge mapping and the interrupt-context shape. This module is
 * the single, PURE home for those reducers so they are unit-testable
 * without mounting either panel.
 *
 * PURITY CONTRACT: no React, no `"use client"`, no host `@/` imports.
 */

/**
 * SSE-first value resolution: the stream wins when it is enabled AND has
 * delivered a value; otherwise fall back to the poll-derived (or initial)
 * value. Used for both status and error.
 */
export function resolveStreamFirst<T>(
  streamEnabled: boolean,
  streamValue: T | null,
  fallback: T,
): T {
  return streamEnabled && streamValue !== null ? streamValue : fallback;
}

/**
 * Status → badge variant mapping shared by both run surfaces.
 *
 * Trigger-related run states (AgenticRunPanel surface):
 *   pending_trigger: form is open, awaiting submit (neutral / outline).
 *   armed:           trigger configured, waiting for the gate to fire
 *                    (calm accent / secondary).
 * The orchestrator stepper's statuses (queued / pending_input / running /
 * pending_approval / completed / failed / stopped) map identically to its
 * previous local copy; pending_trigger/armed do not occur on that surface
 * today (trigger runs render through AgenticRunPanel).
 */
export function statusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "pending_approval") return "outline";
  if (status === "pending_trigger") return "outline";
  if (status === "armed") return "secondary";
  return "secondary";
}

/**
 * The panel-side HITL gate context — the poll endpoint
 * (`/api/agents/runs/[runId]` → hitlContext) already returns this shape;
 * SSE INTERRUPT frames are mapped into it via `mapInterruptToHitlContext`.
 */
export type HitlGateContext = {
  xRenderer: string;
  childRunId: string | null;
  reviewTaskId: string;
  inputSchema: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  /**
   * Schema property name carried on INTERRUPT (5th arg of
   * `AgUiAdapter.onInterrupt`). Set by the setup-loop in execution.ts —
   * tells the panel which key to wrap primitive onChange values into when
   * calling `approveReviewTask({ [fieldName]: value }, fieldName)`.
   * `undefined` for non-setup-loop INTERRUPTs (WayFlow A2A gates, output
   * renderers) — those paths already operate on full schemas.
   */
  fieldName?: string;
};

/** Structural subset of `use-ag-ui-run-stream`'s InterruptContext. */
export type StreamInterruptContext = {
  schema: Record<string, unknown>;
  xRenderer: string;
  values: Record<string, unknown>;
  reviewTaskId: string;
  fieldName?: string;
};

/**
 * Map an SSE-delivered interrupt context onto the panel's HitlGateContext.
 * childRunId is not carried in the INTERRUPT event — the renderers do not
 * read it, so null is safe. Propagates fieldName so the non-midRunHitl
 * onChange branch can wrap primitive values into `{[fieldName]: value}`
 * before approveReviewTask (without it the setup-loop infinite-bounces
 * because the server merge path drops primitives).
 */
export function mapInterruptToHitlContext(
  interruptContext: StreamInterruptContext | null,
): HitlGateContext | null {
  if (!interruptContext) return null;
  return {
    xRenderer: interruptContext.xRenderer,
    childRunId: null,
    reviewTaskId: interruptContext.reviewTaskId,
    inputSchema: interruptContext.schema,
    currentValues: interruptContext.values,
    fieldName: interruptContext.fieldName,
  };
}

/**
 * Suppress re-showing the same HITL screen after Approve/Reject while the
 * server processes the resume — prevents the "Loading recipients" flash
 * caused by the poll returning pending_approval with the stale context
 * before the graph advances. When a DIFFERENT xRenderer arrives (the next
 * step's gate), the suppression must be cleared (`clearSuppression`
 * signals the caller to null its ref).
 */
export function applyJustSubmittedSuppression(
  raw: HitlGateContext | null,
  justSubmittedXRenderer: string | null,
): { context: HitlGateContext | null; clearSuppression: boolean } {
  if (
    raw !== null &&
    justSubmittedXRenderer !== null &&
    raw.xRenderer === justSubmittedXRenderer
  ) {
    return { context: null, clearSuppression: false };
  }
  if (raw !== null && justSubmittedXRenderer !== null) {
    // Different step arrived — the caller should clear the suppression.
    return { context: raw, clearSuppression: true };
  }
  return { context: raw, clearSuppression: false };
}

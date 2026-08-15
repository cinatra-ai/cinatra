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

// ---------------------------------------------------------------------------
// Human-wait PRESENTATION discriminator (input vs approval).
//
// A run parks on `pending_approval` for TWO semantically different reasons, and
// the status column cannot tell them apart:
//
//   1. A SETUP-FIELD INPUT pause — the agent has not started yet and is
//      collecting a missing required input (the "Idea" field of the blog-draft
//      agent). Nothing is being approved.
//   2. A GENUINE REVIEW GATE — a WayFlow / langgraph mid-run interrupt where a
//      human approves or rejects work the agent already did.
//
// Labelling (1) "pending approval" is the defect this discriminator fixes.
//
// WHY NOT `RunHumanWaitReason`: that enum classifies BOTH of the above as
// `pending_approval` (see `run-wait-notifier.ts` — every entry into the status
// is one "reason"), so it carries no signal here. The discriminator must be
// SEMANTIC, read off the interrupt itself:
//
//   - the synthetic `setup-<runId>` reviewTaskId, which the setup-interrupt
//     loop in `execution.ts` is the ONLY emitter of (and which
//     `deriveRunHitlContext` reproduces on the poll path), or
//   - the setup payload kind: a `fieldName` on the interrupt, set ONLY by that
//     same setup loop (a WayFlow gate or output renderer never carries one).
//
// PRESENTATION ONLY. Nothing here feeds the state machine, the wait-reason
// enum, the resume path, or any authorization decision — it selects copy.
// ---------------------------------------------------------------------------

/**
 * Prefix of the synthetic setup-gate task identity (`setup-<runId>`). The ONE
 * home for this literal; `hitl-gate-submit.isSetupGateTaskId` reads it too.
 */
export const SETUP_GATE_TASK_ID_PREFIX = "setup-";

/** Which flavour of human wait an interrupt represents, for COPY selection. */
export type RunWaitInterruptKind = "input" | "approval";

/**
 * Structural minimum the classifier needs. Satisfied by `HitlGateContext`
 * (poll path), `StreamInterruptContext` (SSE path) and the host's
 * `deriveRunHitlContext` result alike, so every surface classifies identically.
 */
export type RunWaitInterruptDescriptor = {
  reviewTaskId?: string | null;
  fieldName?: string | null;
};

/** True for the synthetic `setup-<runId>` gate identity. */
export function isSetupInterruptTaskId(
  reviewTaskId: string | null | undefined,
): boolean {
  return (
    typeof reviewTaskId === "string" &&
    reviewTaskId.startsWith(SETUP_GATE_TASK_ID_PREFIX)
  );
}

/**
 * PURE. Classify an interrupt as an INPUT pause or an APPROVAL gate.
 *
 * Fails CLOSED to `"approval"`: with no interrupt in hand (a wait whose context
 * is not yet readable) the pre-existing approval copy is kept, so this change
 * can never relabel a genuine review gate.
 */
export function classifyRunWaitInterrupt(
  interrupt: RunWaitInterruptDescriptor | null | undefined,
): RunWaitInterruptKind {
  if (!interrupt) return "approval";
  if (
    typeof interrupt.fieldName === "string" &&
    interrupt.fieldName.trim().length > 0
  ) {
    return "input";
  }
  return isSetupInterruptTaskId(interrupt.reviewTaskId) ? "input" : "approval";
}

/** Badge copy for a setup-field INPUT pause. */
export const AWAITING_INPUT_BADGE_LABEL = "Awaiting input";

/**
 * Status → badge LABEL for both run surfaces. Every status keeps its previous
 * humanized rendering (`pending_approval` → "pending approval", …); ONLY a
 * `pending_approval` that the discriminator reads as an input pause changes,
 * to "Awaiting input".
 */
export function runStatusBadgeLabel(
  status: string,
  interrupt?: RunWaitInterruptDescriptor | null,
): string {
  if (
    status === "pending_approval" &&
    classifyRunWaitInterrupt(interrupt) === "input"
  ) {
    return AWAITING_INPUT_BADGE_LABEL;
  }
  return status.replace(/_/g, " ");
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

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
 * THE ROW WINS WHEN THE STREAM CANNOT SPEAK AGAIN (cinatra#3046).
 *
 * `resolveStreamFirst` above is right for every value the stream keeps
 * delivering: while a run is executing, the SSE frames are ahead of any poll and
 * the poll deliberately stops writing the status at all. It is wrong for exactly
 * one shape, and cinatra#3007 created that shape.
 *
 * A run whose produced output opens a review no longer reaches a terminal
 * status: it PARKS, and a parked run announces nothing. There is no RUN_FINISHED
 * and no RUN_ERROR, so the stream's last word stays `running` for as long as the
 * park lasts. Stream-first then pins the surface to `running` for ever: the slot
 * reader never looks (it looks only under `completed` or the parked status), the
 * placeholder never becomes the review card, and the run's own already-answered
 * question is redrawn with a live control because nothing can tell the surface
 * that the pause belongs to the review. Measured: the placeholder still stood
 * four minutes after the gate row existed, on both palettes, and only a RELOAD
 * swapped it — a reload re-seeds the status from the row, which is precisely the
 * reading this function restores without one.
 *
 * SO THE ROW IS CONSULTED, AND IT WINS ONLY WHERE THE STREAM IS PROVABLY MUTE.
 * The rule is narrow on purpose, and it is a rule about SILENCE rather than
 * about freshness:
 *
 *   · the stream must be enabled and its last word NON-TERMINAL — a stream that
 *     has said `completed`, `failed`, `stopped` or a park has spoken, and it
 *     keeps its say;
 *   · the ROW must report a status the stream cannot reach on its own: the
 *     parked status, or a terminal one. A row that merely disagrees about
 *     `queued` versus `running` changes nothing — the stream is ahead there and
 *     stays ahead.
 *
 * Everything else is byte-for-byte `resolveStreamFirst`, which is what the
 * unchanged callers keep getting.
 */
const RUN_STATUS_STREAM_CANNOT_LEAVE: ReadonlySet<string> = new Set([
  "queued",
  "running",
]);

/** The statuses a row may overrule a mute stream with: the park a run waits on
 *  its own review in, and the three the run never leaves.
 *
 *  DELIBERATELY NOT HERE: `waiting_trigger`. It is a second park a stream also
 *  cannot announce - an in-flight run suspended at a trigger wait - so the rule
 *  above would read on it, and letting the row win there is a change to what
 *  the TRIGGER surfaces draw, not to what the review gate draws: the status
 *  would leave `running`, `isLive` would go false with it, and a run waiting on
 *  its trigger would stop rendering as working mid-stream. That has no drawing
 *  to grade against in this change and no pin anywhere; it is named here so the
 *  omission is a decision on the record rather than a set somebody forgot to
 *  close, and it belongs in its own change with the trigger surfaces' own
 *  captures. */
const RUN_STATUS_ROW_MAY_OVERRULE: ReadonlySet<string> = new Set([
  "pending_approval",
  "completed",
  "failed",
  "stopped",
]);

export function resolveRunSurfaceStatus({
  streamEnabled,
  streamedStatus,
  polledStatus,
  rowStatus,
}: {
  streamEnabled: boolean;
  /** The stream's last word, or `null` when it has not delivered one. */
  streamedStatus: string | null;
  /** The poll-derived status — what `resolveStreamFirst` falls back to. */
  polledStatus: string;
  /** The run ROW's own status, as the run's seed route last answered it.
   *  `null` when this surface has never read one. */
  rowStatus: string | null;
}): string {
  const streamFirst = resolveStreamFirst(streamEnabled, streamedStatus, polledStatus);
  if (!streamEnabled || streamedStatus === null || rowStatus === null) return streamFirst;
  if (!RUN_STATUS_STREAM_CANNOT_LEAVE.has(streamedStatus)) return streamFirst;
  if (!RUN_STATUS_ROW_MAY_OVERRULE.has(rowStatus)) return streamFirst;
  return rowStatus;
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
  /**
   * The moment the RUN ITSELF states (cinatra#2928, `agent_runs.lifecycle_moment`).
   *
   * This is the recorded fact the two heuristics below were standing in for.
   * Optional because a run created before the column existed carries none, and
   * because the surfaces that hold only an interrupt still classify from it.
   */
  lifecycleMoment?: string | null;
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
 * A READER FIRST (cinatra#2928). The run now STATES which lifecycle moment it is
 * waiting at, so when the row carries one this function reads it instead of
 * inferring it — a wait for a setup field and a wait for a review are two
 * different recorded facts, and telling them apart stops being a matter of
 * recognizing a synthetic task-id prefix.
 *
 * The two heuristics stay BENEATH the reader, and deliberately: every run
 * created before the column existed carries no moment, and the SSE path holds
 * an interrupt without holding the row. They are the fallback now, not the
 * answer.
 *
 * Fails CLOSED to `"approval"`: with nothing readable at all the pre-existing
 * approval copy is kept, so this can never relabel a genuine review gate.
 */
export function classifyRunWaitInterrupt(
  interrupt: RunWaitInterruptDescriptor | null | undefined,
): RunWaitInterruptKind {
  if (!interrupt) return "approval";
  // THE RECORDED FACT, when the run states one.
  //   hitl   — the agent paused to ask for input.
  //   review — the agent produced something bound to an artifact.
  // Any other recorded moment falls through: a run parked for the skills
  // question or its schedule is not waiting at an interrupt at all, so this
  // classifier has nothing to say about it and keeps its fail-closed answer.
  if (interrupt.lifecycleMoment === "hitl") return "input";
  if (interrupt.lifecycleMoment === "review") return "approval";
  if (
    typeof interrupt.fieldName === "string" &&
    interrupt.fieldName.trim().length > 0
  ) {
    return "input";
  }
  return isSetupInterruptTaskId(interrupt.reviewTaskId) ? "input" : "approval";
}

/**
 * WHERE A WAIT'S NOTIFICATION SHOULD LAND (cinatra#2930, epic #2926 W3).
 *
 * The plan: "When a run waits at a moment, the notification links to the
 * conversation the run was started from — for the review as for a question —
 * and to the run page otherwise."
 *
 * SO THIS IS A SECOND QUESTION, NOT A SECOND ANSWER TO THE FIRST. A review is
 * still an APPROVAL for copy — it is a decision about work the agent already
 * did, and `classifyRunWaitInterrupt` keeps saying so, which is what keeps the
 * badge and the notification wording exactly as they are. What changes is only
 * the destination: a run that reached its review moment in a conversation has
 * its card there, and sending the reader to the run page instead is sending
 * them to a second copy of a decision they are already standing in front of.
 *
 * Fails CLOSED to the run page: a wait with nothing readable keeps the
 * pre-existing destination, exactly as the classifier keeps the pre-existing
 * copy.
 */
export function waitNotificationLandsInConversation(
  interrupt: RunWaitInterruptDescriptor | null | undefined,
): boolean {
  if (!interrupt) return false;
  if (interrupt.lifecycleMoment === "review") return true;
  return classifyRunWaitInterrupt(interrupt) === "input";
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

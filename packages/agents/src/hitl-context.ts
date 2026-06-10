// ---------------------------------------------------------------------------
// Shared HITL-context derivation for pending_approval runs.
//
// Single source of truth for BOTH polling surfaces that hydrate the run
// panel's HITL fallback context:
//   - REST : src/app/api/agents/runs/[runId]/route.ts (chat-inline wrapper +
//            no-taskId runs)
//   - A2A  : a2a-actions.ts buildSnapshot → getAgentBuilderTask (run panel
//            poll tick for runs with an a2a_task_id)
//
// Derivation order (same for both transports):
//   1. Read the persisted AG-UI INTERRUPT event from the Redis Streams run
//      log (bounded single XREVRANGE; gracefully null on Redis errors). The
//      poll path cannot rely on the AG-UI SSE stream to deliver the INTERRUPT
//      because navigation can happen AFTER the worker emitted it — SSE opens
//      reading from "$" (only-new) and misses the past event.
//   2. Fall back to a synthetic gate identity when no interrupt is readable:
//        - runs with an a2aTaskId  → `wayflow-<a2aTaskId>` (updated per gate
//          by handleWayflowTaskState, so it is a stable "which gate is the
//          run paused on" identity), empty schema/renderer.
//        - setup-loop runs (no a2aTaskId — paused before any execution
//          started) → `setup-<runId>` with the template inputSchema so
//          clients can render a generic approval form.
//
// No "use server" here — a2a-actions.ts is a server-action module and must
// only export async actions, so the shared helper lives in this plain module.
// ---------------------------------------------------------------------------

import { readLatestAgUiInterrupt } from "@cinatra-ai/agent-ui-protocol/server";
import {
  readAgentTemplateById,
  type AgentRunRecord,
  type AgentTemplateRecord,
} from "./store";

export type HitlContext = {
  xRenderer: string;
  // Setup-field interrupts have no child run; only child-HITL cascades populate
  // a non-null childRunId (SSE-only today — neither poll surface carries it).
  childRunId: string | null;
  reviewTaskId: string;
  inputSchema: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  /**
   * Schema property name carried on INTERRUPT (5th arg of
   * `AgUiAdapter.onInterrupt`). Set by the setup-loop in execution.ts — tells
   * the workspace panel which key to wrap primitive onChange values into when
   * calling `approveReviewTask({ [fieldName]: value }, fieldName)`.
   * `undefined` for non-setup-loop INTERRUPTs (WayFlow A2A gates, output
   * renderers) — those paths already operate on full schemas.
   */
  fieldName?: string;
};

/** Renderer id of the generic schema-driven approval form used when no
 *  persisted INTERRUPT is readable for a setup-loop run. */
const SETUP_FALLBACK_RENDERER = "@cinatra-ai/agent-builder:schema-field-fallback";

/**
 * Derive the HITL context for a run, or null when the run is not paused on a
 * gate (status !== "pending_approval") .
 *
 * `options.template` lets callers that already loaded the template (the REST
 * route reuses it for response metadata) avoid a second DB read; when
 * omitted, the template is only fetched on the rare setup-loop fallback path.
 */
export async function deriveRunHitlContext(
  run: AgentRunRecord,
  options?: { template?: AgentTemplateRecord | null },
): Promise<HitlContext | null> {
  if (run.status !== "pending_approval") return null;

  const interrupt = await readLatestAgUiInterrupt(run.id).catch(() => null);
  const runInputParams =
    run.inputParams && typeof run.inputParams === "object"
      ? (run.inputParams as Record<string, unknown>)
      : {};

  if (interrupt) {
    return {
      xRenderer: interrupt.xRenderer,
      childRunId: null,
      reviewTaskId:
        interrupt.reviewTaskId ||
        (run.a2aTaskId ? `wayflow-${run.a2aTaskId}` : `setup-${run.id}`),
      inputSchema: interrupt.schema ?? {},
      // Run input params first so live interrupt values win on key collisions.
      currentValues: { ...runInputParams, ...(interrupt.values ?? {}) },
      ...(interrupt.fieldName ? { fieldName: interrupt.fieldName } : {}),
    };
  }

  if (run.a2aTaskId) {
    // WayFlow gate with no readable interrupt: surface the stable synthetic
    // gate identity; renderer-specific context is unavailable.
    return {
      xRenderer: "",
      childRunId: null,
      reviewTaskId: `wayflow-${run.a2aTaskId}`,
      inputSchema: {},
      currentValues: runInputParams,
    };
  }

  // Setup-loop run (paused before any execution started): generic approval
  // form over the template's input schema.
  const template =
    options?.template !== undefined
      ? options.template
      : await readAgentTemplateById(run.templateId);
  return {
    xRenderer: SETUP_FALLBACK_RENDERER,
    childRunId: null,
    reviewTaskId: `setup-${run.id}`,
    inputSchema:
      template?.inputSchema && typeof template.inputSchema === "object"
        ? (template.inputSchema as Record<string, unknown>)
        : {},
    currentValues: runInputParams,
  };
}

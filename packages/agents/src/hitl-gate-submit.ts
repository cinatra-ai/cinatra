/**
 * Shared HITL gate-submit payload builders (cinatra#853).
 *
 * The two run surfaces — `agentic-run-panel.tsx` (chat inline card +
 * /agents run-detail) and `orchestrator-stepper-panel.tsx`
 * (HitlApprovalCard) — each re-implemented overlapping resume-payload
 * construction: gate classification (setup / grouped-setup / mid-run),
 * the setup-loop primitive wrap, the #817 context-selector envelope
 * synthesis, the renderer-specific approvalNote lifts, and the WayFlow
 * `userResponse` metadata. This module is the single, PURE home for that
 * logic so both panels submit byte-identical payloads and the branches
 * are unit-testable without mounting either panel.
 *
 * PURITY CONTRACT: no React, no `"use client"`, no host `@/` imports —
 * only other pure leaf modules. Mirrors the constraints documented in
 * `attachment-envelope-payload.ts` and `agent-builder-ids.ts`.
 */

import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "./agent-builder-ids";
import { wrapUserResponseWithAttachments } from "./wayflow-user-response-envelope";

// ---------------------------------------------------------------------------
// Gate classification
// ---------------------------------------------------------------------------

/**
 * A `setup-` reviewTaskId is the STRUCTURAL identity of the StartNode
 * step-0 input gate: oas-compiler hardcodes it
 * `{stepNumber:0, riskClass:"read_only", skipLlm:true}` and the
 * setup-interrupt loop in execution.ts is the ONLY emitter of synthetic
 * `setup-<runId>` ids — it pauses purely to COLLECT missing inputs, never
 * as a side-effect checkpoint (the real side-effect gates run through
 * inferStepSideEffects / SIDE_EFFECT_PATTERNS with their own non-`setup-`
 * ids). Setup gates skip the WayFlow approve/userResponse metadata: the
 * server-side setup merge keys off fieldName (single-field) or validates
 * grouped keys against inputSchema.properties and would reject extras.
 */
export function isSetupGateTaskId(reviewTaskId: string): boolean {
  return reviewTaskId.startsWith("setup-");
}

/**
 * Grouped-setup form classification. Both panels match the base renderer
 * id and its `<id>:` prefixed variants; the orchestrator stepper
 * additionally treats `:setup-form` suffixed renderers as grouped-setup
 * (they own their own submit button) — opt in via
 * `includeSetupFormSuffix`.
 */
export function isGroupedSetupRenderer(
  xRenderer: string,
  opts?: { includeSetupFormSuffix?: boolean },
): boolean {
  if (
    xRenderer === GROUPED_SETUP_FORM_RENDERER_ID ||
    xRenderer.startsWith(`${GROUPED_SETUP_FORM_RENDERER_ID}:`)
  ) {
    return true;
  }
  return opts?.includeSetupFormSuffix === true && xRenderer.endsWith(":setup-form");
}

/**
 * "Review task … already resolved" is an expected race (double-click,
 * external resolution, chat + form submitting the same gate), tolerated
 * at every submit site — same message-matching idiom in both panels.
 */
export function isAlreadyResolvedError(message: string): boolean {
  return message.toLowerCase().includes("already resolved");
}

// ---------------------------------------------------------------------------
// Setup-loop primitive wrap
// ---------------------------------------------------------------------------

/**
 * Setup-loop fallback path (both panels' non-mid-run onChange). The
 * SchemaFieldRenderer for primitive types (string, number, array,
 * boolean) emits `onChange(primitive)`. The approveReviewTask handler's
 * setup-* branch needs either a property-keyed object plus fieldName, or
 * an object whose keys match inputSchema.properties for grouped forms. A
 * bare primitive matches neither and silently drops the input, causing
 * the same gate to repeat forever. When the interrupt carried a
 * `fieldName` and the value is primitive, wrap as `{ [fieldName]: value }`
 * and pass fieldName so the single-field path in the handler runs.
 */
export function wrapPrimitiveSetupPayload(
  fieldName: string | undefined,
  next: unknown,
): { payload: unknown; payloadFieldName: string | undefined } {
  const isPrimitive =
    next === null ||
    next === undefined ||
    typeof next === "string" ||
    typeof next === "number" ||
    typeof next === "boolean" ||
    Array.isArray(next);
  if (fieldName && isPrimitive) {
    return { payload: { [fieldName]: next }, payloadFieldName: fieldName };
  }
  return { payload: next, payloadFieldName: undefined };
}

// ---------------------------------------------------------------------------
// #817 context-selector envelope synthesis
// ---------------------------------------------------------------------------

/**
 * Context-selector gate (#817) — synthesize the selection envelope when
 * the renderer emitted none. ContextSelectorRenderer only fires its
 * `emit()` on a toggle/clear; a slot with ZERO eligible candidates gives
 * the user nothing to toggle (the gate shows "run without context" +
 * Continue), so `userResponse` is never buffered and /api/context-finalize
 * 422s on the non-JSON value. Lift the trusted slotMeta + (pre-resolved)
 * selectedRefs from the interrupt values into the envelope the finalize
 * node forwards. A real toggle already set `payload.userResponse` —
 * PRESERVE it (only fill when absent).
 *
 * Returns a NEW object when the envelope is synthesized; the input
 * payload untouched otherwise.
 */
export function withContextSelectorEnvelope(
  xRenderer: string,
  interruptValues: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!xRenderer.endsWith(":context-selector")) return payload;
  if (typeof payload.userResponse === "string") return payload;
  const vals = (interruptValues ?? {}) as Record<string, unknown>;
  const slotMeta = vals["slotMeta"] as
    | { slotId?: unknown; resolutionMode?: unknown }
    | undefined;
  const selectedRefs = Array.isArray(vals["selectedRefs"]) ? vals["selectedRefs"] : [];
  if (!slotMeta || typeof slotMeta.slotId !== "string") return payload;
  return {
    ...payload,
    userResponse: JSON.stringify({
      slotId: slotMeta.slotId,
      resolutionMode: slotMeta.resolutionMode,
      selectedRefs,
    }),
  };
}

// ---------------------------------------------------------------------------
// Renderer-specific approvalNote lifts (orchestrator handleContinue +
// grouped-setup inline submit)
// ---------------------------------------------------------------------------

/**
 * Lift renderer-buffered values into a structured `approvalNote` snapshot
 * for the gates whose downstream continuation re-reads exactly what was
 * approved. Returns `{ approvalNote }` to merge into the resume payload,
 * or `null` when the renderer has no lift. The client-side fields are
 * advisory, not trusted — the server re-resolves (e.g. via crm_list_get).
 *
 * `now` is injectable for tests; defaults to the current time.
 */
export function liftRendererApprovalNote(
  xRenderer: string,
  buffered: Record<string, unknown>,
  now: string = new Date().toISOString(),
): { approvalNote: string } | null {
  if (xRenderer.endsWith(":list-picker")) {
    // Snapshot the selected list at approval time so downstream stages can
    // reference it; the server re-resolves via crm_list_get.
    const { listId, listName, memberCount } = buffered as {
      listId?: string;
      listName?: string;
      memberCount?: number;
    };
    return {
      approvalNote: JSON.stringify({
        type: "list" as const,
        listId: listId ?? "",
        listName: listName ?? "",
        memberCount: memberCount ?? 0,
        snapshotAt: now,
      }),
    };
  }
  if (xRenderer.endsWith(":setup-form")) {
    const { offeringCompanyWebsite, callToAction, senderName } = buffered as {
      offeringCompanyWebsite?: string;
      callToAction?: string;
      senderName?: string;
    };
    return {
      approvalNote: JSON.stringify({ offeringCompanyWebsite, callToAction, senderName }),
    };
  }
  // Gate 1: scrape-schema-review — snapshot the operator-edited
  // instructions + outputSchema + seedUrls exactly as approved.
  if (xRenderer.endsWith(":scrape-schema-review")) {
    const {
      instructions = "",
      outputSchema = { type: "object", properties: {} },
      seedUrls = [],
    } = buffered as {
      instructions?: string;
      outputSchema?: Record<string, unknown>;
      seedUrls?: string[];
    };
    return {
      approvalNote: JSON.stringify({
        type: "scrape-schema",
        instructions,
        outputSchema,
        seedUrls,
        snapshotAt: now,
      }),
    };
  }
  // Gate 2: final-list-review — snapshot listName + LLM-built memberRefs;
  // the server re-resolves members during crm_list_member_add.
  if (xRenderer.endsWith(":final-list-review")) {
    const {
      listName = "",
      memberRefs = [],
      memberCount = 0,
    } = buffered as {
      listName?: string;
      memberRefs?: Array<{ objectType: string; objectId: string }>;
      memberCount?: number;
    };
    return {
      approvalNote: JSON.stringify({
        type: "final-list",
        listName,
        memberRefs,
        memberCount,
        snapshotAt: now,
      }),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chat-gate submit payload (AgenticRunPanel — the single discriminated
// resume-payload builder behind submitActiveGate / ChatGateDescriptor.submit)
// ---------------------------------------------------------------------------

/**
 * Build the resume payload for a chat-driven gate submit. Discriminates by
 * reviewTaskId, not xRenderer. Three shapes:
 *
 *  - single-field setup-loop: `fieldName` set → wrap under that key ONLY
 *    (no WayFlow approve/userResponse metadata; the server-side setup
 *    merge keys off fieldName and would reject extra keys). When `value`
 *    is an object already carrying the fieldName key, unwrap it first.
 *  - grouped setup form: setup- prefix, NO fieldName → merge the field
 *    object over the buffer, also WITHOUT WayFlow metadata
 *    (review-task-actions validates grouped keys against
 *    inputSchema.properties).
 *  - everything else is a mid-run / WayFlow gate → needs approved +
 *    approvedAt + userResponse (WayFlow resume-text contract:
 *    review-task-actions picks values.userResponse → approvalNote →
 *    fallback). The `userResponse` text is wrapped with the WayFlow
 *    user_envelope when paperclip attachments are pending; with no
 *    attachments the wrapper returns byte-identical text.
 *
 * `now` is injectable for tests; defaults to the current time.
 */
export function buildChatGateSubmitPayload(args: {
  reviewTaskId: string;
  fieldName?: string;
  value: Record<string, unknown> | string | number | boolean;
  buffered: Record<string, unknown>;
  pendingAttachments: ReadonlyArray<LlmAttachmentRef>;
  now?: string;
}): { payload: Record<string, unknown>; payloadFieldName: string | undefined } {
  const { reviewTaskId, fieldName, value, buffered, pendingAttachments } = args;
  const isSetupGate = isSetupGateTaskId(reviewTaskId);
  if (isSetupGate && fieldName) {
    const raw =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      fieldName in (value as Record<string, unknown>)
        ? (value as Record<string, unknown>)[fieldName]
        : value;
    return {
      payload: { ...buffered, [fieldName]: raw },
      payloadFieldName: fieldName,
    };
  }
  const obj =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  if (isSetupGate) {
    // Grouped setup form — field object over the buffer, no WayFlow metadata.
    return { payload: { ...buffered, ...obj }, payloadFieldName: undefined };
  }
  // Compute the `userResponse` text first, then wrap with the WayFlow
  // envelope when paperclip attachments are pending. No attachments means
  // the wrapper returns the text verbatim (back-compat invariant).
  const legacyUserResponseText = JSON.stringify(
    Object.keys(obj).length > 0
      ? obj
      : typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ? value
        : { approved: true },
  );
  const wrapped = wrapUserResponseWithAttachments(
    legacyUserResponseText,
    pendingAttachments,
  );
  return {
    payload: {
      ...buffered,
      ...obj,
      approved: true,
      approvedAt: args.now ?? new Date().toISOString(),
      // WayFlow resume-text contract — without userResponse the server
      // forwards only "[Approved by operator]" to the flow.
      userResponse: wrapped.userResponse,
    },
    payloadFieldName: undefined,
  };
}

/**
 * AgenticRunPanel's visible-Continue attachment wrap. Only enters the wrap
 * when attachments are pending; PRESERVES a renderer-authored string
 * `userResponse`, else falls back to the server default text
 * ("[Approved by operator]" — mirrors review-task-actions).
 *
 * DELIBERATELY narrower than `applyAttachmentEnvelope`
 * (attachment-envelope-payload.ts), which the orchestrator panel uses and
 * which also consults `approvalNote` (pickLegacyResumeText precedence).
 * The two panels' precedence divergence is pre-existing behavior; unifying
 * it would change the WayFlow resume text for AgenticRunPanel gates whose
 * renderer buffered an approvalNote without a userResponse. Keep them
 * distinct until that alignment is decided deliberately.
 */
export function applyAttachmentEnvelopeUserResponseOnly(
  payload: Record<string, unknown>,
  attachments: ReadonlyArray<LlmAttachmentRef>,
): Record<string, unknown> {
  if (attachments.length === 0) return payload;
  const existing =
    typeof payload.userResponse === "string"
      ? (payload.userResponse as string)
      : "[Approved by operator]";
  const wrapped = wrapUserResponseWithAttachments(existing, attachments);
  return { ...payload, userResponse: wrapped.userResponse };
}

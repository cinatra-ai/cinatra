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
import { HITL_PLACEHOLDER_FIELD_NAME } from "./humanize-field-name";
import { isSetupInterruptTaskId } from "./run-surface-status";
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
  return isSetupInterruptTaskId(reviewTaskId);
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
// The stale-gate rejection, as a TYPED outcome (cinatra#3219)
// ---------------------------------------------------------------------------

/**
 * What a gate submit did. The `blocked` arm names a reason from the review
 * surface's closed blocked set, so the caller renders the state the surface
 * already draws (`ReviewGateBlocked`) rather than deciding what to say.
 *
 * It is a RETURNED result, not a thrown error, because that is the only shape
 * that survives the Server Action boundary in production: an ordinary thrown
 * error arrives masked, message replaced by an opaque digest.
 */
export type GateSubmitOutcome =
  | { ok: true }
  | { ok: false; blocked: "no-longer-pending" };

/**
 * Classify a gate-submit rejection from its TYPE, never from its message.
 *
 * The two shapes the approval path refuses with are both this one thing —
 * "the gate you opened is gone":
 *   - `GateNotPendingError` — the run had already left `pending_approval` by
 *     the time the status was read (`review-task-actions.ts`, both the setup
 *     and the WayFlow guard);
 *   - `RunTransitionError` with `code: "stale_from_status"` — the status was
 *     still `pending_approval` at that read, and the compare-and-swap lost the
 *     race before the write (`resume-run-from-setup-approval.ts`).
 *
 * Anything else is a real failure and stays on the error path.
 *
 * DUCK-TYPED ON PURPOSE, and structural for the same reason the outcome is:
 * `instanceof` is an identity check across module instances, and this runs on
 * whatever shape reaches it. `name` + `code` are the discriminant, and they
 * survive a structured clone.
 */
export function classifyGateRejection(err: unknown): "no-longer-pending" | null {
  if (typeof err !== "object" || err === null) return null;
  const { name, code } = err as { name?: unknown; code?: unknown };
  if (name === "GateNotPendingError" && code === "gate_not_pending") {
    return "no-longer-pending";
  }
  if (name === "RunTransitionError" && code === "stale_from_status") {
    return "no-longer-pending";
  }
  return null;
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
 *
 * OBJECT-typed setup inputs (cinatra#2484) need the same wrap even though their
 * value is NOT primitive: the object IS the field's value (`{title, summary,
 * outline}` for `idea`), so it must land at `inputParams.idea`, not be spread
 * across the top level — where the grouped path's allowlist would then reject
 * `title`/`summary`/`outline` as keys not declared in inputSchema. The caller
 * opts in via `objectTypedField` (read from the interrupt's own field schema);
 * WITHOUT that flag behaviour is byte-identical to before, so every other
 * renderer that emits a multi-key object for a single-field gate keeps routing
 * to the grouped merge.
 *
 * The wrap is UNCONDITIONAL under the flag — deliberately no "looks already
 * wrapped" shortcut. The object-typed renderers emit the field's VALUE, never a
 * `{ [fieldName]: value }` envelope, so there is nothing to detect; and a value
 * cannot be told apart from an envelope by shape. An input `idea` whose declared
 * sub-properties happen to include one named `idea` would produce exactly the
 * `{idea: …}` shape a shortcut would mistake for an envelope — silently storing
 * the sub-value one level too shallow.
 */
export function wrapPrimitiveSetupPayload(
  fieldName: string | undefined,
  next: unknown,
  opts?: { objectTypedField?: boolean },
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
  if (
    fieldName &&
    opts?.objectTypedField === true &&
    next !== null &&
    typeof next === "object" &&
    !Array.isArray(next)
  ) {
    return {
      payload: { [fieldName]: next as Record<string, unknown> },
      payloadFieldName: fieldName,
    };
  }
  return { payload: next, payloadFieldName: undefined };
}

/**
 * The `value` prop for a per-field setup gate's renderer (cinatra#2484, codex
 * round 2).
 *
 * The two Setup surfaces disagree about what `value` means. The grouped form
 * passes `field.value` — the field's OWN value. The per-field panels pass the
 * whole `currentValues` ENVELOPE (every input of the run) to every field, so the
 * renderer cannot tell which slot is its own from `value` alone. (Since
 * cinatra#2541 the per-field panels DO pass the real `fieldName`, but that
 * changes nothing here: `value` is still resolved at the caller — see below —
 * and no renderer indexes the envelope itself.)
 *
 * For an OBJECT-typed field that ambiguity is a correctness bug, not a cosmetic
 * one: the renderer has to seed sub-fields from the field's own object, and any
 * heuristic it applies to an envelope is wrong in some case — filtering the
 * envelope by declared sub-keys seeds an object's `title` from an UNRELATED run
 * input that merely shares the name. Resolve it at the CALLER, which is the only
 * place that actually knows both the envelope and the real field name, so the
 * renderer's `value` is unambiguously the field's own value on every surface.
 *
 * Scoped to object-typed fields ON PURPOSE. Unwrapping for every type would also
 * start pre-filling string/number/array gates from previously-submitted values —
 * a behaviour change the per-field surface deliberately avoids (see the
 * fieldName-keyed remount comment in orchestrator-stepper-panel).
 */
export function setupFieldRendererValue(
  envelope: Record<string, unknown>,
  fieldName: string | undefined,
  fieldSchema: unknown,
): unknown {
  const isObjectTyped = (fieldSchema as { type?: string } | undefined)?.type === "object";
  if (!isObjectTyped || !fieldName) return envelope;
  return envelope[fieldName];
}

/**
 * The `fieldName` prop for a single-field HITL gate's renderer (cinatra#2541).
 *
 * THE SEAM THIS ISSUE REGRESSED AT. Both single-field HITL surfaces used to
 * hand the renderer the literal `"hitl-field"` while the interrupt's REAL field
 * key sat one line away (it already keyed the React remount and selected the
 * renderer's value). `fieldName` is the renderer's whole field identity — it
 * drives the DOM id AND, through `resolveFieldLabel`, the visible label — so
 * the placeholder made every per-field setup gate render "Hitl Field" instead
 * of "Idea".
 *
 * #817 and #1162 both landed on this label: #817 removed the raw `hitl-field`
 * string from the context-selection gate by resolving that gate to its real
 * renderer, and #1162 made the humanizer run even when the OAS emits
 * `title === fieldName`. Neither could reach THIS surface, because both fixed
 * what happens to a field name AFTER it is passed — and the bug is what gets
 * passed. Route every renderer call site through this helper so the identity is
 * decided in ONE named place instead of being re-typed at each JSX prop.
 *
 * Returns the interrupt's field name when it has one, and the internal
 * placeholder only when it genuinely does not (mid-run gates and output
 * renderers carry no `fieldName` — see `InterruptContext.fieldName`). In that
 * case `resolveFieldLabel`'s placeholder guard keeps the token out of the UI.
 */
export function hitlRendererFieldName(fieldName: string | undefined): string {
  return fieldName !== undefined && fieldName.trim() !== ""
    ? fieldName
    : HITL_PLACEHOLDER_FIELD_NAME;
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

// ---------------------------------------------------------------------------
// A GATE ANSWER THAT NAMES NOTHING KEEPS ITS RUN PARKED (cinatra#3358).
//
// THE MEASURED DEFECT. A run started on an account that holds no list reached
// its account-scope step, and the step could be continued with nothing chosen:
// the panel sent `{approved:true}` plus a snapshot naming an EMPTY list, the
// resume dispatched, and the run walked past that review step and the one after
// it without ever raising a gate on the missing list. Neither end of the submit
// asked the one question the step exists to ask — "is there a list yet?" — so
// both ends ask it here, from ONE rule, the way every other submit decision in
// this module is shared between the two surfaces.
//
// GENERIC BY CONSTRUCTION, at both ends and for the same reason the lift above
// is generic: the client end keys on the RENDERER FAMILY (`:list-picker` —
// every package that declares a list-picking step, and no package by name), the
// server end on the ANSWER CONTRACT that `liftRendererApprovalNote` mints for
// that family (`type: "list"`). Nothing here learns which package is at either
// end, and a package that declares no list-picking step is untouched by it.
//
// IT REFUSES, IT DOES NOT BLOCK. The gate is still open and still the reader's
// to answer — so this is an ordinary incomplete-answer refusal, never one of the
// three reasons of the closed blocked axis the review surface draws (§V). The
// step keeps its place in the rail and the run stays where it is.
// ---------------------------------------------------------------------------

/** What the reader is told when a list-picking step is continued with no list. */
export const LIST_ANSWER_NAMES_NO_LIST =
  "Choose a list before continuing — or build one first.";

/**
 * Does an answer that is supposed to NAME a list name none? An absent answer
 * names no list just as surely as one carrying an empty id, so both are the
 * same verdict here.
 */
function namesNoList(answer: unknown): boolean {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return true;
  const listId = (answer as { listId?: unknown }).listId;
  return typeof listId !== "string" || listId.trim().length === 0;
}

/**
 * THE CLIENT END. Why a step about to be continued may not be: read off the
 * renderer family and the answer the step actually holds. `null` = nothing in
 * the way, which is every gate of every other family.
 *
 * `gateValues` are the gate's OWN current values — what the renderer was drawn
 * from — and they are read BESIDE the buffer because a step re-drawn with a list
 * already chosen shows that row selected without the reader touching anything
 * (the picker seeds its selection from the incoming value and emits only on a
 * click). A step that already holds a list is not a step that names none, so it
 * is not refused.
 */
export function gateAnswerIncompleteReason(
  xRenderer: string,
  buffered: Record<string, unknown> | null | undefined,
  gateValues?: Record<string, unknown> | null,
): string | null {
  if (!xRenderer.endsWith(":list-picker")) return null;
  if (!namesNoList(buffered)) return null;
  if (!namesNoList(gateValues)) return null;
  return LIST_ANSWER_NAMES_NO_LIST;
}

/**
 * THE ONE ANSWER A RESUME ACTUALLY DISPATCHES, as both resume seams order it:
 * `userResponse` wins over `approvalNote`, and free text is not a structured
 * answer. Reading the EFFECTIVE answer — not every key that happens to be
 * present — is what keeps the rule below from refusing an answer the seam would
 * have accepted: a superseded note left beside a good `userResponse` is never
 * what the run receives.
 */
function effectiveStructuredAnswer(values: unknown): Record<string, unknown> | null {
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  const { approvalNote, userResponse } = values as {
    approvalNote?: unknown;
    userResponse?: unknown;
  };
  for (const raw of [userResponse, approvalNote]) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Free text IS the answer this resume sends, and it names no list. Either
      // way the first non-empty key is the answer — nothing behind it is read.
    }
    return null;
  }
  return null;
}

/** The pending gate a resume is answering, as the server derived it itself. */
export type ResumeGateContract = {
  /** The renderer family the pending gate declared, or null when unknown. */
  xRenderer?: string | null;
  /** The values the pending gate already holds. */
  currentValues?: unknown;
};

/**
 * THE SERVER END, and the authoritative one: the client refusal is a courtesy,
 * this is the pin. Two readings, in this order:
 *
 *  1. THE GATE'S OWN CONTRACT, when the seam derived the pending gate. A step
 *     whose renderer family asks for a list may not be resumed on an answer that
 *     names none — INCLUDING NO ANSWER AT ALL. That case is not hypothetical: a
 *     supported surface reaches the resume seam with no values whatsoever (the
 *     lifecycle card's Continue submits the form as it stands), and a payload-only
 *     reading let exactly that walk a listless run past its step. A gate that
 *     already holds a list is never refused.
 *  2. THE ANSWER'S OWN DECLARED CONTRACT, when no gate is in hand. A resume that
 *     reaches a seam any other way (a replayed action, a hand-built payload) is
 *     still refused when the answer it carries declares itself a list answer and
 *     names none.
 *
 * Generic at both readings: the renderer FAMILY and the answer CONTRACT, never a
 * package, a template or a renderer id.
 */
export function resumeAnswerIncompleteReason(
  values: unknown,
  gate?: ResumeGateContract | null,
): string | null {
  const answer = effectiveStructuredAnswer(values);
  const gateAsksForAList =
    typeof gate?.xRenderer === "string" && gate.xRenderer.endsWith(":list-picker");
  if (gateAsksForAList) {
    if (!namesNoList(answer)) return null;
    if (!namesNoList(gate?.currentValues)) return null;
    return LIST_ANSWER_NAMES_NO_LIST;
  }
  if (!answer) return null;
  if ((answer as { type?: unknown }).type !== "list") return null;
  return namesNoList(answer) ? LIST_ANSWER_NAMES_NO_LIST : null;
}

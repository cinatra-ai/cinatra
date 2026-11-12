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
    // cinatra#3452 — THE EMPTY BOX HAS TO SURVIVE THE BOUNDARY.
    //
    // A field left empty emits `undefined`, and `{ [fieldName]: undefined }`
    // loses its key on the way across the Server Action boundary: the approval
    // road then received a submission that never named the field, and could not
    // tell an optional box left blank from a field it was never handed — so it
    // refused Continue, naming the field, for optional and required alike.
    // Submitting the empty box as an explicit `null` keeps "answered, with
    // nothing" legible on the far side, where the required/optional split is
    // made. Every other primitive (including a real `null`, `0` and `false`) is
    // wrapped exactly as before.
    const wrappedValue = next === undefined ? null : next;
    return { payload: { [fieldName]: wrappedValue }, payloadFieldName: fieldName };
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

/**
 * Is a BOOLEAN field on a MID-RUN gate told `hideSubmit`? (cinatra#4310.)
 *
 * Since cinatra#4310 the schema-drawn boolean draws a Continue of its own
 * wherever it is not told `hideSubmit`. That is right on a per-field setup
 * gate: the fallback entry declares `drawsOwnSubmit`, so the surface draws no
 * Continue beside the field. A mid-run gate is not like that. Each surface
 * (the run panel, the orchestrator stepper and the HITL screen card) draws its
 * own outer Continue beneath every mid-run renderer that is not a grouped setup
 * form, and the approved input card gives that gate one host control and no
 * separate field send. So on a mid-run gate the boolean field is told
 * `hideSubmit`: it draws no Continue, and its box hands each change to the
 * gate's `onChange` exactly as it did before cinatra#4310. The surface's one
 * outer Continue is the gate's only control. That `onChange` keeps only a
 * non-array object, so a boolean's answer is dropped there and the Continue
 * sends the approval without it; main does the same (cinatra#4506).
 *
 * "A boolean" is what the schema-field renderer draws with its boolean branch:
 * `type` exactly `"boolean"`, and no non-empty `enum`, because the renderer
 * draws a non-empty `enum` first, as a Select with no Continue. Only the
 * boolean, on purpose: it is the one kind whose control cinatra#4310 moved. The
 * rule reads the schema, not the renderer, so a custom renderer of a mid-run
 * gate whose schema is such a boolean is told `hideSubmit` too, and the shared
 * props contract asks it to skip a submit of its own beside the surface's
 * Continue. A grouped setup form is never told this, because it draws the one
 * submit of its own form.
 */
export function midRunBooleanFieldHidesSubmit(gate: {
  isMidRun: boolean;
  isGroupedSetup: boolean;
  fieldSchema: unknown;
}): boolean {
  if (!gate.isMidRun || gate.isGroupedSetup) return false;
  const schema = gate.fieldSchema as { type?: unknown; enum?: unknown } | null | undefined;
  if (schema?.type !== "boolean") return false;
  const enumValues = schema?.enum;
  return !(Array.isArray(enumValues) && enumValues.length > 0);
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
// A schema-drawn gate that asks for fields of its own (cinatra#4244)
// ---------------------------------------------------------------------------

/** Keys every approval payload carries; a schema naming only these asks nothing. */
const APPROVAL_BOOKKEEPING_KEYS: ReadonlySet<string> = new Set(["approved", "approvedAt"]);

function isPlainSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What an object-typed gate schema on the schema-field fallback asks for
 * (cinatra#4244).
 *
 *  - `not-object`: the schema is not an object schema; this reading does not
 *    apply and the gate keeps the road it had.
 *  - `bare`: a well-formed object schema that declares no visible field other
 *    than the `approved` / `approvedAt` bookkeeping keys. It is a step
 *    confirmation: nothing to fill, a Continue alone.
 *  - `fields`: a well-formed object schema that declares visible fields - a
 *    WayFlow InputMessageNode such as "Pick the brand voice" declaring
 *    `brandVoice`. `fields` lists them in declaration order. `renderSchema` is
 *    the schema the fallback draws: without the bookkeeping keys (they are
 *    never the reader's to fill) and without `x-renderer`, with `required`
 *    holding every declared-required visible field that declares no
 *    `default` - from the schema's `required` list and from a field's own
 *    `x-required: true` - so the drawn form holds its Continue until those
 *    values are written (design V.1). A value with a default is answered by it
 *    and never held.
 *  - `malformed`: an object schema whose declaration cannot be read safely,
 *    at ANY depth (`isWellFormedFieldSchema`) - `properties` present but not
 *    a map, a property or array `items` that is not a schema object,
 *    `required` present but not a list of names, a non-boolean `x-hidden` /
 *    `x-required`, nesting deeper than `MAX_SCHEMA_DEPTH` - and a gate schema
 *    with no `properties` whose `required` list names any value (the card has
 *    no field to write it into). It is refused: it is neither a bare
 *    confirmation (that would send an approval for a gate nobody could read)
 *    nor drawable (a property that is not a schema cannot be drawn).
 *
 * Field names are agent-declared, so the maps built here have no prototype:
 * a field named `__proto__` stays an own field and is never the prototype
 * setter.
 */
export type SchemaFieldGateReading =
  | { kind: "not-object" }
  | { kind: "bare" }
  | { kind: "malformed" }
  | { kind: "fields"; fields: string[]; renderSchema: Record<string, unknown> };

/** Deeper nesting than this is refused as malformed (fail closed, no unbounded walk). */
const MAX_SCHEMA_DEPTH = 16;

/**
 * Whether a declared field schema can be read safely, at every depth: a plain
 * object; `properties`, when present, a map whose members are all
 * well-formed; `items`, when present, a well-formed schema; `required`, when
 * present, a list of names; `x-hidden` / `x-required`, when present, booleans.
 */
function isWellFormedFieldSchema(sub: unknown, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH || !isPlainSchemaObject(sub)) return false;
  const hidden = sub["x-hidden"];
  const xReq = sub["x-required"];
  if (hidden !== undefined && typeof hidden !== "boolean") return false;
  if (xReq !== undefined && typeof xReq !== "boolean") return false;
  const required = sub.required;
  if (required !== undefined && (!Array.isArray(required) || !required.every((n) => typeof n === "string"))) {
    return false;
  }
  const properties = sub.properties;
  if (properties !== undefined) {
    if (!isPlainSchemaObject(properties)) return false;
    for (const member of Object.values(properties)) {
      if (!isWellFormedFieldSchema(member, depth + 1)) return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(sub, "items") && !isWellFormedFieldSchema(sub.items, depth + 1)) {
    return false;
  }
  return true;
}

/** An own-property read: a plain `obj[key]` reads the prototype for `__proto__`. */
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** An own-property write: a plain `obj[key] = v` calls the prototype setter for `__proto__`. */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Thrown when an answer holds a number JSON cannot carry (it would reach the flow as null). */
export class NonFiniteAnswerError extends Error {
  constructor(field: string) {
    super(`The answer to "${field}" is not a finite number.`);
    this.name = "NonFiniteAnswerError";
  }
}

function holdsNonFiniteNumber(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  // Too deep to read is refused, never waved through.
  if (depth > MAX_SCHEMA_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => holdsNonFiniteNumber(v, depth + 1));
  if (isPlainSchemaObject(value)) {
    return Object.values(value).some((v) => holdsNonFiniteNumber(v, depth + 1));
  }
  return false;
}

export function readSchemaFieldGate(schema: unknown): SchemaFieldGateReading {
  if (!isPlainSchemaObject(schema) || schema.type !== "object") return { kind: "not-object" };
  const { properties, required } = schema;
  if (properties === undefined) {
    if (required === undefined) return { kind: "bare" };
    return Array.isArray(required) && required.length === 0
      ? { kind: "bare" }
      : { kind: "malformed" };
  }
  if (!isPlainSchemaObject(properties)) return { kind: "malformed" };
  if (
    required !== undefined &&
    (!Array.isArray(required) || !required.every((n) => typeof n === "string"))
  ) {
    return { kind: "malformed" };
  }
  const kept = Object.create(null) as Record<string, Record<string, unknown>>;
  const fields: string[] = [];
  const xRequired: string[] = [];
  for (const [name, sub] of Object.entries(properties)) {
    if (!isWellFormedFieldSchema(sub, 1)) return { kind: "malformed" };
    const member = sub as Record<string, unknown>;
    const hidden = member["x-hidden"];
    const xReq = member["x-required"];
    if (APPROVAL_BOOKKEEPING_KEYS.has(name)) continue;
    setOwn(kept, name, member);
    if (hidden === true) continue;
    fields.push(name);
    if (xReq === true) xRequired.push(name);
  }
  if (fields.length === 0) return { kind: "bare" };
  const held = (name: string) =>
    fields.includes(name) &&
    !Object.prototype.hasOwnProperty.call(ownValue(kept, name) as object, "default");
  const requiredNames: string[] = [];
  for (const name of [...((required as string[] | undefined) ?? []), ...xRequired]) {
    if (held(name) && !requiredNames.includes(name)) requiredNames.push(name);
  }
  const { "x-renderer": _xr, properties: _p, required: _r, ...rest } = schema;
  void _xr;
  void _p;
  void _r;
  return {
    kind: "fields",
    fields,
    renderSchema: { ...rest, type: "object", properties: kept, required: requiredNames },
  };
}

/**
 * The approval payload for a non-setup gate whose fields the schema-field
 * fallback draws (cinatra#4244).
 *
 * `next` is what the drawn object field submits: the object of its declared
 * fields (blank optional values left out), or `undefined`.
 *
 *  - The approval is `{ ...answer, approved: true, approvedAt }`; the
 *    bookkeeping keys are always the approval's own.
 *  - EVERY declared answer reaches the flow. The server forwards
 *    `userResponse` to the paused WayFlow node as its resume text, and without
 *    it the node is handed "[Approved by operator]" in place of the answer.
 *    When the gate asks for exactly one field, declared as a string, and the
 *    answer is a string, that text is the resume text verbatim (the
 *    convention the idea-selection renderer follows for its one output). Any
 *    other answer - a list, a number, a boolean, an object, or several
 *    fields - is sent as one JSON object of the declared fields that were
 *    answered (a blank text or an empty list is not an answer), the
 *    structured round-trip the server parses back into the submitted values.
 *    A single text answer that itself parses as JSON (`42`, `{"tone":"warm"}`)
 *    is sent in that JSON form too, under its declared field: sent verbatim,
 *    the server would parse it as the submitted values themselves.
 *  - A number that is not finite cannot travel as JSON (it would reach the
 *    flow as `null`): the payload is refused with `NonFiniteAnswerError`.
 *  - No declared field answered: no resume text, so the flow receives the
 *    approval marker, as the Continue-only card sent for this gate.
 *  - A `userResponse` the answer already carries is kept as it is.
 *  - A schema that is not read as `fields` adds no resume text.
 */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function buildSchemaFieldGatePayload(args: {
  schema: unknown;
  next: unknown;
  now?: string;
}): Record<string, unknown> {
  const answer = isPlainSchemaObject(args.next) ? args.next : {};
  const payload: Record<string, unknown> = {
    ...answer,
    approved: true,
    approvedAt: args.now ?? new Date().toISOString(),
  };
  if (typeof answer.userResponse === "string") return payload;
  const reading = readSchemaFieldGate(args.schema);
  if (reading.kind !== "fields") return payload;
  const answered = Object.create(null) as Record<string, unknown>;
  for (const name of reading.fields) {
    const value = ownValue(answer, name);
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (holdsNonFiniteNumber(value)) throw new NonFiniteAnswerError(name);
    setOwn(answered, name, value);
  }
  const names = Object.keys(answered);
  if (names.length === 0) return payload;
  if (reading.fields.length === 1) {
    const only = reading.fields[0]!;
    const declared = ownValue(reading.renderSchema.properties as Record<string, unknown>, only) as
      | { type?: unknown }
      | undefined;
    const value = ownValue(answered, only);
    if (declared?.type === "string" && typeof value === "string" && !parsesAsJson(value)) {
      payload.userResponse = value;
      return payload;
    }
  }
  payload.userResponse = JSON.stringify(answered);
  return payload;
}

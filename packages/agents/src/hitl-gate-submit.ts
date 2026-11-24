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
 * `attachment-envelope-payload.ts` and `agent-builder-ids.ts`. The one read
 * beyond its arguments is a binding's declared kind in the field-renderer
 * registry (`isListPickerRenderer`, cinatra#3470), a leaf with no React.
 */

import type { LlmAttachmentRef } from "@cinatra-ai/llm";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "./agent-builder-ids";
import {
  declaredHitlCardOf,
  isListPickerRenderer,
  isRendererBound,
  isRendererBoundByRuntimeRead,
  rendererReadsAsKind,
  awaitsFreshRendererBindingRead,
  freshReadKey,
  answeredScreenPin,
  midRunBindingReadsAsKind,
  DECLARED_SCREEN_PIN_NONE,
  DECLARED_SCREEN_PIN_UNVERIFIED,
  stepPinAdmits,
  type RendererBindingsLoad,
  type RendererStep,
} from "./field-renderer-registry";
import { HITL_PLACEHOLDER_FIELD_NAME } from "./humanize-field-name";
import { isSetupInterruptTaskId } from "./run-surface-status";
import { readSentUserEnvelope, wrapUserResponseWithAttachments } from "./wayflow-user-response-envelope";

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
 * The identity of one gate: its review task, its renderer and the field it
 * names. Injective (a JSON list, no chosen separator), because all three parts
 * are unconstrained strings from a run's own row. Each surface keys what belongs
 * to one gate on it: the buffer and the mounted renderer (cinatra#3380), and the
 * renderer's validity report, the staged draft and answer, the registered flush
 * and the answered marker (cinatra#3562). It is the one gate key of every run
 * surface. A missing field is the `null` field, and it is not the empty field.
 */
export function hitlGateIdentityKey(gate: {
  reviewTaskId: string;
  xRenderer: string;
  fieldName?: string | null;
}): string {
  return JSON.stringify([gate.reviewTaskId, gate.xRenderer, gate.fieldName ?? null]);
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
  // A MID-RUN binding of the grouped form's kind is one on every host, with or
  // without the option (cinatra#3470): the form sends from its own control,
  // which validates it first, and a host that drew its Continue beside it
  // would send the approval past that validation and without the values.
  if (midRunBindingReadsAsKind(xRenderer, "wayflow-setup-form")) return true;
  // A `:setup-form` id is a grouped setup only when no registered binding says
  // otherwise: a declared card is never one, and a binding's declared kind
  // decides before its suffix (cinatra#3470).
  return (
    opts?.includeSetupFormSuffix === true &&
    rendererReadsAsKind(xRenderer, "wayflow-setup-form", ":setup-form")
  );
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

/**
 * The approval flag a mid-run Continue sends (cinatra#3470). The screen's own
 * choices only stage an answer and the host's one Continue sends it, "a
 * decline as a decline" (design app-artifact-review I.4 and I.5): a staged
 * `approved: false` is kept, and every other staged answer continues as an
 * approval, as before. For a DECLARED card (`xRenderer` names one) only the
 * operator's chosen decision decides (`declaredHitlApprovalFlag`), never a
 * value the staged answer carries from the run.
 */
export function continueApprovalFlag(staged: Record<string, unknown>, xRenderer?: string): boolean {
  const declared = xRenderer === undefined ? undefined : declaredHitlCardOf(xRenderer);
  if (declared !== undefined) return declaredHitlApprovalFlag(declared, staged);
  return staged.approved !== false;
}

/** The reason a mid-run Continue shows while the gate's screen is loading. */
export const SCREEN_LOADING_HOLD_REASON = "This step's screen is still loading.";
/** The reason a mid-run Continue shows when the gate's screen failed to load. */
export const SCREEN_FAILED_HOLD_REASON =
  "This step's screen could not be loaded. Reload the page to try again.";
/** The reason a mid-run Continue shows when the step's screen changed since it opened. */
export const SCREEN_CHANGED_HOLD_REASON =
  "This step's screen was changed after the step opened, so it cannot be answered. Stop the run to end it.";

/**
 * Why the mid-run Continue of the gate drawn by `xRenderer` is held because
 * its renderer binding is missing (cinatra#3470), or null. A gate with no
 * binding registered under its exact id is held while the host's bindings
 * are still loading, after they failed to load, when the source named a
 * declared screen for it that did not register, and until a fresh read of
 * the source answered for it (`awaitsFreshRendererBindingRead`), and after a
 * source that could not read every installed agent answered without it. It
 * FAILS CLOSED: the fallback such a gate draws can only approve, so a press
 * would resume a declared screen without its decision and its fields.
 *
 * A REFUSED SCREEN HOLDS FIRST: an id the source names as refused is held even
 * when a binding is registered under it, so a binding an earlier read
 * registered never outlives the source's refusal. A source that FAILED holds
 * the same way over a binding an installed agent's read registered, before it
 * is read as healthy.
 *
 * THE STEP IS DRAWN ONLY UNDER ITS OWN DECLARATION. A host that names the
 * parked `step` holds it while the source's answer pins another declaration
 * for its id than the step opened under (`DECLARED_SCREEN_PIN_KEY`): first as
 * loading, until a fresh read made for that step answered, then as changed.
 * A step that opened under a declared screen is held until an answer with
 * pins has loaded, even over a binding registered under its id.
 */
export function rendererBindingHoldReason(
  xRenderer: string,
  bindings: RendererBindingsLoad,
  step?: RendererStep,
): string | null {
  if (xRenderer === "") return null;
  if (bindings.refusedIds?.has(xRenderer)) return SCREEN_FAILED_HOLD_REASON;
  // A step that waits for its fresh read is still loading, or could not be
  // loaded once that read failed (it is retried only a bounded number of
  // times, or by a reload).
  const awaitedReadHold = () =>
    bindings.failedFreshReads?.has(freshReadKey(xRenderer, step?.key)) === true
      ? SCREEN_FAILED_HOLD_REASON
      : SCREEN_LOADING_HOLD_REASON;
  if (step !== undefined && stepScreenPinHolds(xRenderer, bindings, step)) {
    if (bindings.status === "loading") return SCREEN_LOADING_HOLD_REASON;
    if (answeredScreenPin(xRenderer, bindings) === null) return SCREEN_FAILED_HOLD_REASON;
    return awaitsFreshRendererBindingRead(xRenderer, bindings, step)
      ? awaitedReadHold()
      : SCREEN_CHANGED_HOLD_REASON;
  }
  // A FAILED SOURCE HOLDS BEFORE AN INSTALLED AGENT'S BINDING IS READ AS
  // HEALTHY: what a runtime read registered under the id may be another
  // surface's revision of it. The host's own bindings are its build's.
  if (bindings.status === "failed" && isRendererBoundByRuntimeRead(xRenderer)) {
    return SCREEN_FAILED_HOLD_REASON;
  }
  if (isRendererBound(xRenderer)) return null;
  if (bindings.status === "loading") return SCREEN_LOADING_HOLD_REASON;
  if (bindings.status === "failed" || bindings.announcedIds.has(xRenderer)) {
    return SCREEN_FAILED_HOLD_REASON;
  }
  // Loaded, and not announced: only a fresh read says it declares nothing.
  // Until one answered for it, the answer may be a scan cached before its
  // agent was installed, and the gate is held as still loading.
  if (awaitsFreshRendererBindingRead(xRenderer, bindings, step)) return awaitedReadHold();
  // An answer that could not read every installed agent is no proof that
  // this gate declares nothing.
  if (bindings.incomplete === true) return SCREEN_FAILED_HOLD_REASON;
  return null;
}

/**
 * Is the parked `step` held because the bindings cannot show the declaration
 * it opened under (cinatra#3470)? When their answer pins another declaration
 * for its id, and, for a step that opened under a declared screen, while no
 * answer with pins has loaded. A host draws no renderer for such a step: what
 * is registered under its id is not the screen it asked with.
 */
export function stepScreenPinHolds(
  xRenderer: string,
  bindings: RendererBindingsLoad,
  step: RendererStep,
): boolean {
  if (xRenderer === "") return false;
  const answered = bindings.status === "loaded" ? answeredScreenPin(xRenderer, bindings) : null;
  if (answered !== null) {
    // A step whose declaration could not be read when it opened waits for a
    // read made for it (`awaitsFreshRendererBindingRead`), then takes it.
    if (step.pin === DECLARED_SCREEN_PIN_UNVERIFIED) {
      return awaitsFreshRendererBindingRead(xRenderer, bindings, step);
    }
    return !stepPinAdmits(step.pin, answered);
  }
  return step.pin !== DECLARED_SCREEN_PIN_NONE;
}

/**
 * Is the mid-run Continue held by the gate's renderer (cinatra#3470)? THE ONE
 * READINESS PREDICATE of every host (the run panel, the stepper and the
 * card). It is held while the gate's renderer binding is missing
 * (`rendererBindingHoldReason`). Otherwise only an entry that declares
 * `continueReady` can hold it, and only by answering `false`: a declared card
 * waits for an explicit choice and every required value. Every other entry,
 * and no entry at all, never holds it.
 */
export function continueHeldByRenderer(
  entry: {
    continueReady?: (input: {
      runValue: Record<string, unknown>;
      staged: Record<string, unknown>;
    }) => boolean;
  } | null | undefined,
  runValue: Record<string, unknown> | null | undefined,
  staged: Record<string, unknown>,
  gate: { xRenderer: string; bindings: RendererBindingsLoad; step?: RendererStep },
): boolean {
  if (rendererBindingHoldReason(gate.xRenderer, gate.bindings, gate.step) !== null) return true;
  if (typeof entry?.continueReady !== "function") return false;
  return entry.continueReady({ runValue: runValue ?? {}, staged }) === false;
}

/**
 * The buffer a mid-run host holds after its renderer staged `next`
 * (cinatra#3470). An entry that declares `stagesWholeAnswer` stages its whole
 * answer every time, so the buffer becomes exactly that answer; every other
 * entry, and no entry at all, merges into the buffer as before.
 */
export function stageRendererAnswer(
  entry: { stagesWholeAnswer?: boolean } | null | undefined,
  buffered: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return entry?.stagesWholeAnswer === true ? { ...next } : { ...buffered, ...next };
}

/**
 * The buffer a mid-run host holds after the assistant FILLED the screen
 * (cinatra#3470, cinatra#2934). A declared card's fill goes through the one
 * writer of its answer (`declaredHitlStage`), so the buffer is the whole
 * staged answer with its `userResponse`; every other entry merges the fill
 * into the buffer as before.
 */
export function stageAssistantFill(
  entry: { declaredScreen?: DeclaredHitlCard } | null | undefined,
  runValue: Record<string, unknown> | null | undefined,
  buffered: Record<string, unknown>,
  fill: Record<string, unknown>,
): Record<string, unknown> {
  if (entry?.declaredScreen !== undefined) {
    return declaredHitlStage(entry.declaredScreen, runValue ?? {}, buffered, fill);
  }
  return { ...buffered, ...fill };
}

/**
 * The buffer after EVERY fill one assistant turn placed, applied in the order
 * they were placed (cinatra#3470). A declared card replays them through its
 * one writer exactly as the server does (`declaredHitlReplayFills`), so a
 * later decision replaces an earlier one and the screen shows what a press
 * by asking would send; every other entry merges them in order, later fills
 * winning, as before.
 */
export function stageAssistantFills(
  entry: { declaredScreen?: DeclaredHitlCard } | null | undefined,
  runValue: Record<string, unknown> | null | undefined,
  buffered: Record<string, unknown>,
  fills: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  if (entry?.declaredScreen !== undefined) {
    return declaredHitlReplayFills(entry.declaredScreen, runValue ?? {}, buffered, fills);
  }
  return fills.reduce<Record<string, unknown>>((staged, fill) => ({ ...staged, ...fill }), buffered);
}

// ---------------------------------------------------------------------------
// A DECLARED HITL CARD'S ANSWER (cinatra#3470): ONE WRITER FOR EVERY ROAD
// ---------------------------------------------------------------------------
//
// Every road that writes a declared card's staged answer goes through
// `declaredHitlStage`: the card's own typing and clicking, the assistant's fill
// on the run panel, the stepper and the chat composer's submit, and the
// server's bound-screen fill and lent-action submit. It builds the WHOLE
// answer, `userResponse` included, from the run values, the answer staged so
// far and the change, so no road can leave `userResponse` missing or stale, or
// send the raw gate values. Pure, and here rather than in a module of its own:
// a new module would add a first-party module to every locked route of the
// route-graph ratchet, and the server reads it from this pure module.

export type DeclaredHitlSection =
  | { type: "note"; text: string }
  | { type: "fact"; label: string; key: string; qualifierKey?: string }
  | { type: "words"; key: string; label?: string }
  | { type: "quote"; key: string }
  | { type: "field"; key: string; label: string; multiline?: boolean; placeholder?: string };

export type DeclaredHitlCard = {
  layout: "card";
  title: string;
  sections?: DeclaredHitlSection[];
  /** The decision's declared label, drawn above its answer rows. */
  decisionLabel?: string;
  decisions?: { label: string; answer: Record<string, unknown> }[];
  carry?: string[];
  requires?: string[];
};

/** The value's OWN text under `key`; anything else reads as blank. */
function declaredOwnText(v: Record<string, unknown>, key: string): string {
  const x = Object.hasOwn(v, key) ? v[key] : undefined;
  return typeof x === "string" ? x : "";
}

/** The value's OWN value under `key`, or undefined. */
function declaredOwnValue(v: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(v, key) ? v[key] : undefined;
}

/** The card's field keys, in declaration order. */
export function declaredHitlFieldKeys(screen: Pick<DeclaredHitlCard, "sections">): string[] {
  return (screen.sections ?? []).flatMap((s) => (s.type === "field" ? [s.key] : []));
}

/**
 * The text a field shows: the staged text once the field is staged, the run
 * value's (a prefill) while it is not.
 */
export function declaredHitlFieldText(
  runValue: Record<string, unknown>,
  staged: Record<string, unknown>,
  key: string,
): string {
  return Object.hasOwn(staged, key) ? declaredOwnText(staged, key) : declaredOwnText(runValue, key);
}

/**
 * The chosen row: the index of the decision whose answer is EXACTLY the
 * answer's own keys (every key except the carried ones and `userResponse`),
 * or null. The run value never chooses for the person.
 */
export function declaredHitlChosenDecision(
  screen: Pick<DeclaredHitlCard, "decisions" | "carry">,
  staged: Record<string, unknown>,
): number | null {
  const carried = new Set(screen.carry ?? []);
  const own = Object.keys(staged).filter((k) => k !== "userResponse" && !carried.has(k));
  const i = (screen.decisions ?? []).findIndex((d) => {
    const keys = Object.keys(d.answer);
    return (
      keys.length === own.length &&
      keys.every((k) => Object.hasOwn(staged, k) && Object.is(staged[k], d.answer[k]))
    );
  });
  return i === -1 ? null : i;
}

/**
 * The approval flag of a declared card's answer: `false` when the operator
 * CHOSE a decision whose declared answer sets `approved` to anything but the
 * boolean `true` (the schema admits only booleans; any other value never
 * reads as an approval). A field card, a card with no controls, a card with
 * nothing chosen and a chosen decision that sets no `approved` continue as an
 * approval; no carried run value and no other staged key decides.
 */
export function declaredHitlApprovalFlag(
  screen: Pick<DeclaredHitlCard, "decisions" | "carry">,
  staged: Record<string, unknown>,
): boolean {
  const picked = declaredHitlChosenDecision(screen, staged);
  if (picked === null) return true;
  const answer = (screen.decisions ?? [])[picked]!.answer;
  return !Object.hasOwn(answer, "approved") || answer.approved === true;
}

/** Every `requires` key that is not a field holds non-blank run-value text. */
export function declaredHitlRequiredRunValuesHeld(
  screen: DeclaredHitlCard,
  runValue: Record<string, unknown>,
): boolean {
  const fieldKeys = new Set(declaredHitlFieldKeys(screen));
  return (screen.requires ?? []).every((k) => fieldKeys.has(k) || declaredOwnText(runValue, k).trim() !== "");
}

/**
 * May the Continue send this card's answer yet? It reads what the Continue
 * SENDS (the staged answer), never only what is drawn: every `requires` run
 * value holds text, every field holds non-blank STAGED text, a card with
 * decisions has one chosen, and a card with no controls has its whole answer
 * (its carried values and `userResponse`) staged. Nothing is chosen for the
 * person.
 */
export function declaredHitlScreenReady(
  screen: DeclaredHitlCard,
  runValue: Record<string, unknown>,
  staged: Record<string, unknown>,
): boolean {
  if (!declaredHitlRequiredRunValuesHeld(screen, runValue)) return false;
  const fields = declaredHitlFieldKeys(screen);
  for (const k of fields) {
    if (declaredOwnText(staged, k).trim() === "") return false;
  }
  if ((screen.decisions ?? []).length === 0) {
    return fields.length > 0 || typeof declaredOwnValue(staged, "userResponse") === "string";
  }
  return declaredHitlChosenDecision(screen, staged) !== null;
}

/**
 * The whole answer: the carried run values (own keys only, from the gate's
 * ORIGINAL run values), then `answer`, and `userResponse`, the JSON of exactly
 * those keys. The server resumes the agent with `userResponse` and records the
 * parsed JSON, so what the agent reads and what is recorded are one answer.
 */
export function declaredHitlStagedAnswer(
  screen: Pick<DeclaredHitlCard, "carry">,
  runValue: Record<string, unknown>,
  answer: Record<string, unknown>,
): Record<string, unknown> {
  const whole: Record<string, unknown> = {
    ...Object.fromEntries(
      (screen.carry ?? []).filter((k) => Object.hasOwn(runValue, k)).map((k) => [k, runValue[k]]),
    ),
    ...answer,
  };
  return { ...whole, userResponse: JSON.stringify(whole) };
}

/**
 * THE ONE WRITER of a declared card's staged answer. `change` is what one
 * road wrote: a field's text, a declared answer, or an assistant's fill.
 *
 *   - a card with fields stages every field: the change's text where it
 *     names the field, the text the field shows otherwise;
 *   - a card with decisions stages the declared answer the change names
 *     exactly, or keeps the one already chosen; with none chosen it stages
 *     nothing;
 *   - a card with neither stages its carried values alone.
 *
 * The result is always the WHOLE answer (`declaredHitlStagedAnswer`), so a
 * host replaces its buffer with it.
 */
export function declaredHitlStage(
  screen: DeclaredHitlCard,
  runValue: Record<string, unknown>,
  staged: Record<string, unknown>,
  change: Record<string, unknown>,
): Record<string, unknown> {
  const fields = declaredHitlFieldKeys(screen);
  if (fields.length > 0) {
    const answer = Object.fromEntries(
      fields.map((k) => [
        k,
        Object.hasOwn(change, k) && typeof change[k] === "string"
          ? change[k]
          : declaredHitlFieldText(runValue, staged, k),
      ]),
    );
    return declaredHitlStagedAnswer(screen, runValue, answer);
  }
  const decisions = screen.decisions ?? [];
  if (decisions.length === 0) return declaredHitlStagedAnswer(screen, runValue, {});
  const picked = declaredHitlChosenDecision(screen, change) ?? declaredHitlChosenDecision(screen, staged);
  if (picked === null) return {};
  return declaredHitlStagedAnswer(screen, runValue, { ...decisions[picked]!.answer });
}

/**
 * THE ONE REPLAY of a turn's fills on a declared card: each fill, oldest
 * first, through the card's one writer over the answer staged so far. The
 * server replays a message's fills with it (the bound-screen fill and the
 * lent-action press, from the card's prefill), and the browser applies a
 * turn's fills with it (`stageAssistantFills`, over its buffer), so both read
 * a later decision as replacing the earlier one.
 */
export function declaredHitlReplayFills(
  screen: DeclaredHitlCard,
  runValue: Record<string, unknown>,
  staged: Record<string, unknown>,
  fills: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return fills.reduce<Record<string, unknown>>(
    (current, fill) => declaredHitlStage(screen, runValue, current, fill),
    staged,
  );
}

/**
 * The controls a declared card offers a fill: its field keys, or the keys of
 * its declared answers. Read from the DECLARATION, never from the gate's
 * input schema.
 */
export function declaredHitlControls(screen: DeclaredHitlCard): string[] {
  const fields = declaredHitlFieldKeys(screen);
  if (fields.length > 0) return fields;
  const keys: string[] = [];
  for (const d of screen.decisions ?? []) {
    for (const k of Object.keys(d.answer)) if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * The bound screen's form schema of a declared card: one text property per
 * field, or one property per declared answer key with the declared values.
 */
export function declaredHitlFormSchema(screen: DeclaredHitlCard): Record<string, unknown> {
  const fields = declaredHitlFieldKeys(screen);
  const properties: Record<string, unknown> = {};
  if (fields.length > 0) {
    for (const k of fields) properties[k] = { type: "string" };
  } else {
    for (const k of declaredHitlControls(screen)) {
      const values: unknown[] = [];
      for (const d of screen.decisions ?? []) {
        if (Object.hasOwn(d.answer, k) && !values.some((v) => Object.is(v, d.answer[k]))) values.push(d.answer[k]);
      }
      properties[k] = { enum: values };
    }
  }
  return { type: "object", properties };
}

/**
 * What an assistant's fill means for a declared card: `change` is what the
 * card can hold (field texts, or exactly one declared answer); `notFields`
 * names keys the card offers no control for; `unusable` names controls the
 * fill gave a value the card cannot hold.
 */
export function declaredHitlFillChange(
  screen: DeclaredHitlCard,
  requested: Record<string, unknown>,
): { change: Record<string, unknown>; notFields: string[]; unusable: string[] } {
  const controls = declaredHitlControls(screen);
  const fields = declaredHitlFieldKeys(screen);
  const notFields = Object.keys(requested).filter((k) => !controls.includes(k));
  if (fields.length > 0) {
    const change: Record<string, unknown> = {};
    const unusable: string[] = [];
    for (const k of fields) {
      if (!Object.hasOwn(requested, k) || requested[k] === undefined) continue;
      const v = requested[k];
      if (typeof v === "string") change[k] = v;
      else if (v === null) change[k] = "";
      else unusable.push(k);
    }
    return { change, notFields, unusable };
  }
  const picked = declaredHitlChosenDecision(screen, requested);
  if (picked !== null) {
    return { change: { ...(screen.decisions ?? [])[picked]!.answer }, notFields: [], unusable: [] };
  }
  return {
    change: {},
    notFields,
    unusable: Object.keys(requested).filter((k) => controls.includes(k)),
  };
}

/**
 * The declared card's rows in words, for the turn that names a bound screen
 * to the assistant: each field and the text it shows, or the decision with
 * each declared answer to fill exactly.
 */
export function describeDeclaredHitlRows(
  screen: DeclaredHitlCard,
  runValue: Record<string, unknown>,
  maxEcho = 120,
): string[] {
  const fields = declaredHitlFieldKeys(screen);
  if (fields.length > 0) {
    return fields.map((k) => {
      const text = declaredHitlFieldText(runValue, {}, k);
      const shown = text.length > maxEcho ? `${text.slice(0, maxEcho)}…` : text;
      return `${k} (text; now ${JSON.stringify(shown)})`;
    });
  }
  const answers = (screen.decisions ?? [])
    .map((d) => `${JSON.stringify(d.answer)} (${JSON.stringify(d.label)})`)
    .join(" or ");
  return answers ? [`one decision, filled with exactly one of ${answers}`] : [];
}

/**
 * What the Continue sends for a declared card: the staged whole answer, its
 * approval flag (the chosen decision's, `declaredHitlApprovalFlag`), the
 * time, and the attachment envelope over its `userResponse`. Never the raw
 * gate values.
 */
export function declaredHitlContinuePayload(
  screen: DeclaredHitlCard,
  staged: Record<string, unknown>,
  attachments: ReadonlyArray<LlmAttachmentRef>,
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    ...applyAttachmentEnvelopeUserResponseOnly(
      { ...staged, approved: declaredHitlApprovalFlag(screen, staged), approvedAt: now },
      attachments,
    ),
    [DECLARED_CARD_ANSWER_KEY]: true,
  };
}

/**
 * THE MARK OF AN ANSWER MADE ON A DECLARED CARD (cinatra#3470). Every host
 * sets it on the Continue of a gate drawn by a declared card. The server
 * sends such an answer only to a step whose declaration is a card, and drops
 * the mark before the answer goes on: a card an earlier read registered in
 * the browser, for a step that declares none, never answers that step.
 */
export const DECLARED_CARD_ANSWER_KEY = "x-declared-card-answer";

/** `payload` with the declared-card mark when a declared card draws `xRenderer`. */
export function markDeclaredCardAnswer(
  xRenderer: string | null | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof xRenderer !== "string" || declaredHitlCardOf(xRenderer) === undefined) return payload;
  return { ...payload, [DECLARED_CARD_ANSWER_KEY]: true };
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
  if (!rendererReadsAsKind(xRenderer, "context-selector", ":context-selector")) return payload;
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
 * THE RUN PANEL'S MID-RUN LIST STEP (cinatra#3562): a list-step gate (the
 * binding's declared kind, `isListPickerRenderer`) that is not a setup gate. The run panel draws it as a mid-run gate (its picks
 * buffer for the outer Continue) and lifts its picks into the approval note;
 * the same reading decides both, so they cannot disagree. On a setup gate the
 * list step stays on the setup road, where its answer is sent under the gate's
 * field name.
 */
export function isMidRunListStepGate(xRenderer: string, reviewTaskId: string): boolean {
  return isListPickerRenderer(xRenderer) && !isSetupGateTaskId(reviewTaskId);
}

/** A list id that names a pick: a string that is not blank (whitespace only). */
function isUsableListId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0;
}

/**
 * Whether a list step's buffer holds a pick (cinatra#3562): a usable id in
 * `listIds`, or a usable `listId`. A buffer without one would resume the run
 * with an empty snapshot (`listId: ""`), so the run panel's Continue sends
 * nothing for it.
 */
export function hasUsableListPick(buffered: Record<string, unknown> | null | undefined): boolean {
  if (!buffered) return false;
  const { listIds, listId } = buffered as { listIds?: unknown; listId?: unknown };
  return (Array.isArray(listIds) && listIds.some(isUsableListId)) || isUsableListId(listId);
}

/**
 * Lift renderer-buffered values into a structured `approvalNote` snapshot
 * for the gates whose downstream continuation re-reads exactly what was
 * approved. Returns `{ approvalNote }` to merge into the resume payload,
 * or `null` when the renderer has no lift. The client-side fields are
 * advisory, not trusted. The cinatra server does not re-resolve them:
 * `approveReviewTaskInternal` (review-task-actions.ts) forwards the note as
 * the resume text. Resolving each id (e.g. via crm_list_get) is left to the
 * later workflow step that reads the note.
 *
 * `now` is injectable for tests; defaults to the current time.
 */
export function liftRendererApprovalNote(
  xRenderer: string,
  buffered: Record<string, unknown>,
  now: string = new Date().toISOString(),
): { approvalNote: string } | null {
  if (isListPickerRenderer(xRenderer)) {
    // SEVERAL PICKS (cinatra#3562): a list step declared to take several picks
    // buffers `listIds` (and `listNames`, in the same order). The snapshot then
    // carries every ticked id in the order ticked, each once, with its name.
    // An id that is not a string, or is blank (whitespace only), is no pick.
    // A name is advisory: resolving each id is the later workflow step's job.
    const ticked = (buffered as { listIds?: unknown }).listIds;
    if (Array.isArray(ticked)) {
      const names = (buffered as { listNames?: unknown }).listNames;
      const listIds: string[] = [];
      const listNames: string[] = [];
      ticked.forEach((id, index) => {
        if (!isUsableListId(id) || listIds.includes(id)) return;
        listIds.push(id);
        const name = Array.isArray(names) ? names[index] : undefined;
        listNames.push(typeof name === "string" ? name : "");
      });
      if (listIds.length > 0) {
        return {
          approvalNote: JSON.stringify({
            type: "list" as const,
            listIds,
            listNames,
            snapshotAt: now,
          }),
        };
      }
    }
    // Snapshot the selected list at approval time so downstream stages can
    // reference it; resolving it is the later workflow step's job.
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
  if (rendererReadsAsKind(xRenderer, "wayflow-setup-form", ":setup-form")) {
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
  if (rendererReadsAsKind(xRenderer, "scrape-schema-review", ":scrape-schema-review")) {
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
  if (rendererReadsAsKind(xRenderer, "final-list-review", ":final-list-review")) {
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

/**
 * Merge a renderer's lifted `approvalNote` into the resume payload
 * (cinatra#3562). For a list step, the note is what the run receives.
 * `approveReviewTaskInternal` (review-task-actions.ts) sends a nonblank
 * `userResponse` as the resume text before it reads `approvalNote`. A
 * `userResponse` in the buffer of a list step would therefore replace the
 * snapshot of the picks, and the run would never receive the picked lists. So
 * a lifted list-step note removes `userResponse` from the payload. The
 * attachment envelope applied after this reads the note
 * (`applyAttachmentEnvelope`, pickLegacyResumeText). Every other lift is
 * merged as before. With no lift, the payload is returned unchanged.
 */
export function applyRendererApprovalNote(
  xRenderer: string,
  payload: Record<string, unknown>,
  lift: { approvalNote: string } | null,
): Record<string, unknown> {
  if (!lift) return payload;
  const merged: Record<string, unknown> = { ...payload, ...lift };
  if (!isListPickerRenderer(xRenderer)) return merged;
  delete merged.userResponse;
  return merged;
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
 * distinct until that alignment is decided deliberately. The one exception
 * is the run panel's list step (cinatra#3562): its lifted note is the resume
 * text, so its Continue wraps with `applyAttachmentEnvelope`.
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
// The renderer's own reading of its value (cinatra#3562)
// ---------------------------------------------------------------------------

/**
 * Where a run surface keeps what its field renderers reported through
 * `onValidityChange`. Each drawn renderer reports under an owner of its own and
 * keeps one report, its latest, made on the gate it is drawn for. While any
 * report on the gate on screen is anything but `true`, the Continue drawn for
 * that gate is unavailable and a press sends nothing.
 *
 * Only the report of an attached owner counts. Each surface attaches the owner
 * while its renderer is on the screen and releases it when the renderer leaves
 * or another renderer takes its place. The release drops that owner's report
 * and no other, so a renderer that never reports blocks nothing (cinatra#3532)
 * even where an earlier one reported `false`. A report made while the owner is
 * not attached, before the attach or after the release, holds nothing; the
 * owner keeps it, and it counts when the same owner is attached again (as
 * StrictMode and a hidden subtree that is shown again do). A surface attaches a
 * new owner for each renderer, so a report that arrives after its renderer has
 * left the screen never holds a gate again.
 */
export type GateValidityStore = {
  /** The renderer drawn under `owner` is on the screen: its report counts from now on. */
  attach: (owner: object) => void;
  /** The renderer drawn under `owner`, on gate `key` (`hitlGateIdentityKey`), reports whether its value may be sent. */
  report: (owner: object, key: string, valid: boolean) => void;
  /** The renderer drawn under `owner` has left the screen: its report goes, and no other. */
  release: (owner: object) => void;
  /** True while any report of an attached owner on `key` is anything but `true`. */
  isHeld: (key: string | null) => boolean;
  subscribe: (listener: () => void) => () => void;
};

type GateValidityReport = { key: string; valid: boolean };

export function createGateValidityStore(): GateValidityStore {
  /** The reports of the attached owners: only these hold a gate. */
  const reports = new Map<object, GateValidityReport>();
  const attached = new WeakSet<object>();
  /** The latest report of an owner that is not attached; it holds nothing. */
  const kept = new WeakMap<object, GateValidityReport>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    attach: (owner) => {
      if (attached.has(owner)) return;
      attached.add(owner);
      const last = kept.get(owner);
      if (last === undefined) return;
      kept.delete(owner);
      reports.set(owner, last);
      changed();
    },
    report: (owner, key, valid) => {
      const next = { key, valid: valid === true };
      if (!attached.has(owner)) {
        kept.set(owner, next);
        return;
      }
      const last = reports.get(owner);
      if (last !== undefined && last.key === next.key && last.valid === next.valid) return;
      reports.set(owner, next);
      changed();
    },
    release: (owner) => {
      if (!attached.has(owner)) return;
      attached.delete(owner);
      const last = reports.get(owner);
      if (last === undefined) return;
      reports.delete(owner);
      kept.set(owner, last);
      changed();
    },
    isHeld: (key) =>
      key !== null && [...reports.values()].some((r) => r.key === key && !r.valid),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The renderer value a mid-run gate's Continue waits for (cinatra#3380)
// ---------------------------------------------------------------------------
//
// Kept in this module, not a module of its own: the run panel, the stepper and
// the conversation card already import this one, so a route that reaches them
// reaches no new module (the route-graph ratchet, scripts/audit/route-graph-ratchet.mjs).

/**
 * DOES A MID-RUN GATE'S CONTINUE STILL WAIT FOR ITS RENDERER? (cinatra#3380.)
 *
 * A mid-run gate's field renderer writes its answer into the surface's buffer
 * through `onChange`, and the surface's own Continue sends that buffer. A
 * renderer that offers a choice (a list the person picks one row of) writes
 * nothing until the person picks, and nothing is picked for them. A Continue
 * that is available before the pick resumes the run with no answer at all.
 *
 * THE DECLARATION IS THE GATE'S, IN THE SCHEMA'S OWN `x-` NAMESPACE. A gate
 * property whose schema carries `"x-required": true` is a value the gate's
 * renderer must produce before the Continue may send. This is the same hint the
 * setup road already writes on a required field's own schema and the schema
 * field renderer already reads (cinatra#3582); here it is read on the
 * properties of a mid-run gate's schema. Both input-schema roads copy `x-` keys
 * verbatim, so a pack declares it in its step's `inputMessageSchema` and no
 * other place has to change.
 *
 * The object-level `required` list is NOT read. Three mid-run gates of the
 * email packs declare `required: ["decision"]`, and no renderer of theirs writes
 * `decision` (the drafts and recipients reviews write `userResponse`, the send
 * confirmation writes `campaignId`). The Continue's payload carries `approved`
 * and `approvedAt` beside what the renderer wrote, so a rule over that list
 * would hold those gates with a Continue that never comes back.
 *
 * The same reading of "nothing" as the setup road (`isBlankSubValue` in
 * schema-field-renderer.tsx, `isBlankSetupValue` in review-task-actions.ts):
 * absent, null, a string that trims to empty, or an empty list. `0` and `false`
 * are answers. A property that declares a `default` is answered by that default
 * (cinatra#3452) and holds nothing.
 *
 * Only the answer counts — for the Continue the buffer the renderer wrote, for
 * the published submit that buffer with the caller's own value over it, read
 * before the host adds approved, approvedAt and userResponse — never the
 * gate's own current values: those are what the run handed the screen, not an
 * answer the person gave on it. What released the Continue is also what is
 * sent: `withDeclaredRendererValues` puts each declared key of that answer back
 * over the host's fields.
 *
 * Generic by construction: it reads a schema and a buffer, never a renderer id
 * or an agent name. A gate that declares nothing is held by nothing.
 *
 * A gate that carries a PRESENTATION HINT (`currentValues.presentation`, an
 * object with a string `type`) is out of the rule on the run panel, the card and
 * the published submit (the stepper draws no presentation-hint branch): such a gate
 * is drawn through the generic dispatch renderer, which writes nothing into the
 * buffer, so a hold would never be released. `gateCarriesPresentationHint` is
 * that reading; the run panel and the card apply identical inline copies of it
 * to choose that branch.
 */

function isBlankRendererValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The property keys a gate's schema declares its renderer must produce. */
export function gateRequiredRendererKeys(
  schema: Record<string, unknown> | null | undefined,
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  const keys: string[] = [];
  for (const [key, declared] of Object.entries(properties as Record<string, unknown>)) {
    if (!declared || typeof declared !== "object" || Array.isArray(declared)) continue;
    const property = declared as Record<string, unknown>;
    if (property["x-required"] !== true) continue;
    if (Object.prototype.hasOwnProperty.call(property, "default")) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * `true` while the gate declares a value its renderer must produce and the
 * renderer has not yet written one into `buffered`.
 */
export function gateAwaitsRendererValue(
  schema: Record<string, unknown> | null | undefined,
  buffered: Record<string, unknown> | null | undefined,
): boolean {
  const keys = gateRequiredRendererKeys(schema);
  if (keys.length === 0) return false;
  const written = buffered ?? {};
  return keys.some((key) =>
    isBlankRendererValue(
      Object.prototype.hasOwnProperty.call(written, key) ? written[key] : undefined,
    ),
  );
}

/**
 * The raw-schema hold of a host's mid-run Continue (cinatra#3380), for the
 * entry that draws the gate. A DECLARED CARD HAS ONE READINESS PREDICATE
 * (cinatra#3470): its own (`continueHeldByRenderer`, which reads
 * `declaredHitlScreenReady`). The card stages its declared answer, never the
 * gate schema's `x-required` keys, so that hold never applies to it: it would
 * keep the Continue unavailable after the card's answer is ready. Every other
 * entry, and no entry at all, is held by `gateAwaitsRendererValue` as before.
 */
export function continueAwaitsRawRendererValue(
  entry: { declaredScreen?: unknown } | null | undefined,
  schema: Record<string, unknown> | null | undefined,
  buffered: Record<string, unknown> | null | undefined,
): boolean {
  if (entry?.declaredScreen !== undefined) return false;
  return gateAwaitsRendererValue(schema, buffered);
}

/**
 * THE RENDERER'S OWN VALUE OF A DECLARED KEY IS SENT AS IT WROTE IT
 * (cinatra#3380). Each surface builds its payload with host fields beside the
 * renderer's buffer: `approved` and `approvedAt`, and on the published submit a
 * `userResponse` of its own. A gate may declare one of those names as a value
 * its renderer must produce, and then the renderer's write is what released the
 * Continue. So each declared key that `written` holds with a value that is not
 * blank is put back over the built payload, after every host field. A declared
 * key that `written` does not hold keeps what the host built. A gate that
 * declares nothing gets the same payload object back.
 */
export function withDeclaredRendererValues(
  schema: Record<string, unknown> | null | undefined,
  written: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const keys = gateRequiredRendererKeys(schema);
  if (keys.length === 0 || !written) return payload;
  let sent = payload;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(written, key)) continue;
    const value = written[key];
    if (isBlankRendererValue(value)) continue;
    if (sent === payload) sent = { ...payload };
    sent[key] = value;
  }
  return sent;
}

/**
 * THE LAST STEP OF EVERY MID-RUN CONTINUE'S PAYLOAD (cinatra#3470): the run
 * panel, the stepper and the HITL screen card each build their payload, then
 * finish it here. First each key the gate declares and the renderer wrote is
 * put back as written (`withDeclaredRendererValues`; pass no schema to skip
 * it), and only then are the waiting files wrapped around the resume text. The
 * wrap comes LAST, so a declared answer the renderer staged in `userResponse`
 * is the text the files go with, and never replaces the envelope that carries
 * them. `wrapAttachments` is the surface's own wrap (`applyAttachmentEnvelope`
 * or `applyAttachmentEnvelopeUserResponseOnly`), passed in so this pure module
 * imports nothing more; a setup gate passes no attachments.
 */
export function finishContinuePayload(
  payload: Record<string, unknown>,
  finish: {
    declaredSchema: Record<string, unknown> | null | undefined;
    written: Record<string, unknown> | null | undefined;
    attachments: ReadonlyArray<LlmAttachmentRef>;
    wrapAttachments: (
      payload: Record<string, unknown>,
      attachments: ReadonlyArray<LlmAttachmentRef>,
    ) => Record<string, unknown>;
    /** The renderer id the gate is drawn by: a declared card's answer is marked (`markDeclaredCardAnswer`). */
    xRenderer: string | null;
  },
): Record<string, unknown> {
  const declared = withDeclaredRendererValues(finish.declaredSchema, finish.written, payload);
  const wrapped =
    finish.attachments.length === 0 ? declared : finish.wrapAttachments(declared, finish.attachments);
  return markDeclaredCardAnswer(finish.xRenderer, wrapped);
}

/**
 * `true` when a gate's current values carry a presentation hint: an object
 * `presentation` with a string `type`. Such a gate is out of the rule above.
 */
export function gateCarriesPresentationHint(currentValues: unknown): boolean {
  if (!currentValues || typeof currentValues !== "object") return false;
  const candidate = (currentValues as { presentation?: unknown }).presentation;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    typeof (candidate as { type?: unknown }).type === "string"
  );
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
 *    no field to write it into), or whose `required` list names anything that
 *    is not a declared property (a nested object's `required` must name a
 *    visible declared property). It is refused: it is neither a bare
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
    // A nested required name must name a VISIBLE declared property: the drawn
    // object checks it on the press, and a name no field can write would hold
    // the gate forever (cinatra#4244).
    for (const name of (required as string[] | undefined) ?? []) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) return false;
      if ((properties[name] as Record<string, unknown>)["x-hidden"] === true) return false;
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
  for (const name of (required as string[] | undefined) ?? []) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) return { kind: "malformed" };
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
 *    convention the idea-selection renderer follows for its one output), JSON-
 *    looking or not, and `userResponseFieldName` names the field so the
 *    server records the answer under it (`readWayflowSubmittedValues`). Any
 *    other answer - a list, a number, a boolean, an object, or several
 *    fields - is sent as one JSON object of the declared fields that were
 *    answered (a blank text or an empty list is not an answer), the
 *    structured round-trip the server parses back into the submitted values.
 *  - A number that is not finite cannot travel as JSON (it would reach the
 *    flow as `null`): the payload is refused with `NonFiniteAnswerError`.
 *  - No declared field answered: no resume text, so the flow receives the
 *    approval marker, as the Continue-only card sent for this gate.
 *  - A `userResponse` the answer already carries is kept as it is.
 *  - A schema that is not read as `fields` adds no resume text.
 */
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
    if (declared?.type === "string" && typeof value === "string") {
      payload.userResponse = value;
      payload.userResponseFieldName = only;
      return payload;
    }
  }
  payload.userResponse = JSON.stringify(answered);
  return payload;
}

// ---------------------------------------------------------------------------
// The values the WayFlow continue road records (cinatra#4244)
// ---------------------------------------------------------------------------

/**
 * What the WayFlow continue road records as the submitted values of a gate
 * answer (cinatra#4244). The resume text itself (`userResponse`) goes to the
 * flow verbatim; this reading only decides what is recorded beside it.
 *
 *  1. A NAMED SINGLE TEXT ANSWER. A schema-drawn gate that asks for one text
 *     field sends that text verbatim as `userResponse` and names its field in
 *     `userResponseFieldName`. When the values carry that field as an own key
 *     whose value IS the resume text, the answer is recorded under that field
 *     alone - even when the text reads as JSON (`42`, `{"tone":"warm"}`), which
 *     the reading below would otherwise take for the submitted values. A name
 *     whose value is not the resume text is not believed.
 *  2. THE ATTACHMENT ENVELOPE (cinatra#3470). A `userResponse` that is exactly
 *     the `{ text, attachments }` envelope this host sends with at least one
 *     file (`readSentUserEnvelope`) carries the answer in `text`, and the agent
 *     reads that text with the files beside it. When the text is a structured
 *     answer (rule 1, or a JSON object), that answer is recorded, with the
 *     files under `attachments` (unless the answer has a key of that name).
 *     A plain-text answer keeps the envelope as its record, as before. So a
 *     declared card's answer sent with a file is recorded as that answer, never
 *     as the transport envelope. A `{ text }` with no file is never the
 *     host's envelope: it is an answer with a `text` key, recorded as it is.
 *  3. Otherwise, as before: a `userResponse` that parses as a JSON object is the
 *     submitted values; one that is not JSON leaves the values without
 *     `userResponse`; no `userResponse` leaves the values themselves; nothing
 *     left is `null`.
 *
 * It lives here, beside `buildSchemaFieldGatePayload` that names the field, and
 * not in a module of its own: a new module would add a first-party module to
 * every locked route of the route-graph ratchet. The server imports it from
 * this pure module.
 */
export function readWayflowSubmittedValues(values: unknown): Record<string, unknown> | null {
  const valuesObj =
    values !== null && typeof values === "object" && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : null;
  if (!valuesObj) return null;
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(valuesObj, key) ? valuesObj[key] : undefined;
  const userResponseRaw = own("userResponse");
  /** Rule 1: the answer under its named field, or null. */
  const namedAnswer = (text: string): Record<string, unknown> | null => {
    const fieldName = own("userResponseFieldName");
    if (
      typeof fieldName !== "string" ||
      fieldName === "userResponse" ||
      fieldName === "userResponseFieldName" ||
      own(fieldName) !== text
    ) {
      return null;
    }
    const recorded: Record<string, unknown> = {};
    Object.defineProperty(recorded, fieldName, {
      value: text,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return recorded;
  };
  const objectOf = (parsed: unknown): Record<string, unknown> | null =>
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (typeof userResponseRaw === "string" && userResponseRaw.trim().length > 0) {
    const named = namedAnswer(userResponseRaw);
    if (named !== null) return named;
    try {
      const parsed = JSON.parse(userResponseRaw);
      const envelope = readSentUserEnvelope(parsed);
      if (envelope !== null) {
        let inner = namedAnswer(envelope.text);
        if (inner === null) {
          try {
            inner = objectOf(JSON.parse(envelope.text));
          } catch {
            inner = null;
          }
        }
        if (inner !== null) {
          return envelope.attachments.length > 0 && !Object.prototype.hasOwnProperty.call(inner, "attachments")
            ? { ...inner, attachments: envelope.attachments }
            : inner;
        }
      }
      return objectOf(parsed);
    } catch {
      const { userResponse: _u, ...rest } = valuesObj;
      void _u;
      return Object.keys(rest).length > 0 ? rest : null;
    }
  }
  const { userResponse: _u, ...rest } = valuesObj;
  void _u;
  return Object.keys(rest).length > 0 ? rest : null;
}

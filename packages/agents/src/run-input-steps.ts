// ---------------------------------------------------------------------------
// THE RUN'S OWN INPUT STEPS — the projection the step model was missing
// (cinatra#3068).
//
// WHAT WAS MISSING. `buildRunStepperSteps` projects an agent template's
// approval policy into the run's display steps, and only real HITL renderer
// gates appear there. The very FIRST thing a person meets on a run page is not
// one of them: it is the agent's own input form — the blog draft writer's
// "Idea" field with its Continue — which the setup loop in `execution.ts` emits
// over the template's declared input fields, before any policy step exists to
// project. So the run's step model knew nothing about the first step, the rail
// had no entry to draw for it, and the form was served inside a step-less
// "Agentic Run Progress" panel while every later moment of the same run read as
// a step: an entry in the rail, the step's own screen in the detail column.
//
// THIS IS THAT PROJECTION, and it is deliberately a SECOND one rather than a
// widening of `buildRunStepperSteps`. That module is a lockstep contract: the
// live resolver (`execution.ts`), the replay submission map (`run-actions.ts`)
// and the review surface all index the same renderer-gate slots through
// `stepFiresRendererGate`, and adding a step that consumes no gate slot would
// shift every prompt-to-step mapping by one. The input forms consume no slot,
// so they are named beside that list, never inside it.
//
// PURE (no DB, no React, no run row). The walk MIRRORS the setup loop's own
// pending-field walk, because the forms the person is shown are exactly the
// forms that loop emits: a visible required field the run does not yet carry a
// value for, one form at a time — or a single grouped form where the agent
// decorated one of its fields to opt into one. The caller owes it the RESOLVED
// schema — the same one `execution.ts` walks — because a stored schema that is
// empty is not the schema the loop asks from (`input-schema-resolver.ts`).
// ---------------------------------------------------------------------------

import { GROUPED_SETUP_FORM_RENDERER_ID } from "./agent-builder-ids";
import {
  classifyRunWaitInterrupt,
  type RunWaitInterruptDescriptor,
} from "./run-surface-status";
// ONE definition of the key, in the module that owns the rail's selection type,
// so this projection and the frame that renders it cannot drift into two.
import type { RunInputStepKey } from "./run-surface-rail-step";

export type { RunInputStepKey };

/**
 * The label a form gets when it declares none — the name of the tab the run
 * page's setup already carries, rather than a word invented here.
 */
export const RUN_INPUT_STEP_FALLBACK_LABEL = "Setup";

/** The subset of an input field's schema this projection reads. */
export type RunInputFieldSchema = {
  title?: unknown;
  "x-hidden"?: unknown;
  "x-renderer"?: unknown;
  // A field schema carries whatever the agent declared on it (`type`, the other
  // `x-` presentation hints, the object sub-schema). Only the three above are
  // read here; the rest ride along rather than being stripped by the type.
  [key: string]: unknown;
};

/**
 * ONE ANSWERED FIELD OF AN INPUT FORM, as the settled reading draws it.
 *
 * The ratified drawing: a resolved gate's entry "keeps its place and RECORDS
 * HOW IT WAS SETTLED", and opening it shows "what was decided". So the answer
 * travels ON the step, and whoever draws the read-only reading reads it here
 * rather than re-deriving it from the run row a second time.
 */
export type RunInputStepAnswer = {
  /** The schema field this answer belongs to. */
  field: string;
  /** The field's declared title, or the field's own name. */
  label: string;
  /** The recorded value, as text. */
  value: string;
};

/** ONE input form, as a step. */
export type RunInputStep = {
  /** The selection value this step answers to. */
  key: RunInputStepKey;
  /** The form's declared title, or `Setup`. */
  label: string;
  /** The schema fields this one form collects, in declared order. */
  fields: string[];
  /** Does the run already carry a value for every field of this form? */
  answered: boolean;
  /** Is this the form the run is standing at right now? */
  open: boolean;
  /**
   * Has the run REACHED this step? An answered form and the open one have been
   * reached; a form still ahead of the loop has not, and its row is drawn muted
   * and closed rather than opening a column with nothing in it.
   */
  reached: boolean;
  /** An answered form is the rail's read-only history row. */
  settled: boolean;
  /**
   * WHAT IT WAS ANSWERED WITH (cinatra#3068 fix leg 2) — empty while the form
   * is still open or still ahead, because there is nothing settled to record
   * yet. The settled row opens this and nothing else.
   */
  answers: readonly RunInputStepAnswer[];
};

/**
 * IS THE RECORDED VALUE THE ANSWER ITS OWN FIELD DECLARES?
 *
 * (cinatra#3068 fix leg 2 convergence.) `assertValuesMatchDeclaredObjectTypes`
 * -- the declared-type gate in `input-schema-resolver.ts` -- refuses a run at
 * dispatch when an `object`-typed input carries something that is not a plain
 * object, and the run FAILS having never run. The value is nonetheless on the
 * run row, so "the run carries a value" alone would draw that dead run a
 * SETTLED history row for a form nobody ever answered -- the exact refusal the
 * first leg's convergence bought.
 *
 * So the history side asks the gate's own question. Narrow in the same way the
 * gate is narrow: only `object`-typed inputs are checked, and only at the top
 * level, because that is the class the gate refuses the run over. The PENDING
 * walk above is deliberately NOT narrowed -- it mirrors the setup loop, which
 * asks nothing more than whether the run carries a value, and a rail that drew
 * an OPEN form the loop will never emit would be a new wrongness.
 */
function isPlainJsonObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function recordsADeclaredAnswer(
  value: unknown,
  schema: RunInputFieldSchema | undefined,
): boolean {
  if (schema?.type !== "object") return true;
  return isPlainJsonObject(value);
}

/**
 * THE DISPLAY NAME A FIELD ACTUALLY DECLARES — never its own key restated
 * (cinatra#3047 fix leg 8).
 *
 * `oas-compiler.ts` composes every input property as `{ type, title:
 * displayTitle }` where
 *
 *   const displayTitle = startInputTitles[title] ?? title;
 *
 * over its own comment, "title is the field identifier (camelCase);
 * inputTitles maps it to a human-readable label." So an agent that declares no
 * `metadata.cinatra.inputTitles` entry has its FIELD KEY written into the
 * display-title slot, and reading that slot back as if a person had written it
 * is how a machine key came to stand where a step name belongs: the eighth
 * proof round photographed a rail entry reading `spec`.
 *
 * A title identical to the field's own key is a form declaring none, on the
 * compiler's own reading of it, and the caller then takes
 * `RUN_INPUT_STEP_FALLBACK_LABEL` — "the name of the tab the run page's setup
 * already carries, rather than a word invented here". Nothing is humanized or
 * title-cased: no name is invented here, the machine one is simply refused.
 */
function declaredTitle(
  schema: RunInputFieldSchema | undefined,
  fieldName?: string,
): string | null {
  const title = schema?.title;
  if (typeof title !== "string") return null;
  // NORMALIZED ONCE, then compared and returned (codex convergence, fix leg 8).
  // A title is surrounding whitespace away from being its own field key —
  // " spec " — and comparing the raw string let that one through and then wrote
  // it into the rail entry verbatim. The name a step is drawn under is the
  // trimmed one either way, so there is one reading of the title here.
  const name = title.trim();
  if (name.length === 0) return null;
  if (fieldName !== undefined && name === fieldName.trim()) return null;
  return name;
}

/**
 * TRUTHY, NOT `=== true` (cinatra#3068 convergence).
 *
 * `execution.ts` filters its pending fields on `if (fieldSchema["x-hidden"])` —
 * a truthiness test — so a schema that stored the flag as the string `"true"`
 * is hidden from the person by the loop. Reading it as a strict boolean here
 * would draw a rail entry for a form that is never asked, which is the one
 * error this projection must not make.
 */
function isHidden(schema: RunInputFieldSchema | undefined): boolean {
  return Boolean(schema?.["x-hidden"]);
}

/**
 * THE RECORDED VALUE, AS TEXT, AND AS THE FORM ITSELF READS IT.
 *
 * A field whose schema declares `x-object-text-property` is drawn by the form
 * as ONE control over that property — the blog draft writer's `idea` is an
 * object whose readable text is its `title` — so the settled reading takes the
 * same word rather than showing the record it was stored in. Everything else
 * falls down a plain ladder: a string is the string, a number or a boolean is
 * its own word, and anything else is the JSON the run stored, never
 * `[object Object]`. Nothing is truncated: what is on file is what a reader of
 * the run's history is owed.
 */
function resolvedObjectTextProperty(
  schema: RunInputFieldSchema | undefined,
): string | null {
  // THE FORM'S OWN RULE, NOT A LOOSER ONE (cinatra#3068 fix leg 2 convergence).
  // `resolveObjectTextProperty` in the field renderer honours the hint ONLY
  // when it names a DECLARED `string` sub-property, and falls back to the
  // structured/JSON leg otherwise. Reading the hint loosely here would make the
  // settled reading show a stray inner string for a field the person answered
  // on the structured control -- the history and the form disagreeing about
  // what the answer was. The rule is restated rather than imported: the
  // renderer is a `"use client"` module and this projection is walked by server
  // components; a test pins the two against each other.
  const declared = schema?.["x-object-text-property"];
  if (typeof declared !== "string" || declared.trim() === "") return null;
  const properties = (schema as { properties?: unknown } | undefined)?.properties;
  if (!properties || typeof properties !== "object") return null;
  const target = (properties as Record<string, { type?: unknown } | undefined>)[
    declared
  ];
  if (!target || target.type !== "string") return null;
  return declared;
}

function answerText(value: unknown, schema: RunInputFieldSchema | undefined): string {
  const textProperty = resolvedObjectTextProperty(schema);
  if (
    textProperty !== null &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const inner = (value as Record<string, unknown>)[textProperty];
    if (typeof inner === "string") return inner;
  }
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Project a template's declared inputs into the run's input steps.
 *
 * `atInputMoment` is the run's own answer to "is a form being asked, or about
 * to be" — see `runAtInputMoment`. It decides only WHICH form is open, never
 * how many there are: the series is a property of the agent, and the rail names
 * the whole series from the run's first render so the person can see what the
 * run is going to ask.
 */
export function buildRunInputSteps(params: {
  required: readonly string[];
  properties: Readonly<Record<string, RunInputFieldSchema>>;
  inputParams: Readonly<Record<string, unknown>>;
  atInputMoment: boolean;
}): RunInputStep[] {
  const { required, properties, inputParams, atInputMoment } = params;

  // The fields a person is ever shown: required, and not hidden. Same two
  // clauses the setup loop filters on, in the same order.
  const visible = required.filter((fieldName) => !isHidden(properties[fieldName]));
  if (visible.length === 0) return [];

  const answeredField = (fieldName: string) =>
    Object.prototype.hasOwnProperty.call(inputParams, fieldName);
  const pending = visible.filter((fieldName) => !answeredField(fieldName));

  // THE GROUPED FORM IS ONE FORM, AND THEREFORE ONE STEP. `execution.ts` emits
  // a single grouped INTERRUPT when two or more fields are pending AND the
  // agent opted in by decorating one of them; the same two clauses decide it
  // here, so the rail cannot name three steps for a form that asks once.
  const groupedForm =
    pending.length >= 2 &&
    pending.some(
      (fieldName) => properties[fieldName]?.["x-renderer"] === GROUPED_SETUP_FORM_RENDERER_ID,
    );

  // THE GROUPED FORM IS STILL ONE FORM ONCE IT IS ANSWERED (cinatra#3068 fix
  // leg 2 convergence). The clause above reads `pending.length >= 2`, which is
  // the LOOP's own condition for emitting the grouped interrupt and must stay
  // exactly that while the form is open. But it goes false the moment the form
  // is answered, and the settled projection then fell through to the per-field
  // path: one row per required field, the optional answers dropped, and the
  // steps below renumbered -- the rail recording a walk the person never took
  // instead of the ONE form they filled in. So a fully-answered form that the
  // agent opted into grouping stays one settled row, read from the SCHEMA's
  // opt-in rather than from pendingness, which no longer exists to be read.
  const groupedOptIn = visible.some(
    (fieldName) => properties[fieldName]?.["x-renderer"] === GROUPED_SETUP_FORM_RENDERER_ID,
  );
  if (!groupedForm && groupedOptIn && visible.length >= 2 && pending.length === 0) {
    // The fields that form asked: its visible required ones, and the visible
    // optional ones the run carries an answer for -- the same list
    // `execution.ts` composes for the grouped interrupt, minus the optional
    // fields left blank, which have nothing to record.
    const answeredOptional = Object.keys(properties).filter(
      (fieldName) =>
        !required.includes(fieldName) &&
        !isHidden(properties[fieldName]) &&
        answeredField(fieldName),
    );
    const fields = [...visible, ...answeredOptional];
    const settled = fields.every((fieldName) =>
      recordsADeclaredAnswer(inputParams[fieldName], properties[fieldName]),
    );
    return [
      {
        key: "input:0",
        label: RUN_INPUT_STEP_FALLBACK_LABEL,
        fields,
        answered: true,
        open: false,
        reached: true,
        settled,
        answers: settled
          ? fields.map((fieldName) => ({
              field: fieldName,
              label: declaredTitle(properties[fieldName]) ?? fieldName,
              value: answerText(inputParams[fieldName], properties[fieldName]),
            }))
          : [],
      },
    ];
  }

  if (groupedForm) {
    // THE FIELDS THE GROUPED FORM ACTUALLY ASKS: the pending required ones, and
    // then the visible OPTIONAL ones the run does not carry either — which is
    // exactly the list `execution.ts` composes for the grouped INTERRUPT. A
    // required field already answered is not asked again, so it is not here.
    const optional = Object.keys(properties).filter(
      (fieldName) =>
        !required.includes(fieldName) &&
        !isHidden(properties[fieldName]) &&
        !answeredField(fieldName),
    );
    return [
      {
        key: "input:0",
        // The grouped form declares no title of its own — it is the whole
        // setup, and the tab's name is what the person already reads for it.
        label: RUN_INPUT_STEP_FALLBACK_LABEL,
        fields: [...pending, ...optional],
        answered: false,
        open: atInputMoment,
        reached: true,
        settled: false,
        // A grouped form exists only while two or more of its fields are still
        // pending, so it is never the settled row.
        answers: [],
      },
    ];
  }

  // THE PER-FIELD PATH — the sequence the person actually walks. The loop asks
  // one field at a time, so each is its own form and its own step, in the order
  // the template declares them.
  const firstPending = pending[0] ?? null;
  return visible.map((fieldName, index) => {
    const answered = answeredField(fieldName);
    const open = atInputMoment && fieldName === firstPending;
    // SETTLED is the narrower fact: the run carries a value AND that value is
    // the one its own field declares (see `recordsADeclaredAnswer`).
    const settled =
      answered && recordsADeclaredAnswer(inputParams[fieldName], properties[fieldName]);
    return {
      key: `input:${index}` as RunInputStepKey,
      label: declaredTitle(properties[fieldName], fieldName) ?? RUN_INPUT_STEP_FALLBACK_LABEL,
      fields: [fieldName],
      answered,
      open,
      reached: answered || open,
      settled,
      answers: settled
        ? [
            {
              field: fieldName,
              label: declaredTitle(properties[fieldName]) ?? fieldName,
              value: answerText(inputParams[fieldName], properties[fieldName]),
            },
          ]
        : [],
    };
  });
}

/**
 * DOES THE RUN STILL OWE ONE OF ITS INPUT FORMS?
 *
 * A property of the FORMS alone: some form has no answer yet. It is not on its
 * own the question the rail asks — see `runCarriesInputSteps`.
 */
export function runOwesInputStep(steps: readonly RunInputStep[]): boolean {
  return steps.some((step) => !step.answered);
}

/**
 * DOES THE RAIL CARRY THE RUN'S INPUT STEPS RIGHT NOW?
 *
 * TWO facts, and the second is why this is not `runOwesInputStep` (cinatra#3068
 * convergence). A form with no answer is not by itself an input moment: a run
 * that FAILED before dispatch, one CANCELLED at its form, one refused by the
 * declared-type gate, and one paused at a mid-run review gate all carry an
 * unanswered required input, and none of them is the moment this issue is
 * about. Carrying the steps there would put a muted rail row on a dead run and
 * — because the same answer retires the panel's heading — take that run's only
 * status badge away with it.
 *
 * So the steps ride while the run is AT its input: standing at the setup
 * interrupt, or not yet dispatched (`pending_input`), which is the "the rail
 * exists from the run's first render, before anything has run" the issue asks
 * for.
 *
 * AND THEY STAY ONCE THE FORM IS ANSWERED (cinatra#3068 fix leg 2). The
 * ratified drawing: "A resolved gate stays on the rail as read-only history --
 * its entry keeps its place and records how it was settled ... so the rail is
 * the run's whole lifecycle at a glance, not just its live tip." Retiring the
 * answered row made the rail the live TIP: the first step a person took
 * vanished the moment they took it, and the rail renumbered as though the run
 * had never been asked anything.
 *
 * THE REFUSAL THE CONVERGENCE BOUGHT STANDS EXACTLY WHERE IT WAS BOUGHT. What
 * carries the history is an ANSWER, never an unanswered field: a run that
 * failed before dispatch, one cancelled at its form, one refused by the
 * declared-type gate and one paused at a mid-run review gate with its input
 * never given all carry no input row at all, exactly as before.
 */
export function runHasAnsweredInputStep(steps: readonly RunInputStep[]): boolean {
  // `settled`, not `answered` (cinatra#3068 fix leg 2 convergence): the history
  // rides on an answer the field's own declared type accepts, so a run the
  // declared-type gate refused before it ever ran still carries no input row.
  return steps.some((step) => step.settled);
}

export function runCarriesInputSteps(
  steps: readonly RunInputStep[],
  atInputMoment: boolean,
): boolean {
  if (atInputMoment) return runOwesInputStep(steps);
  return runHasAnsweredInputStep(steps);
}

/** The step the run detail opens on, or `null` when no form is being asked. */
export function openRunInputStepKey(
  steps: readonly RunInputStep[],
): RunInputStepKey | null {
  return steps.find((step) => step.open)?.key ?? null;
}

/**
 * IS THE RUN STANDING AT ITS OWN INPUT FORM?
 *
 * THE DISCRIMINATOR IS THE INTERRUPT, NEVER THE STATUS — a setup-loop pause and
 * a mid-run review gate are both `pending_approval`, so reading the status
 * alone would put the input step under a reviewer's decision.
 *
 * AND THE INTERRUPT IS READ BY THE ONE CLASSIFIER (cinatra#2928). This asks
 * `classifyRunWaitInterrupt` — the same call the status badge
 * (`runStatusBadgeLabel`) and the wait notification
 * (`waitNotificationLandsInConversation`) make — rather than re-checking the
 * synthetic `setup-` task identity here. That prefix is a STAND-IN the plan
 * retired: the run itself now records the moment it waits at, and a screen that
 * re-derives the moment from the prefix answers a narrower question than the
 * badge beside it. The two would then disagree on exactly the runs the recorded
 * fact was added for — a run stating `lifecycleMoment: "hitl"`, and a setup
 * payload carried as a `fieldName`, both of which the prefix test misses.
 *
 * Fails CLOSED with the classifier: nothing readable stays an approval.
 */
export function runStandsAtInputGate(params: {
  runStatus: string | null | undefined;
  interrupt: RunWaitInterruptDescriptor | null | undefined;
}): boolean {
  if (params.runStatus !== "pending_approval") return false;
  return classifyRunWaitInterrupt(params.interrupt) === "input";
}

/**
 * IS THE RUN AT ITS INPUT AT ALL — asking now, or about to?
 *
 * `pending_input` is a run that has not been dispatched: nothing has run, no
 * interrupt exists yet, and the form is the only thing on the page. The rail
 * draws its first entry there, which is what "from the run's first render"
 * means, and it also keeps the FIRST entry selected when the interrupt context
 * could not be derived — that derivation is best-effort and swallows its own
 * failures, so a rail that depended on it alone would silently lose its
 * selection (cinatra#3068 convergence).
 */
export function runAtInputMoment(params: {
  runStatus: string | null | undefined;
  interrupt: RunWaitInterruptDescriptor | null | undefined;
}): boolean {
  if (params.runStatus === "pending_input") return true;
  return runStandsAtInputGate(params);
}

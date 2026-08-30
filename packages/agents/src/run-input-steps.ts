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
};

function declaredTitle(schema: RunInputFieldSchema | undefined): string | null {
  const title = schema?.title;
  return typeof title === "string" && title.trim().length > 0 ? title : null;
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
    return {
      key: `input:${index}` as RunInputStepKey,
      label: declaredTitle(properties[fieldName]) ?? RUN_INPUT_STEP_FALLBACK_LABEL,
      fields: [fieldName],
      answered,
      open,
      reached: answered || open,
      settled: answered,
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
 * So the steps ride exactly while the run is AT its input: standing at the
 * setup interrupt, or not yet dispatched (`pending_input`), which is the "the
 * rail exists from the run's first render, before anything has run" the issue
 * asks for. Every other moment keeps the surface it had.
 */
export function runCarriesInputSteps(
  steps: readonly RunInputStep[],
  atInputMoment: boolean,
): boolean {
  return atInputMoment && runOwesInputStep(steps);
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

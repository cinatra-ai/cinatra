import "server-only";

// ---------------------------------------------------------------------------
// THE HITL SCREEN'S ONE SUBMIT (cinatra#2930, lifecycle-b W3).
//
// WHAT IT ANSWERS. "This person, with the standing they actually hold, answers
// the question THIS run is parked on." One function, for every door that has a
// verified actor and no ambient session to lean on — today the site widget's
// broker entry, tomorrow anything else that proves itself with a credential
// rather than a cookie.
//
// IT IS NOT A SECOND SUBMIT PATH, and that is the whole point. The answer is
// handed to `approveReviewTaskInternal` — the SAME auth-neutral core the
// cookie-bound `approveReviewTask` server action calls, which the run page's
// Continue has always called. Same setup-loop merge, same grouped-form
// allowlist, same declared-type gate, same WayFlow resume, same CAS, same
// re-enqueue, in the same order. What differs is where the identity came from,
// and nothing else. (Read `run-recommendation-core.ts` for the same shape on
// the run-start decision: the broker entry hands the verified actor to the core
// the session action also calls.)
//
// THE ACCESS CHECKS ARE THE IN-APP ONES, TAKEN AGAINST THE WIDGET'S ACTOR. The
// core enforces `run.execute` THEN `run.approveHitl` against the run it
// resolves, before any state-changing write, whenever it is handed an
// `actorContext` — which this function always does. So a widget reader clears a
// gate exactly when the same person clears it inside the app, and never
// otherwise. No looser, and nothing added that the app does not also apply.
//
// WHAT IS ADDED IS A NARROWING, and it is the one this surface needs: the
// answer must be for THE GATE THIS RUN IS ACTUALLY PARKED ON. The in-app door
// resolves the run FROM the review-task id; a credential-declaring surface
// addresses its card by a run id taken off a transcript part, so it names BOTH
// and the two must agree. Without that, a reader whose standing can drive some
// other run could name that run's gate id here. So the gate is re-derived from
// the run — through `agentHitlScreenStateForRun`, the same derivation the card
// READ answers from — and a submitted id that is not the derived one is refused
// before anything is written. A caller therefore reaches precisely the question
// it was shown, and nothing else.
//
// AND THE ENTRY MAY IMPOSE ITS OWN BINDING ON TOP (`bindRun`). The widget's is
// the run <-> widget-session binding: the run must be this person's own run in
// the org their TOKEN is bound to. It runs on the row this function already
// read THROUGH the access door, and BEFORE the gate is derived, so a run the
// conversation does not own is never even observed to be asking.
//
// EVERY REFUSAL IS THE SAME REFUSAL. "You may not drive this run", "that is not
// the gate this run is on", "there is no such run" and "the run is not parked"
// answer identically, so a caller holding a run id learns nothing about which
// runs exist — the same silence the card's READ collapses every denial to.
//
// "ALREADY RESOLVED" IS A SUCCESS. The gate answered on another surface, or a
// double press, is the expected race every submit site in this codebase
// tolerates (`isAlreadyResolvedError`), and the reader's screen should settle
// exactly as it settles when their own answer landed — because the question
// really is answered.
// ---------------------------------------------------------------------------

import { approveReviewTaskInternal } from "./review-task-actions";
import { isAlreadyResolvedError } from "./hitl-gate-submit";
import { readAgentRunById, type AgentRunRecord } from "./store";
import {
  agentHitlScreenStateForRun,
  type AgentHitlScreenActor,
} from "./agent-hitl-screen-core";

/**
 * The ONE refusal string this surface answers with. Uniform on purpose — see
 * the header: a caller must not be able to tell "not yours" from "not asking"
 * from "no such run".
 */
export const AGENT_HITL_SUBMIT_REFUSAL =
  "This question could not be answered from here.";

export type AgentHitlScreenSubmitOutcome =
  | { ok: true }
  | { ok: false; error: string };

const REFUSED: AgentHitlScreenSubmitOutcome = {
  ok: false,
  error: AGENT_HITL_SUBMIT_REFUSAL,
};

/**
 * THE GATE THE RUN IS ACTUALLY PARKED ON, or null.
 *
 * Split out from the submit below so the rule is testable without a database
 * and so it has exactly one definition. Nothing the caller sends is trusted
 * beyond an equality check — no caller value is ever used to LOOK anything up.
 *
 * THE FIELD IS PART OF THE GATE'S IDENTITY, and leaving it out was a real hole
 * (convergence). A setup-loop run asks its questions ONE AT A TIME
 * and every one of them carries the SAME synthetic `setup-<runId>` review-task
 * id — the id names the RUN, not the question. Downstream, `fieldName` is what
 * selects which declared input the answer is merged into. So an id-only check
 * let a caller who was shown "destination" answer with
 * `fieldName: "apiKey"` and have THAT input written instead, and let a
 * grouped-setup gate (which carries no field at all) be turned into an
 * arbitrary single-field write. Both are refused here:
 *
 *   · a gate that names a field REQUIRES exactly that field;
 *   · a gate that names none — a mid-run gate, a grouped-setup form — requires
 *     the caller to name none either.
 *
 * The returned field is the DERIVED one, so what is submitted downstream is the
 * server's value rather than the caller's echo of it.
 *
 * WHAT THIS IS NOT: A LOCK (convergence). The derivation here and
 * the approval core's own CAS are two reads, so a setup loop that advances to
 * its NEXT question between them can still be answered with the field this call
 * derived — the core's CAS guards the run's STATUS, not which question it is on,
 * and every setup question shares one `setup-<runId>` identity. That race is
 * the shipped approval core's, identical on the in-app path (the run page's
 * Continue submits the field ITS last poll saw, with the same two reads), and
 * closing it means making the core compare the field inside the same CAS —
 * which is a change to the one core the run page, the A2A resume route and the
 * MCP resume frame all share, and is not this slice's to make. What is closed
 * here is the substitution: a caller cannot ANSWER a field the run was not
 * asking, at the moment it was read.
 */
export async function resolveAgentHitlSubmitGate(
  run: AgentRunRecord,
  reviewTaskId: string,
  fieldName?: string,
): Promise<{ reviewTaskId: string; fieldName: string | undefined } | null> {
  if (!reviewTaskId) return null;
  const state = await agentHitlScreenStateForRun(run).catch(() => null);
  if (!state || state.state !== "asking") return null;
  if (state.gate.reviewTaskId !== reviewTaskId) return null;
  const derived = state.gate.fieldName ?? undefined;
  const claimed = fieldName === "" ? undefined : fieldName;
  if (derived !== claimed) return null;
  return { reviewTaskId: state.gate.reviewTaskId, fieldName: derived };
}

/**
 * Answer the question a run is parked on, as one verified actor.
 *
 * The access door runs FIRST — a reader who may not see the run never observes
 * anything about its gate — then the entry's own binding, then the gate
 * derivation, and only then the shipped approval core.
 */
export async function submitAgentHitlScreenForActor(input: {
  /** The run the caller's transcript already names. */
  runId: string;
  /** The gate the caller was SHOWN. Checked against the run's own gate. */
  reviewTaskId: string;
  /** The reviewer's answer, in the shape the run panel submits. */
  values?: unknown;
  /** Set on a single-field setup gate, exactly as the panel sets it. */
  fieldName?: string;
  /** The principal the write is grounded on (audit + org-authority mint). */
  actorId: string;
  /** The verified actor the entry resolved. Never supplied by a caller. */
  who: AgentHitlScreenActor;
  /**
   * An entry-imposed binding on the run this function just read. Returning
   * false refuses with the uniform refusal, before the gate is derived and
   * before anything is written.
   */
  bindRun?: (run: AgentRunRecord) => boolean;
}): Promise<AgentHitlScreenSubmitOutcome> {
  const { runId, reviewTaskId, actorId, who } = input;
  if (!runId || !reviewTaskId || !actorId) return REFUSED;

  // THE ACCESS DOOR FIRST. Same door the read uses, same actor.
  const run = await readAgentRunById(runId, who.actor, who.roleHints).catch(() => null);
  if (!run) return REFUSED;

  // THE ENTRY'S OWN BINDING, on the row we just read, before anything else.
  if (input.bindRun && !input.bindRun(run)) return REFUSED;

  // THE GATE MUST BE THIS RUN'S GATE — the review task AND the field.
  const gate = await resolveAgentHitlSubmitGate(run, reviewTaskId, input.fieldName);
  if (!gate) return REFUSED;

  try {
    await approveReviewTaskInternal(
      gate.reviewTaskId,
      actorId,
      input.values,
      // The DERIVED field, not the caller's echo of it.
      gate.fieldName,
      null,
      // The verified actor — so the core enforces `run.execute` and
      // `run.approveHitl` against the run it resolves, exactly as it does for
      // the cookie-bound action. Omitting it would make that gate a NO-OP.
      who.actor,
      who.roleHints,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The gate was answered while this reader was typing — on the run page, in
    // the composer, in another tab. The question IS answered, so the screen
    // settles rather than showing a refusal for a decision that landed.
    if (isAlreadyResolvedError(message)) return { ok: true };
    console.warn(
      `[submitAgentHitlScreenForActor] refused run ${runId}: ${message}`,
    );
    return REFUSED;
  }
  return { ok: true };
}

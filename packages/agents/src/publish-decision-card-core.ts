import "server-only";

// ---------------------------------------------------------------------------
// The publish card's ONE authorized read (cinatra#4150 part 7a-1a).
//
// "Which publish card does this run show this reader?" Answered for one verified actor through the run access door,
// from the run's NEWEST decision (the one every resume road reads): parked = pending, released = approved, declined,
// expired. A decision the run left another way (run_ended) is no card, and neither is a parked decision of a run that
// is not held at its gate (pending_approval, or running when a hold wrote its row but not its move): an ended run the
// sweep has not closed yet, or a failed attempt's row read through a retry's next attempt. "May decide" is the SAME check Publish and Do not
// publish run (enforcePublishDecisionAccess), asked without deciding, so a restricted card and a refused answer cannot
// disagree. The site widget's card (publishDecisionCardStateForWidgetRun) asks the same run rights of the widget's reader
// (widgetReaderMayDecidePublish), whom those two refuse, so its owner is not drawn
// restricted; its answer is the widget's own decide road below.
// Every refusal and every unreadable record collapses to "none": a caller holding a run id learns nothing about which
// runs exist, and a card that cannot be read draws nothing rather than half a card.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import type { ActorRoleHints } from "./auth-policy";
import {
  PUBLISH_DECISION_CARD_NONE,
  publishDecisionCardRows,
  type PublishDecisionCardAnswer,
  type PublishDecisionCardState,
  type PublishDecisionDecideOutcome,
} from "./publish-decision-card";
import {
  approvePublishDecision,
  approvePublishDecisionAsWidgetReader,
  declinePublishDecision,
  declinePublishDecisionAsWidgetReader,
  enforcePublishDecisionAccess,
  widgetReaderMayDecidePublish,
  type PublishApproveAnswer,
  type PublishDecisionAnswer,
} from "./publish-decision-actions";
import { readLatestDecisionForRun } from "./publish-decision-store";
import { readAgentRunById, readAgentTemplateById, type AgentRunRecord } from "./store";

export { PUBLISH_DECISION_CARD_NONE } from "./publish-decision-card";
export type {
  PublishDecisionCardAnswer,
  PublishDecisionCardRow,
  PublishDecisionCardState,
  PublishDecisionDecideOutcome,
} from "./publish-decision-card";

/** The verified actor a server entry hands in. Never supplied by a caller. */
export type PublishDecisionCardActor = {
  actor: PrimitiveActorContext;
  roleHints: ActorRoleHints;
};

/** The card for a run already read through the access door. */
export async function publishDecisionCardStateForRun(
  run: AgentRunRecord,
  who: PublishDecisionCardActor,
): Promise<PublishDecisionCardState> {
  return cardStateForRun(run, who, () =>
    enforcePublishDecisionAccess({ runId: run.id, actorContext: who.actor, roleHints: who.roleHints }).then(
      () => true,
      () => false,
    ),
  );
}

/**
 * The card for a run the SITE WIDGET's broker route already read and bound to its session. The widget door's actor is
 * a human of source "a2a", which Publish and Do not publish refuse; "may decide" here asks the same run rights for that
 * reader (widgetReaderMayDecidePublish), so a run owner who holds them is not drawn restricted. It decides nothing.
 */
export async function publishDecisionCardStateForWidgetRun(
  run: AgentRunRecord,
  who: PublishDecisionCardActor,
): Promise<PublishDecisionCardState> {
  return cardStateForRun(run, who, () =>
    widgetReaderMayDecidePublish({ runId: run.id, actorContext: who.actor, roleHints: who.roleHints }),
  );
}

async function cardStateForRun(
  run: AgentRunRecord,
  who: PublishDecisionCardActor,
  readMayDecide: () => Promise<boolean>,
): Promise<PublishDecisionCardState> {
  const decision = await readLatestDecisionForRun(run.id).catch(() => null);
  if (!decision || decision.status === "run_ended") return PUBLISH_DECISION_CARD_NONE;
  const template = await readAgentTemplateById(run.templateId).catch(() => null);
  if (!template) return PUBLISH_DECISION_CARD_NONE;
  // The rows the decision kept at its park: a later recompile of the template never relabels a decision. Only a row
  // older than that record (declaredRows null) falls back to the template's current rows. An own key only: a node id
  // that names an Object.prototype member reads as no declaration.
  const byNode = template.publishRows ?? {};
  const declared = decision.declaredRows
    ?? (Object.prototype.hasOwnProperty.call(byNode, decision.nodeId) ? (byNode[decision.nodeId] ?? []) : []);
  const common = {
    runId: run.id,
    agentName: template.name,
    rows: publishDecisionCardRows(declared, decision.surfacedValues),
  };
  // A settled card names its decider. A row with none recorded, or a name read that fails, draws nothing: never an
  // anonymous card, and never a decline reason the read could not attribute.
  const settled = async (draw: (deciderName: string | null) => PublishDecisionCardState) => {
    const decidedBy = decision.decidedBy;
    if (!decidedBy) return PUBLISH_DECISION_CARD_NONE;
    // Loaded at the read, never at module load: the settled-outcome helper imports the review gate store, and this
    // module is reached from the agents barrel (through the stepper panel's card), which the review gate store's own
    // import graph reaches back into. A static edge closes that loop at module load, so a test that mocks the store
    // with an async factory waits on itself forever (the whole unit suite stalled on it).
    const name = await import("@/lib/lifecycle/lifecycle-settled-outcome")
      .then(({ readDeciderName }) => readDeciderName(decidedBy))
      .catch(() => false as const);
    return name === false ? PUBLISH_DECISION_CARD_NONE : draw(name ?? null);
  };
  switch (decision.status) {
    case "parked": {
      // Only a HELD run is parked at this gate: pending_approval, or running when a hold wrote its row but not its move
      // (the statuses the expiry sweep holds). An ended run, and a retried run back in pending_input or queued, is parked
      // at no gate: its row closes as run_ended (at the retry's reset, or the sweep), and until then the read already
      // answers what that close will: no card. Nothing is written by this read.
      if (run.status !== "pending_approval" && run.status !== "running") return PUBLISH_DECISION_CARD_NONE;
      const mayDecide = await readMayDecide().catch(() => false);
      return { state: "pending", ...common, mayDecide };
    }
    case "released":
      return settled((deciderName) => ({ state: "approved", ...common, deciderName }));
    case "declined":
      return settled((deciderName) => ({ state: "declined", ...common, deciderName, reason: decision.decisionNote }));
    case "expired":
      return { state: "expired", ...common };
    default:
      return PUBLISH_DECISION_CARD_NONE;
  }
}

/** THE READ, for one verified actor. The access door runs first. */
export async function resolvePublishDecisionCardStateForActor(input: {
  runId: string;
  who: PublishDecisionCardActor;
}): Promise<PublishDecisionCardState> {
  if (!input.runId) return PUBLISH_DECISION_CARD_NONE;
  const run = await readAgentRunById(input.runId, input.who.actor, input.who.roleHints).catch(() => null);
  if (!run) return PUBLISH_DECISION_CARD_NONE;
  return publishDecisionCardStateForRun(run, input.who);
}

// ---------------------------------------------------------------------------
// THE CARD'S ANSWER (cinatra#4758): Allow and Do not allow, for one verified actor. No second approval core: Allow is
// approvePublishDecision and Do not allow is declinePublishDecision, the roads that check run.execute then
// run.approveHitl, write the one decision (who and when, and a decline's note) through the decision store's guarded
// write, and release the run to its publishing step or stop it. The site widget's answer takes the same two roads for
// the widget's reader. A late answer is "not_open"; every refusal and fault is "failed", with nothing else told.
// ---------------------------------------------------------------------------

/** A card's answer as sent: the run, the answer and the note (a decline's only). */
export type PublishDecisionCardDecideInput = { runId: string; answer: PublishDecisionCardAnswer; note?: string | null };

const isAnswer = (value: unknown): value is PublishDecisionCardAnswer => value === "approve" || value === "decline";

/** The input as the roads take it, or null for a shape the card never sends. */
function decideInputOf(input: PublishDecisionCardDecideInput): { runId: string; answer: PublishDecisionCardAnswer; note: string | null } | null {
  const { runId, answer, note } = (input ?? {}) as Partial<PublishDecisionCardDecideInput>;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 256 || !isAnswer(answer)) return null;
  if (note !== undefined && note !== null && typeof note !== "string") return null;
  // Only a decline records a note; an empty or blank note is none. A note over the store's cap is refused by its write.
  return { runId, answer, note: answer === "decline" && typeof note === "string" && note.trim().length > 0 ? note : null };
}

function outcomeOf(answer: PublishDecisionAnswer | PublishApproveAnswer): PublishDecisionDecideOutcome {
  if (!answer.ok) return "not_open";
  // An Allow that resumed nothing met a run that is not waiting at this decision's gate (another answer released it,
  // or the run moved on): for this reader the request is no longer open.
  return "resumed" in answer && !answer.resumed ? "not_open" : "decided";
}

async function decideWith(
  input: PublishDecisionCardDecideInput,
  who: PublishDecisionCardActor,
  roads: { approve: typeof approvePublishDecision; decline: typeof declinePublishDecision },
): Promise<PublishDecisionDecideOutcome> {
  const parsed = decideInputOf(input);
  if (!parsed) return "failed";
  const base = { runId: parsed.runId, actorContext: who.actor, roleHints: who.roleHints };
  try {
    return outcomeOf(parsed.answer === "approve" ? await roads.approve(base) : await roads.decline({ ...base, note: parsed.note }));
  } catch {
    return "failed";
  }
}

/** THE ANSWER, for one verified session actor (the run panel, the chat turn, the review page). */
export async function decidePublishDecisionCardForActor(input: PublishDecisionCardDecideInput, who: PublishDecisionCardActor): Promise<PublishDecisionDecideOutcome> {
  return decideWith(input, who, { approve: approvePublishDecision, decline: declinePublishDecision });
}

/** THE ANSWER, for the SITE WIDGET's reader, called only by the widget's decide route after it consumed the reader's
 *  credential under the decide grant and bound the run to that widget session. */
export async function decidePublishDecisionCardForWidgetReader(input: PublishDecisionCardDecideInput, who: PublishDecisionCardActor): Promise<PublishDecisionDecideOutcome> {
  return decideWith(input, who, { approve: approvePublishDecisionAsWidgetReader, decline: declinePublishDecisionAsWidgetReader });
}

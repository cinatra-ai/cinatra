import "server-only";

// ---------------------------------------------------------------------------
// The publish card's ONE authorized read (cinatra#4150 part 7a-1a).
//
// "Which publish card does this run show this reader?" Answered for one verified actor through the run access door,
// from the run's NEWEST decision (the one every resume road reads): parked = pending, released = approved, declined,
// expired. A decision the run left another way (run_ended) is no card. "May decide" is the SAME check Publish and Do not
// publish run (enforcePublishDecisionAccess), asked without deciding, so a restricted card and a refused answer cannot
// disagree. The site widget's card (publishDecisionCardStateForWidgetRun) asks the same run rights of the widget's reader
// (widgetReaderMayDecidePublish), whom those two refuse, so its owner is not drawn restricted; it has no decide door yet.
// Every refusal and every unreadable record collapses to "none": a caller holding a run id learns nothing about which
// runs exist, and a card that cannot be read draws nothing rather than half a card.
//
// Nothing mounts the card yet and no run states the publish moment yet (later parts), so this read is inert.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import type { ActorRoleHints } from "./auth-policy";
import {
  PUBLISH_DECISION_CARD_NONE,
  publishDecisionCardRows,
  type PublishDecisionCardState,
} from "./publish-decision-card";
import { enforcePublishDecisionAccess, widgetReaderMayDecidePublish } from "./publish-decision-actions";
import { readLatestDecisionForRun } from "./publish-decision-store";
import { readAgentRunById, readAgentTemplateById, type AgentRunRecord } from "./store";

export { PUBLISH_DECISION_CARD_NONE } from "./publish-decision-card";
export type { PublishDecisionCardRow, PublishDecisionCardState } from "./publish-decision-card";

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
  // An own key only: a node id that names an Object.prototype member reads as no declaration.
  const byNode = template.publishRows ?? {};
  const declared = Object.prototype.hasOwnProperty.call(byNode, decision.nodeId) ? (byNode[decision.nodeId] ?? []) : [];
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

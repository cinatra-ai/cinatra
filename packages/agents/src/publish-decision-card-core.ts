import "server-only";

// ---------------------------------------------------------------------------
// The publish card's ONE authorized read (cinatra#4150 part 7a-1a).
//
// "Which publish card does this run show this reader?" Answered for one verified actor through the run access door,
// from the run's NEWEST decision (the one every resume road reads): parked = pending, released = approved, declined,
// expired. A decision the run left another way (run_ended) is no card. "May decide" is the SAME check Publish and Do not
// publish run (enforcePublishDecisionAccess), asked without deciding, so a restricted card and a refused answer cannot
// disagree. Every refusal and every unreadable record collapses to "none": a caller holding a run id learns nothing
// about which runs exist, and a card that cannot be read draws nothing rather than half a card.
//
// Part 7a-3a: decidePublishDecisionForActor, the ONE answer of the card's decide doors (the session action, and the
// widget broker route of a later part): it hands Publish and Do not publish the verified actor and reads their answer as
// the card's three outcomes. It decides nothing itself.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { readDeciderName } from "@/lib/lifecycle/lifecycle-settled-outcome";

import type { ActorRoleHints } from "./auth-policy";
import {
  PUBLISH_DECISION_CARD_NONE,
  publishDecisionCardRows,
  type PublishDecisionCardState,
} from "./publish-decision-card";
import {
  approvePublishDecision,
  declinePublishDecision,
  enforcePublishDecisionAccess,
  type WidgetPublishDecideGrant,
} from "./publish-decision-actions";
import { readLatestDecisionForRun } from "./publish-decision-store";
import { readAgentRunById, readAgentTemplateById, type AgentRunRecord } from "./store";

export { PUBLISH_DECISION_CARD_NONE } from "./publish-decision-card";
// The widget publish grant's ONE mint, reached by the two widget publish routes through this module's subpath.
export { mintWidgetPublishDecideGrant } from "./publish-decision-actions";
export type { PublishDecisionCardRow, PublishDecisionCardState } from "./publish-decision-card";

/** The verified actor a server entry hands in. Never supplied by a caller. */
export type PublishDecisionCardActor = {
  actor: PrimitiveActorContext;
  roleHints: ActorRoleHints;
  /** The site widget's publish grant for this run (part 7a-3b), minted by a widget route only. */
  widgetGrant?: WidgetPublishDecideGrant;
};

/** The card for a run already read through the access door. */
export async function publishDecisionCardStateForRun(
  run: AgentRunRecord,
  who: PublishDecisionCardActor,
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
    if (!decision.decidedBy) return PUBLISH_DECISION_CARD_NONE;
    const name = await readDeciderName(decision.decidedBy).catch(() => false as const);
    return name === false ? PUBLISH_DECISION_CARD_NONE : draw(name ?? null);
  };
  switch (decision.status) {
    case "parked": {
      const mayDecide = await enforcePublishDecisionAccess({
        runId: run.id,
        actorContext: who.actor,
        roleHints: who.roleHints,
        ...(who.widgetGrant ? { widgetGrant: who.widgetGrant } : {}),
      }).then(
        () => true,
        () => false,
      );
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

/** What a decide door answers the card: the decision landed, the request was no longer open, or nothing was decided. */
export type PublishDecisionDoorAnswer = "decided" | "not_open" | "failed";

/**
 * Publish ("approve") or Do not publish ("decline", with the optional note), for one verified actor. Every check is the
 * decision road's own (enforcePublishDecisionAccess first). A late answer is "not_open"; a refusal, a fault and an input
 * the card never sends are "failed", logged by a fixed text only (no run id, note or error text).
 */
export async function decidePublishDecisionForActor(input: {
  runId: string;
  answer: "approve" | "decline";
  note: string;
  who: PublishDecisionCardActor;
}): Promise<PublishDecisionDoorAnswer> {
  const { runId, answer, who } = input;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 256) return "failed";
  if (answer !== "approve" && answer !== "decline") return "failed";
  const base = { runId, actorContext: who.actor, roleHints: who.roleHints, ...(who.widgetGrant ? { widgetGrant: who.widgetGrant } : {}) };
  try {
    const result =
      answer === "approve"
        ? await approvePublishDecision(base)
        : await declinePublishDecision({ ...base, note: typeof input.note === "string" ? input.note : null });
    return result.ok ? "decided" : "not_open";
  } catch {
    console.warn("[publish-decision] a decide door could not record the answer");
    return "failed";
  }
}

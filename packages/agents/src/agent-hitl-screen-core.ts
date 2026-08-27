// ---------------------------------------------------------------------------
// THE HITL SCREEN'S ONE CORE — the authorized read behind `agent_hitl_screen`
// (cinatra#2930, lifecycle-b W3).
//
// WHAT IT ANSWERS. "Is this run parked asking a person for input, and if so
// which gate is it asking on?" — for ONE verified actor, through the run access
// door, and nothing else. Both transports land here: the cookie host's server
// action (`agent-hitl-screen-actions.ts`) and the credential-declaring host's
// broker route (`src/app/api/lifecycle-views/hitl-screen/route.ts`), exactly as
// the recommendation hold's core serves its two entries. One core, two doors —
// so a surface cannot be answered a different truth by the door it came in.
//
// THE CARRIAGE IS THE RUN'S OWN ROW. W2a registered the kind; W3's carriage
// record states its canonical carriage is `run_state`, so the reference this
// reader hands back is the row's own. It is read through `runStatesHitlMoment`,
// the ONE helper that compares the recorded moment and card kind against the
// kind's exported constants, and that comparison is never re-spelled here or on
// any screen — a second module deciding what a moment means is how two answers
// drift apart. What the recorded moment is NOT is the condition for drawing:
// that is the run panel's own derived gate, for the reason set out at the
// reader below.
//
// THE GATE ITSELF IS NOT RE-DERIVED. `deriveRunHitlContext` is the SINGLE
// existing derivation the run page's own poll surfaces already use (the REST
// route and the A2A snapshot). It is called, not copied, so the card is asking
// on exactly the gate the run panel is asking on — same renderer id, same
// schema, same current values, same review-task identity.
//
// FAIL CLOSED, AND SILENTLY. Every refusal collapses to `{ state: "none" }`:
// a run this reader may not read, a run that states no moment, a run whose gate
// cannot be derived. A caller holding a run id therefore learns nothing about
// which runs exist, and an unresolvable card draws nothing rather than drawing
// half a screen.
//
// THE SHAPE LIVES NEXT DOOR, in `agent-hitl-screen.ts`, and that split is load
// bearing rather than tidy: this module reaches the store and the interrupt log,
// and the CARD must not. The card imports the shape; only a server entry imports
// this.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "./agent-builder-ids";
import type { ActorRoleHints } from "./auth-policy";
import { deriveRunHitlContext } from "./hitl-context";
import { readAgentRunById, type AgentRunRecord } from "./store";
import {
  AGENT_HITL_SCREEN_NONE,
  runStatesHitlMoment,
  type AgentHitlScreenState,
} from "./agent-hitl-screen";

export {
  AGENT_HITL_CARD_KIND,
  AGENT_HITL_MOMENT,
  AGENT_HITL_SCREEN_NONE,
  parseAgentHitlScreenState,
  runStatesHitlMoment,
} from "./agent-hitl-screen";
export type {
  AgentHitlScreenGate,
  AgentHitlScreenState,
} from "./agent-hitl-screen";

/** The verified actor the two entries hand in. Never supplied by a caller. */
export type AgentHitlScreenActor = {
  actor: PrimitiveActorContext;
  roleHints: ActorRoleHints;
};

/**
 * The state for a run already read through the access door.
 *
 * Split out from the reader below so the broker route can answer from a run it
 * already holds without a second read, and so the rule itself is testable
 * without a database.
 */
export async function agentHitlScreenStateForRun(
  run: AgentRunRecord,
): Promise<AgentHitlScreenState> {
  // THE GATE IS THE RUN PANEL'S GATE, AND DELIBERATELY NOT A SECOND ONE.
  //
  // The obvious reading — require the run to STATE the `hitl` moment — was
  // written first and is wrong, for a reason worth keeping: the run page has
  // drawn this screen for every run whose derived HITL context carries a
  // renderer since long before the moment existed, and a card that additionally
  // required the stated moment would withhold the screen from every run the
  // coordinator never got to state one for — a setup-loop pause, a run started
  // before the record existed, a park whose moment write lost its CAS. Those
  // runs would then show NO screen at all in a conversation, because the panel
  // stands down there. So the card's condition IS the panel's condition:
  // `deriveRunHitlContext` — one derivation, already the single source both
  // poll surfaces use — answers only for a run parked on a gate, and a gate
  // with no renderer is not a screen to draw.
  //
  // The stated moment is still read, as PROVENANCE: when the coordinator did
  // record it, its server-checked reference travels with the answer.
  const context = await deriveRunHitlContext(run).catch(() => null);
  if (!context || !context.xRenderer) return AGENT_HITL_SCREEN_NONE;
  // …AND THE PANEL'S EXCLUSION TRAVELS WITH THE PANEL'S CONDITION. A MARKED
  // artifact-review gate parks the run the same way and derives the same shape,
  // and it is NOT this moment: it is the review, which has its own kind, its own
  // card and its own decision floor. The run panel refuses it before its own
  // HITL branch for exactly that reason, and a card that took it would put a
  // second screen beside the review card for one gate.
  if (context.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID) {
    return AGENT_HITL_SCREEN_NONE;
  }
  return {
    state: "asking",
    runId: run.id,
    screenRef: runStatesHitlMoment(run) ? (run.lifecycleCardRef ?? null) : null,
    gate: {
      reviewTaskId: context.reviewTaskId,
      xRenderer: context.xRenderer,
      inputSchema: context.inputSchema ?? {},
      currentValues: context.currentValues ?? {},
      fieldName: context.fieldName ?? null,
    },
  };
}

/**
 * THE READ, for one verified actor. The access door runs FIRST — a reader who
 * may not see the run never observes anything about its moment.
 */
export async function resolveAgentHitlScreenStateForActor(input: {
  runId: string;
  who: AgentHitlScreenActor;
}): Promise<AgentHitlScreenState> {
  if (!input.runId) return AGENT_HITL_SCREEN_NONE;
  const run = await readAgentRunById(
    input.runId,
    input.who.actor,
    input.who.roleHints,
  ).catch(() => null);
  if (!run) return AGENT_HITL_SCREEN_NONE;
  return agentHitlScreenStateForRun(run);
}

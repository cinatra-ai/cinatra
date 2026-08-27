"use server";

// ---------------------------------------------------------------------------
// The HITL screen card's SESSION ENTRY (cinatra#2930, lifecycle-b W3).
//
// A thin, cookie-bound door: it resolves the signed-in session and its live org
// standing, and hands that verified actor to the ONE core
// (`agent-hitl-screen-core.ts`). It decides nothing itself, exactly as
// `run-recommendation-actions.ts` decides nothing about the hold.
//
// NO ACTOR ARGUMENT, EVER. An exported action is a client-callable endpoint, so
// identity is resolved HERE from the session and can never be supplied by a
// caller. The credential-declaring host (the site widget) does not call this at
// all — it posts to the broker route with its own `cwu_`.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";

import type { ActorRoleHints } from "./auth-policy";
import {
  AGENT_HITL_SCREEN_NONE,
  resolveAgentHitlScreenStateForActor,
  type AgentHitlScreenActor,
  type AgentHitlScreenState,
} from "./agent-hitl-screen-core";

/**
 * The session caller, as the core's verified-actor shape.
 *
 * FAIL-CLOSED: a request with no session, or one whose kernel context cannot be
 * resolved, is not a narrower actor — it is no actor, and the read below turns
 * it into the same silence an unauthorized reader gets.
 */
async function sessionActor(): Promise<AgentHitlScreenActor | null> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return null;
  const viewer = await requireActorContext().catch(() => null);
  if (!viewer) return null;
  const roleHints: ActorRoleHints = {
    ...(viewer.platformRole ? { platformRole: viewer.platformRole } : {}),
    ...(viewer.orgRole ? { orgRole: viewer.orgRole } : {}),
    ...(viewer.teamRoles ? { teamRoles: viewer.teamRoles } : {}),
    ...(viewer.teamIds ? { teamIds: viewer.teamIds } : {}),
    ...(viewer.projectGrants ? { projectGrants: viewer.projectGrants } : {}),
    actorOrganizationId: viewer.organizationId ?? null,
  };
  const actor: PrimitiveActorContext = { actorType: "human", source: "ui", userId };
  return { actor, roleHints };
}

/**
 * The run's HITL screen for a COOKIE host. Returns:
 *   asking → the gate the agent is asking on, so the card can draw the screen;
 *   none   → no screen (the run states another moment, no derivable gate, no
 *            run, or a reader who may not see the run).
 */
export async function getAgentHitlScreenStateAction(input: {
  runId: string;
}): Promise<AgentHitlScreenState> {
  const who = await sessionActor();
  if (!who) return AGENT_HITL_SCREEN_NONE;
  return resolveAgentHitlScreenStateForActor({ runId: input.runId, who });
}

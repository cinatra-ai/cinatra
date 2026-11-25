"use server";

// ---------------------------------------------------------------------------
// The publish card's SESSION entry (cinatra#4150 part 7a-1a): a thin, cookie-bound door that resolves the signed-in
// person and their live org standing and hands that verified actor to the ONE read (publish-decision-card-core.ts). It
// decides nothing itself. NO ACTOR ARGUMENT, EVER: an exported action is a client-callable endpoint, so identity comes
// from the session and never from a caller. The card's read and its answer (cinatra#4758) are the two doors here.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";

import type { ActorRoleHints } from "./auth-policy";
import {
  PUBLISH_DECISION_CARD_NONE,
  decidePublishDecisionCardForActor,
  resolvePublishDecisionCardStateForActor,
  type PublishDecisionCardActor,
  type PublishDecisionCardDecideInput,
  type PublishDecisionCardState,
  type PublishDecisionDecideOutcome,
} from "./publish-decision-card-core";

/** The session caller, or null: no session, or no resolvable kernel context, is no actor (fail closed). */
async function sessionActor(): Promise<PublishDecisionCardActor | null> {
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

/** The run's publish card for a COOKIE host: pending, approved, declined, expired, or none. */
export async function getPublishDecisionCardStateAction(input: {
  runId: string;
}): Promise<PublishDecisionCardState> {
  const who = await sessionActor();
  if (!who) return PUBLISH_DECISION_CARD_NONE;
  return resolvePublishDecisionCardStateForActor({ runId: input.runId, who });
}

/**
 * The card's answer for a COOKIE host (cinatra#4758): Allow or Do not allow, as the session's person. The decision is
 * the core's (run.execute then run.approveHitl, one guarded decision write naming that person, then the run released
 * to its publishing step or stopped). No session is no actor, and nothing is written.
 */
export async function decidePublishDecisionCardAction(
  input: PublishDecisionCardDecideInput,
): Promise<PublishDecisionDecideOutcome> {
  const who = await sessionActor();
  if (!who) return "failed";
  return decidePublishDecisionCardForActor(input, who);
}

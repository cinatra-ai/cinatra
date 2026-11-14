"use server";

// ---------------------------------------------------------------------------
// The publish card's SESSION entry (cinatra#4150 part 7a-1a): a thin, cookie-bound door that resolves the signed-in
// person and their live org standing and hands that verified actor to the ONE read (publish-decision-card-core.ts). It
// decides nothing itself. NO ACTOR ARGUMENT, EVER: an exported action is a client-callable endpoint, so identity comes
// from the session and never from a caller. Nothing calls it yet; the card that does lands in a later part.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";

import type { ActorRoleHints } from "./auth-policy";
import {
  PUBLISH_DECISION_CARD_NONE,
  resolvePublishDecisionCardStateForActor,
  type PublishDecisionCardActor,
  type PublishDecisionCardState,
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

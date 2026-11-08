import "server-only";

import { reconstructThreadPayload } from "@/lib/assistant-thread-store";
import { loadChatThreadForActorAccess } from "@/lib/chat-thread-store";
import { evaluateChatThreadAccess } from "@/lib/chat-thread-access";

// ---------------------------------------------------------------------------
// THE THREAD READ, ONE FUNCTION FOR EVERY CALLER (cinatra#4453).
//
// The thread read route (`GET /api/assistants/threads/[threadId]`, through
// `assistant-thread-http.ts`) and the /chat route's server render, which names
// the thread in the breadcrumb, both read a thread through this function. A
// thread's title is a disclosure, so the render may name a thread only where the
// read route would return it; one function is how the two cannot drift.
//
// THE RULE, in order:
//   1. ACCESS: the shared owner / team / admin / legacy-ownerless matrix
//      (`evaluateChatThreadAccess`) over the row's access axes.
//   2. DURABLE CONTENT (the PR2 cutover, cinatra#1037 P5.6): the payload is
//      reconstructed from the structured store. A thread with no durable turn
//      content (a content-less mirror shadow minted before PR1 EXPAND, or an
//      empty thread) reconstructs to null and is treated as NOT FOUND, matching
//      the list-path exclusion.
//
// A refusal, a missing row and a thread with no durable content all answer
// `null`, so a caller cannot tell them apart and a thread's existence is never
// disclosed across tenants.
// ---------------------------------------------------------------------------
export function readAssistantThreadPayloadForActor(input: {
  threadId: string;
  actorUserId: string;
  isPlatformAdmin: boolean;
}): Record<string, unknown> | null {
  const { threadId, actorUserId, isPlatformAdmin: admin } = input;
  const info = loadChatThreadForActorAccess({ threadId, actorUserId, isPlatformAdmin: admin });
  if (!info) return null;
  const allowed = evaluateChatThreadAccess({
    ownerUserId: info.ownerUserId,
    teamId: info.teamId,
    actorUserId,
    isPlatformAdmin: admin,
    isActorTeamMember: info.isActorTeamMember,
  });
  if (!allowed) return null;
  return reconstructThreadPayload(threadId);
}

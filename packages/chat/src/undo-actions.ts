"use server";

import { requireAuthSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { recentUndoableChangeSetFor } from "@/lib/chat/undo-candidate-surface";

// The COOKIE entry to the chat-side undo read. After an `agent_run` tool call
// the chip asks whether that run left a recent CLOSED, restorable change-set
// this reader may reverse, and deep-links to the URL-addressable restore modal
// (?openRestore=1) — which enforces its own per-event restore authz on open and
// on confirm. Org-scoped; orgless → null.
//
// §VI eligibility (design@94cfbcf5): the chip renders ONLY for an actor eligible
// to restore the candidate change-set — per-object-authorized for every affected
// object, no administrator bypass. An ineligible actor is returned null, so no
// chip appears and no deep link can dead-end on the not-authorized panel.
//
// cinatra#2683 (epic #2564 S8f) MOVED THE LOGIC OUT and left the door, for the
// reason its sibling states: the widget renders the same chip and cannot present
// a cookie. The window, the query and the eligibility gate live in
// `@/lib/chat/undo-candidate-surface`; the widget's door is
// `/api/chat/undo-candidate`. One gate, two credentials.

export async function recentUndoableChangeSetForRunAction(input: {
  runId: string;
}): Promise<{ changeSetId: string } | null> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) return null;
  const orgRole = await resolveOrgRoleForSession(session);
  return recentUndoableChangeSetFor({
    runId: input.runId,
    orgId,
    actor: actorFromSession(session),
    roleHints: orgRole ? { orgRole } : undefined,
  });
}

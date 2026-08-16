import "server-only";

// ---------------------------------------------------------------------------
// THE undo-chip candidate read — one implementation, two credentials
// (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// After an `agent_run` tool call the chat asks one question: did this run leave a
// CLOSED, restorable change-set this reader is still allowed to reverse? A `yes`
// draws the "Undo last action" chip, which deep-links to the URL-addressable
// restore modal; a `no` draws nothing.
//
// It used to be a COOKIE-bound server action, so on the widget it fired from a
// frame that is same-origin to the app and would have answered for whoever else
// is signed in on that browser — and the answer is a change-set id, an
// identifier for somebody else's data, rendered into a deep link inside a
// third-party site's chrome. The chip was therefore fail-closed there.
//
// The logic moves here and takes its principal as an argument. The cookie entry
// (`packages/chat/src/undo-actions.ts`) passes the session's org and actor; the
// widget entry (`/api/chat/undo-candidate`) passes the WIDGET PRINCIPAL's org and
// the S8a FULL actor. One window, one query, ONE §VI eligibility gate.
//
// WHAT DOES NOT MOVE, AND MUST NOT. The UNDO ITSELF. The chip has never
// performed a restore — it links to the first-party restore surface, which runs
// its own per-event authorization on open and again on confirm. On the widget
// that link opens in a new tab under the reader's own session (the column's
// shared link policy), so the restore still travels exactly the code it always
// did, as exactly the person it always did. Nothing about restoring becomes
// reachable with a broker credential.
// ---------------------------------------------------------------------------

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorRoleHints } from "@/lib/authz/build-actor-context";
import { listChangeSets } from "@/lib/object-history";
import { loadAuthorizedTargetedRestoreForActor } from "@/lib/object-history/restore-eligibility";

/** The chip's window: only a change-set CLOSED in the last few minutes, so an
 *  in-flight mutation is never offered (the documented race mitigation). */
export const CHAT_UNDO_WINDOW_MINUTES = 5;

/**
 * Does this principal hold the platform-admin tier? (cinatra#2701, epic #2699.)
 *
 * Read tolerantly from BOTH shapes the two doors produce, because they stamp it
 * differently and neither is wrong: the widget door's S8a actor carries the
 * trusted `platformRole` claim, while the cookie door's `actorFromSession`
 * carries the translated `roles` list ("admin" → "platform_admin"). The
 * `roleHints` a caller forwards is honoured too, for a caller that has already
 * resolved the tier.
 *
 * Deliberately NOT folded into the §VI per-object gate below, which stays
 * exactly as it was — an admin still gets no per-object bypass there. This is a
 * separate, additional condition about REACHABILITY of the surface the chip
 * links to.
 */
function isPlatformAdminPrincipal(
  actor: PrimitiveActorContext,
  roleHints: ActorRoleHints | undefined,
): boolean {
  if (roleHints?.platformRole === "platform_admin") return true;
  if (actor.platformRole === "platform_admin") return true;
  const roles = (actor as { roles?: unknown }).roles;
  return Array.isArray(roles) && roles.includes("platform_admin");
}

/**
 * The most recent undoable change-set this run produced, for THIS actor — or
 * null, which is what an ineligible actor and an absent change-set both look
 * like. §VI: an ineligible actor renders no chip, so no deep link can dead-end
 * on the not-authorized panel, and the absence carries no signal about which of
 * the two it was.
 */
export async function recentUndoableChangeSetFor(input: {
  runId: string;
  orgId: string;
  actor: PrimitiveActorContext;
  roleHints: ActorRoleHints | undefined;
}): Promise<{ changeSetId: string } | null> {
  if (!input.runId || !input.orgId) return null;
  // ALIGNED AFFORDANCE (cinatra#2701, epic #2699 S2). The chip's only act is to
  // link to `/configuration/artifacts/restore/...`, and that whole segment is
  // admin-only now (S1, #2700) — so a non-admin must be offered no chip. Gating
  // HERE keeps the promise this module was built on: one implementation, two
  // credentials, so the widget and `/chat` can never diverge. It also keeps the
  // answer's discretion intact — a non-admin still learns nothing about whether
  // a change-set exists, because "no" looks identical either way.
  if (!isPlatformAdminPrincipal(input.actor, input.roleHints)) return null;
  const closedAtAfter = new Date(
    Date.now() - CHAT_UNDO_WINDOW_MINUTES * 60_000,
  ).toISOString();
  const items = listChangeSets({
    orgId: input.orgId,
    runId: input.runId,
    closedAtAfter,
    restorable: true,
    limit: 1,
  });
  const cs = items[0];
  if (!cs) return null;
  const resolution = await loadAuthorizedTargetedRestoreForActor({
    changeSetId: cs.id,
    orgId: input.orgId,
    actor: input.actor,
    roleHints: input.roleHints,
  });
  // The chip needs the verdict only, never the reason — an entry affordance that
  // distinguished "gone" from "not yours" would leak what the gate withholds.
  const eligible = resolution.kind === "authorized";
  return eligible ? { changeSetId: cs.id } : null;
}

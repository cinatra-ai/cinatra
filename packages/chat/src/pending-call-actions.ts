"use server";

// The COOKIE entry to the destructive-confirmation cards (cinatra#2020 design
// §6.1, PR-4) — the chat package's established server surface (the actions.ts
// precedent).
//
// cinatra#2683 (epic #2564 S8f) MOVED THE LOGIC OUT and left the door. The cards
// now render on the widget too, and a server action cannot carry a host
// credential — it resolves its identity from the ambient session, which inside
// the embed frame (same-origin to the app) is whoever else is signed in on that
// browser. So the list query, the decision-token mint and the executor call live
// in `@/lib/chat/pending-tool-call-surface`, which takes its principal as an
// argument, and there are two doors onto it: this one, and the widget's
// `/api/chat/pending-tool-calls`. One implementation, two credentials — never
// two implementations.
//
// WHAT THIS FILE STILL OWNS, and it is the only thing it owns: proving WHO is
// asking from the live cookie session. Everything after that is shared.

import {
  requireActorContext,
  requireAuthSession,
} from "@/lib/auth-session";
import {
  decidePendingToolCallFor,
  listPendingToolCallsFor,
  type PendingToolConfirmationRow,
} from "@/lib/chat/pending-tool-call-surface";
import type { PendingCallDecisionAction } from "@/lib/connector-instance-pending-call-decision-token";
import type { PendingCallDecisionResult } from "@/lib/connector-instance-pending-call-executor";

// NO TYPE RE-EXPORT HERE, and the reason is a runtime one (cinatra#2683).
//
// This file carries "use server", so the actions loader enumerates its exports
// and registers each one as a server reference. Under the dev bundler that
// enumeration is taken from the export list BEFORE the type erasure pass, so a
// re-exported TYPE became a value binding that nothing defines — and the whole
// actions module for `/chat` failed to evaluate with `ReferenceError:
// PendingToolConfirmationRow is not defined`. Every server action on the page
// answered 500 with it: send, rename, delete, decide. A "use server" module may
// export async functions and nothing else, so `PendingToolConfirmationRow` is
// imported from its one home (`@/lib/chat/pending-tool-call-surface`) by every
// consumer instead of being passed through this door.

type SessionShape = {
  user: { id: string };
  session?: { id?: string; activeOrganizationId?: string | null } | null;
};

function sessionIds(session: SessionShape): {
  userId: string;
  orgId: string | null;
  sessionId: string | null;
} {
  return {
    userId: session.user.id,
    orgId: session.session?.activeOrganizationId ?? null,
    sessionId: session.session?.id ?? null,
  };
}

/**
 * The `(org, user)`-scoped card list (§6.1) for the cookie session.
 *
 * `canDecide: true` — a cookie session that can read the card is the session
 * that can decide it, which is the behaviour this surface has always had. The
 * read/decide split is a WIDGET property, where consent is per capability.
 */
export async function listPendingToolConfirmations(): Promise<{
  rows: PendingToolConfirmationRow[];
}> {
  const session = (await requireAuthSession()) as unknown as SessionShape;
  const { userId, orgId, sessionId } = sessionIds(session);
  if (!orgId || !sessionId) return { rows: [] };
  return listPendingToolCallsFor({ userId, orgId, sessionId }, { canDecide: true });
}

/**
 * Decide one pending call (§4.2 step 1 lives here: the LIVE cookie session +
 * actor; everything after is the shared surface's and the executor's). Refusals
 * are opaque — the audit trail carries the reason.
 */
export async function decidePendingToolCall(
  pendingCallId: string,
  action: PendingCallDecisionAction,
  token: string,
): Promise<PendingCallDecisionResult> {
  const session = (await requireAuthSession()) as unknown as SessionShape;
  const { userId, orgId, sessionId } = sessionIds(session);
  if (!orgId || !sessionId) return { outcome: "refused" };
  const actor = await requireActorContext();
  return decidePendingToolCallFor({
    pendingCallId,
    action,
    token,
    principal: { userId, orgId, sessionId },
    actor,
  });
}

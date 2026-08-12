import "server-only";

import { z } from "zod";

import { requireActorContext, requireAuthSession } from "@/lib/auth-session";
import {
  decidePendingToolCallFor,
  listPendingToolCallsFor,
  type PendingToolCallPrincipal,
} from "@/lib/chat/pending-tool-call-surface";
import {
  authenticateWidgetConversationRequest,
  isWidgetBranchRequest,
} from "@/lib/widget-conversation-door";
import {
  WIDGET_PENDING_CALLS_DECIDE_GRANT,
  WIDGET_PENDING_CALLS_READ_GRANT,
} from "@/lib/widget-conversation-grants";
import { WIDGET_TOOL_CONFIRM_SCOPE } from "@/lib/widget-lifecycle-scope";
import type { ActorContext } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// /api/chat/pending-tool-calls — the parked destructive-call cards, reachable
// with EITHER credential (cinatra#2683, epic #2564 S8f).
//
//   GET  — the caller's own parked calls, with fresh decision tokens.
//   POST — one decision (confirm / deny / cancel).
//
// WHY A ROUTE AT ALL. `/chat` reaches this surface through a server action, and
// a server action cannot carry a host credential: it resolves its identity from
// the ambient session, which on the widget frame — same-origin to the app — is
// whoever else is signed in on that browser. The widget therefore needs a door
// it can present a `cwu_` at. It does NOT need a second implementation, and it
// does not get one: both branches call `@/lib/chat/pending-tool-call-surface`,
// which owns the list query, the token mint and the executor call.
//
// TWO AUTH BRANCHES, AND THE PATTERN IS `/api/lifecycle-views/decide`'s EXACTLY:
//
//   · COOKIE SESSION — a first-party caller, authorized as it always was.
//   · BROKER `cwu_` — the site widget. Its actor is the S8a FULL actor, built by
//     the ONE door, consumed at THIS route's audience with the operation's own
//     scope required. The list needs `conversation.read`; the DECISION needs
//     `tools.confirm`, a separate grant, because confirming a parked destructive
//     call is a separate thing to consent to.
//
// THE BRANCH IS DECIDED BY THE PRESENTED CREDENTIAL AND NEVER FALLS BACK. A
// request carrying the widget user-token header is a widget request; a failed
// widget consume 401s rather than dropping to the ambient cookie this route's
// own origin would happily supply.
//
// A REFUSAL NAMES NOTHING. The list answers with the caller's rows or an empty
// list; a decision answers with the executor's own uniform `refused` outcome for
// a bad token, a foreign row, a stale card and an unknown action alike. Only a
// malformed body (400) and an unauthenticated caller (401) are distinguishable,
// and neither depends on which rows exist.
//
// §3.D IS UNTOUCHED — the decision travels the stage-4 executor, which owns the
// token verify, the ownership check, the exactly-once consume CAS and the
// governed re-invoke, unchanged.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decideSchema = z
  .object({
    pendingCallId: z.string().min(1).max(200),
    action: z.enum(["confirm", "deny", "cancel"]),
    token: z.string().min(1).max(4096),
  })
  .strict();

type SessionShape = {
  user: { id: string };
  session?: { id?: string; activeOrganizationId?: string | null } | null;
};

/** The authenticated caller, whichever door they came through. */
type Caller = { principal: PendingToolCallPrincipal; actor: ActorContext; canDecide: boolean };

/** The cookie caller. A session without an org or a session id cannot anchor a
 *  decision token, so it resolves to no caller rather than a partial one. */
async function cookieCaller(): Promise<Caller | null> {
  const session = (await requireAuthSession().catch(() => null)) as SessionShape | null;
  if (!session?.user?.id) return null;
  const orgId = session.session?.activeOrganizationId ?? null;
  const sessionId = session.session?.id ?? null;
  if (!orgId || !sessionId) return null;
  const actor = await requireActorContext().catch(() => null);
  if (!actor) return null;
  return {
    principal: { userId: session.user.id, orgId, sessionId },
    actor,
    // A cookie session that can read the card is the session that can decide it —
    // the behaviour `/chat` has always had. The split exists only where consent
    // is per capability, which is the widget.
    canDecide: true,
  };
}

/**
 * The widget caller, under the grant this OPERATION requires.
 *
 * `sessionId` is the `cwu_` jti: one widget login, one identity, dead when the
 * token expires. That keeps the decision token's `sid` binding real on a surface
 * with no cookie — a token exfiltrated from one widget session cannot decide in
 * another — rather than dropping the binding for the surface that needs it most.
 */
async function widgetCaller(
  request: Request,
  grant: typeof WIDGET_PENDING_CALLS_READ_GRANT | typeof WIDGET_PENDING_CALLS_DECIDE_GRANT,
): Promise<Caller | null> {
  const authed = await authenticateWidgetConversationRequest(request, grant);
  if (!authed) return null;
  const { claims } = authed;
  return {
    principal: { userId: claims.userId, orgId: claims.orgId, sessionId: claims.jti },
    actor: authed.kernelActor,
    // The list is served under `conversation.read`; whether this session may also
    // DECIDE is a second grant, read off the same consume's own claims so the two
    // can never disagree. Without it the cards are shown with NO decision tokens.
    canDecide: claims.grantedScopes.includes(WIDGET_TOOL_CONFIRM_SCOPE),
  };
}

export async function GET(request: Request): Promise<Response> {
  const caller = isWidgetBranchRequest(request)
    ? await widgetCaller(request, WIDGET_PENDING_CALLS_READ_GRANT)
    : await cookieCaller();
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { rows } = await listPendingToolCallsFor(caller.principal, {
    canDecide: caller.canDecide,
  });
  return Response.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  // The DECIDE grant, not the read grant: reaching the surface is not authority
  // to act on it. A widget session holding only `conversation.read` fails the
  // consume here and is refused exactly like a caller with no credential.
  const caller = isWidgetBranchRequest(request)
    ? await widgetCaller(request, WIDGET_PENDING_CALLS_DECIDE_GRANT)
    : await cookieCaller();
  if (!caller) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = decideSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid decision request" }, { status: 400 });
  }

  const outcome = await decidePendingToolCallFor({
    pendingCallId: parsed.data.pendingCallId,
    action: parsed.data.action,
    token: parsed.data.token,
    principal: caller.principal,
    actor: caller.actor,
  });
  return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
}

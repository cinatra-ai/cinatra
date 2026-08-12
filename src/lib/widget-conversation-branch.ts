import "server-only";

// ---------------------------------------------------------------------------
// THE WIDGET BRANCH DOOR for the conversation column's data paths
// (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// S8f made `/chat` and the widget render ONE conversation column. Six of its
// affordances still failed closed on the widget, and always for the same reason:
// the data path behind them resolved its identity from an ambient cookie. The
// embed frame is SAME-ORIGIN to the Cinatra app, so a cookie-borne request from
// it is answered as whoever else is signed in on that browser — not as the
// person who signed the widget in. Fixing the column would have fixed nothing.
//
// This module is the ONE door those paths now open instead. It is the
// `/api/lifecycle-views/{resolve,decide}` branch (cinatra#2577 / #2575), lifted
// out of those two routes rather than copied a further six times: the properties
// that make it safe are properties of the DOOR, and a door written six times is
// six doors that can drift.
//
// WHAT IT DOES, IN ORDER, AND EVERY STEP CAN ONLY NARROW:
//
//   1. THE DISCRIMINANT IS THE HEADER'S PRESENCE, never whether its value looks
//      usable. Selecting the widget branch only for a non-empty token would send
//      a request that DID declare itself a widget — with an empty value — down
//      the session branch, where an ambient cookie answers it as somebody else.
//      A caller that declares itself a widget is a widget, and a widget whose
//      token is unusable is REFUSED.
//   2. NO SESSION FALLBACK, anywhere behind a failed widget consume. This is the
//      auth-confusion guard the turn endpoint and both lifecycle entries carry,
//      and it matters most on exactly these routes, which are same-origin to the
//      frame.
//   3. THE ACTOR IS THE S8a FULL ACTOR — the person's live org role, teams and
//      project grants, resolved for the org the TOKEN is bound to, with platform
//      standing floored. Not the degraded chat-turn runtime actor: a read
//      authorized against empty grants does not fail safe, it fails WRONG, and
//      hides work its reader is entitled to.
//   4. THE GRANT IS EXPLICIT per entry — (audience, scope) — so a session that
//      signed in before a capability existed holds neither and dies at the
//      consume (AC-1).
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not authorize the OPERATION. Every
// caller takes the returned actor into the SAME server module the first-party
// surface uses and gets the same per-row answer. This door decides who is
// asking; it never decides what they may have.
//
// §3.D IS UNTOUCHED. Nothing here decides, schedules or mutates anything.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THIS MODULE IS REACHED DYNAMICALLY, NEVER STATICALLY (route-graph discipline).
//
// The ladder below pulls `widget-user-auth`'s synchronous postgres leaf, the
// connect-sites reader and the authz kernel — dozens of modules that a
// FIRST-PARTY request never executes, because it presents no `cwu_` to consume.
// Statically importing it from a route would put all of them on that route's
// graph, which is the same cost S8d split the live-standing leaf out to avoid.
//
// So routes import the LIGHT door (`@/lib/widget-conversation-door`), which
// reads one header and — only when a widget declares itself — `await import()`s
// this module. Nothing about the auth changes; only when it is loaded.
// ---------------------------------------------------------------------------

import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import {
  resolveWidgetLifecycleActorContext,
  type WidgetTokenGrant,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import {
  WIDGET_ASSISTANT_HEADER,
  WIDGET_ORIGIN_HEADER,
  WIDGET_USER_TOKEN_HEADER,
  type WidgetConversationCaller,
} from "@/lib/widget-conversation-door";

/**
 * Authenticate the widget branch of a conversation route.
 *
 * Returns `null` for EVERY failure — an unusable bearer, an unknown handle, a
 * rejected token, a revoked membership — because the caller turns all of them
 * into the one refusal a missing credential produces. Distinguishing them on the
 * wire would make the endpoint an oracle for facts (which handles exist, which
 * tokens are live) the caller has no standing to learn.
 */
export async function authenticateWidgetConversationRequest(
  request: Request,
  grant: WidgetTokenGrant,
): Promise<WidgetConversationCaller | null> {
  const presented = request.headers.get(WIDGET_USER_TOKEN_HEADER);
  if (presented === null) return null;
  const token = presented.trim();
  // An empty/whitespace bearer is refused HERE rather than left to the verifier.
  // The verifier would refuse it too, but a branch that hands an empty string to
  // a token verifier is one rename away from handing it to something forgiving.
  // The two failures that happen BEFORE the actor door are audited here, because
  // the door never runs for them and an attempt that leaves no record at all is
  // the wrong kind of silence. No identifiers: the handle is caller input and the
  // token is a secret, so the row carries neither.
  if (token.length === 0) {
    emitWidgetAuthAudit(grant.auditRejected, { reason: "no_bearer" });
    return null;
  }
  const handle = request.headers.get(WIDGET_ASSISTANT_HEADER)?.trim().toLowerCase() ?? "";
  const binding = resolveAssistantWidgetBinding(handle);
  if (!binding) {
    emitWidgetAuthAudit(grant.auditRejected, { reason: "unknown_handle" });
    return null;
  }
  const resolved = await resolveWidgetLifecycleActorContext({
    token,
    agentSlug: binding.agentSlug,
    requestOrigin: request.headers.get(WIDGET_ORIGIN_HEADER),
    grant,
  });
  if (!resolved.ok) return null;
  // Defensive: the door already refuses an unbound principal, but every per-row
  // check below anchors on these two values, so a route must never receive a
  // caller it cannot scope.
  if (!resolved.claims.userId || !resolved.claims.orgId) return null;
  return {
    actorCtx: resolved.actorCtx,
    claims: resolved.claims,
    // The kernel shape, built HERE so a route never has to import the builder —
    // and so the actor a `can()` check sees is the one this door resolved, not a
    // second assembly of the same person.
    kernelActor: buildActorContextFromPrimitive(
      resolved.actorCtx.actor,
      resolved.actorCtx.orgId,
      resolved.actorCtx.roleHints,
    ),
  };
}

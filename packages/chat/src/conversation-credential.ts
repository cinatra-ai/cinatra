"use client";

// ---------------------------------------------------------------------------
// THE credential a conversation affordance asks with (cinatra#2683, epic #2564
// S8f).
// ---------------------------------------------------------------------------
// Two of the column's affordances — the parked destructive-call cards and the
// undo chip — do not just render a transcript: they ASK THE SERVER something,
// and until this slice they could only ask one way, with a cookie. That made
// them fail closed on the widget, because the embed frame is same-origin to the
// Cinatra app and a cookie request from it is answered as whoever else is signed
// in on that browser.
//
// They now ask with whichever credential the host declared, and this hook is the
// ONE place that reads it. Three answers, and the third is the reason this is a
// hook and not a boolean:
//
//   · COOKIE   — a well-formed first-party host. Use the server action, exactly
//                as `/chat` always has.
//   · BROKER   — a well-formed non-cookie host with a declared credential (the
//                widget). Use the route, with headers built at call time and
//                `credentials: "omit"`.
//   · REFUSED  — anything else: no host declared at all, or a non-cookie
//                declaration the lifecycle runtime REFUSED (a dropped `auth`
//                prop, a cookie-bearing "broker"). Ask NOTHING. This is the
//                fail-closed default S8f established and it does not move: an
//                unclear surface issues no request, rather than picking the one
//                that would answer as somebody else.
//
// WHY IT IS NOT "IS THIS A BROKER SURFACE?". Because that question has the wrong
// shape for a THREE-state world: a mis-wired widget mount exposes no credential,
// and a boolean forces it into one of the two working answers — the cookie one,
// which is precisely the ambient-session fallback the contract forbids. Asking
// for the credential itself means the broken case has its own name and its own
// (silent) behaviour.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import {
  useCookieSessionSurface,
  useLifecycleCardAuth,
  type LifecycleCardAuth,
} from "@cinatra-ai/agents/lifecycle-card-runtime";

export type ConversationCredential =
  | { kind: "cookie" }
  | { kind: "broker"; auth: LifecycleCardAuth }
  | { kind: "refused" };

/**
 * The answer is MEMOIZED on the two context values it derives from, and that is
 * load-bearing rather than tidy: its consumers put it in a `useCallback`
 * dependency list, and a fresh object every render would make their loaders new
 * every render — so a mount-effect refresh would re-fire on every render, which
 * is a polling loop against the server, not a mount load.
 */
export function useConversationCredential(): ConversationCredential {
  const cookie = useCookieSessionSurface();
  const auth = useLifecycleCardAuth();
  return useMemo<ConversationCredential>(() => {
    if (cookie) return { kind: "cookie" };
    if (auth) return { kind: "broker", auth };
    return { kind: "refused" };
  }, [cookie, auth]);
}

/** The fetch init a brokered call is made with. One definition, so a caller
 *  cannot forget `credentials` and send the cookie it must not send. */
export function brokerRequestInit(
  auth: LifecycleCardAuth,
  init: RequestInit = {},
): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...auth.headers(),
    },
    credentials: auth.credentials,
  };
}

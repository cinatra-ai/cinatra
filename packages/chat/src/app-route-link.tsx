"use client";

// ---------------------------------------------------------------------------
// LINK POLICY for the one conversation column (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
// A first-party route link — a sender's profile, an in-app path an error message
// names, the "Update your OpenAI API key →" call to action — navigates IN PLACE
// on `/chat`. That is right there and wrong inside the widget: the same column
// now renders inside `/embed/assistant`, which is an iframe on somebody else's
// site under `sandbox="allow-scripts allow-same-origin"`. A same-tab navigation
// there either replaces the assistant with a full Cinatra page inside a tiny
// panel, or — for a top-level navigation — is refused by the sandbox outright.
// Either way the reader loses the conversation to reach a page they cannot use.
//
// So the DESTINATION is unchanged and the TARGET adapts: on a brokered surface a
// first-party route opens in a new tab, where it is a real Cinatra page with the
// reader's own session.
//
// IT KEYS OFF THE EXISTING HOST-ADAPTATION SEAM, not a new per-surface flag. The
// lifecycle-card runtime already answers "which host is this subtree, and does it
// carry a broker credential", and it answers fail-closed. Reading it here means
// the link policy cannot disagree with the credential policy, and a future host
// declares itself ONCE.
//
// NOTE THE ASYMMETRY, DELIBERATELY: an EXTERNAL link is already `_blank` on both
// surfaces, so this component only ever widens an in-app link's target. It never
// narrows one, never rewrites an href, and never suppresses a link.
// ---------------------------------------------------------------------------

import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import {
  useCookieSessionSurface,
  useLifecycleCardAuth,
} from "@cinatra-ai/agents/lifecycle-card-runtime";

/**
 * True when this subtree is NOT a first-party cookie session — the site widget,
 * and anything else that has not declared itself a cookie host.
 *
 * DELIBERATELY THE NEGATION OF THE COOKIE ANSWER, not "does it carry a broker
 * credential" (codex round 1, finding 1). Reading the credential would make an
 * INVALID broker declaration — one the lifecycle runtime refused, so it exposes
 * no auth — indistinguishable from a first-party page, and the cookie-bound
 * affordances gated on this would then fire from inside the widget frame, which
 * is same-origin to the app: the server would answer, and record decisions, as
 * whoever else is signed in on that browser. Asking the cookie question instead
 * makes every unclear case fail closed.
 */
export function useBrokeredSurface(): boolean {
  return !useCookieSessionSurface();
}

/**
 * True when this subtree renders under a DECLARED, valid broker credential —
 * i.e. the widget frame, actually wired.
 *
 * NOT the same question as `useBrokeredSurface`, and deliberately defaulted the
 * other way, because the two guard different risks:
 *
 *   · a cookie-bound REQUEST fired from the wrong surface leaks or mutates
 *     another person's data, so its guard must refuse whenever the surface is
 *     unclear — `useBrokeredSurface`;
 *   · a LINK's target is cosmetic. Defaulting THAT to "not first party" would
 *     turn every same-tab in-app link into a new tab on any first-party surface
 *     that renders a chat error card outside a lifecycle-host declaration —
 *     changing behaviour nobody asked to change, to protect against nothing.
 *
 * So the link policy widens only where the broker credential says, positively,
 * "this is the widget".
 */
export function useBrokerCredentialSurface(): boolean {
  return useLifecycleCardAuth() !== null;
}

export type AppRouteLinkProps = Omit<ComponentProps<typeof Link>, "children"> & {
  children: ReactNode;
};

/**
 * A `next/link` to a FIRST-PARTY app route, with the host's link policy applied.
 * Use it anywhere the conversation column links into the Cinatra app; keep using
 * a plain anchor/Link for links that are already external.
 */
export function AppRouteLink({ children, ...props }: AppRouteLinkProps) {
  const brokered = useBrokerCredentialSurface();
  return (
    <Link
      {...props}
      {...(brokered ? { target: "_blank", rel: "noreferrer noopener" } : {})}
    >
      {children}
    </Link>
  );
}

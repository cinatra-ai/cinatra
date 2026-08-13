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
import { useLifecycleCardAuth } from "@cinatra-ai/agents/lifecycle-card-runtime";

/**
 * REMOVED in the second half of S8f (cinatra#2683). `useBrokeredSurface()` was a
 * BOOLEAN — "not a first-party cookie session" — and it existed only to switch
 * cookie-bound affordances OFF where a cookie could not be trusted. Now that
 * those affordances ask with whichever credential the host declared, the
 * question they need is not a boolean: a mis-wired mount that exposes no
 * credential must behave differently from BOTH working surfaces, and a boolean
 * has nowhere to put it. `useConversationCredential()`
 * (`./conversation-credential`) answers with three states instead, and the
 * refused one still asks nothing at all.
 *
 * The link policy below keeps its own question, and keeps the opposite default,
 * for the reason it always stated.
 */

/**
 * True when this subtree renders under a DECLARED, valid broker credential —
 * i.e. the widget frame, actually wired.
 *
 * NOT the same question as `useConversationCredential`, and deliberately
 * defaulted the other way, because the two guard different risks:
 *
 *   · a REQUEST fired with the wrong credential leaks or mutates another
 *     person's data, so its guard must refuse whenever the surface is unclear;
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

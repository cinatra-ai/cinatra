import "server-only";

// Assistant SELECTOR audience gate — the DUAL-SELECTOR half of cinatra#1875 W2
// (Epic #1873 — AC#3). W1 landed the audience-filtered registry reader; AC#6
// closed the MCP entry/continuation surfaces onto it. This module closes the two
// remaining SELECTOR surfaces of `/api/assistants/chat` onto the SAME audience
// decision, so which assistant a caller may DRIVE a turn as is audience-scoped
// server-side — never trusted from the request:
//
//   1. the COOKIE-SESSION selector (`body.assistant` / `assistantPackage`): the
//      picker surfaces the caller's audience-visible set (the W1 reader), and the
//      chosen handle is re-resolved actor+audience-scoped on submit — a forged
//      out-of-audience selection 404-hides instead of dispatching.
//
//   2. the BROKER-AUTH WIDGET selector (the public-site widget path): the verified
//      end user (`WidgetPrincipal.userId`, established by the full dual-token
//      fail-closed sequence) must be IN the assistant installation's audience.
//      Grounding (#1848 OBO widget principal): the widget's site auth proves the
//      end user is a legit authenticated member of the bound org for that SITE —
//      but SITE AUTH IS NOT THE INSTALLATION'S AUDIENCE. The widget principal is
//      floored to `member` at the OBO mint (never platform-admin) and carries its
//      own `orgId` (the cwu_ claim, never session-derived), so its audience closes
//      through the SAME four membership seams as the browser reader, at the
//      member floor. Valid site auth + an out-of-audience end user ⇒ 404-hide;
//      in-audience ⇒ the protocol is byte-unchanged.
//
// There is ONE audience truth: this module delegates to the AC#6 primitive
// `isAssistantInCallerAudience`, which reads the W1 registry reader (installed
// assistants whose audience the caller satisfies, plus the always-visible builtin
// Cinatra descriptor). Membership in the visible set IS visibility. Revocation is
// evaluated at turn creation (every turn re-resolves), consistent with AC#6.

import {
  isAssistantInCallerAudience,
  type AudienceCaller,
  type AudienceClosureDeps,
  DEFAULT_AUDIENCE_CLOSURE_DEPS,
} from "@/lib/assistant-audience-closure";
import type { WidgetPrincipal } from "@/lib/assistant-runtime/widget-principal";

/**
 * The audience caller for the COOKIE-SESSION selector: the authenticated session
 * user, their active org, and their real platform role (the session picker runs
 * at the caller's true standing). A null active org resolves to `""` — the
 * context resolver then contributes only the workspace/admin/builtin grants (no
 * org/team/project membership), fail-toward-less-visibility.
 */
export function sessionSelectorCaller(
  userId: string,
  activeOrgId: string | null,
  platformRole: "platform_admin" | "member",
): AudienceCaller {
  return { userId, orgId: activeOrgId ?? "", platformRole };
}

/**
 * The audience caller for the BROKER-AUTH WIDGET selector, derived from the
 * server-verified {@link WidgetPrincipal}. platformRole is HARD-FLOORED to
 * `member` — a widget end user who is also a platform admin gets NO elevated
 * audience standing (mirrors the OBO mint floor + the runtime ActorContext floor,
 * #1848 / G5). `orgId` is the cwu_-claim org carried on the principal, never a
 * session value. Pure.
 */
export function widgetSelectorCaller(principal: WidgetPrincipal): AudienceCaller {
  return { userId: principal.userId, orgId: principal.orgId, platformRole: "member" };
}

/**
 * Is the SELECTED assistant principal within the caller's audience? Delegates to
 * the AC#6 registry-reader decision — the single audience truth for both
 * selectors. False ⇒ the caller 404-hides the selection (a forged/out-of-audience
 * pick never dispatches). `deps` is injectable for tests; the default reads the
 * live W1 registry reader.
 */
export async function isSelectedAssistantVisible(
  assistantUserId: string,
  caller: AudienceCaller,
  deps: AudienceClosureDeps = DEFAULT_AUDIENCE_CLOSURE_DEPS,
): Promise<boolean> {
  return isAssistantInCallerAudience(assistantUserId, caller, deps);
}

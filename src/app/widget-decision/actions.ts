"use server";

import { getAuthSession } from "@/lib/auth-session";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import {
  ACTION_CAPABILITY_PURPOSE_DECIDE,
  ACTION_CAPABILITY_DECIDE_ROUTE_PATH,
  mintActionCapability,
} from "@/lib/lifecycle/widget-action-capability";
import {
  actionCapabilityRowBinding,
  confirmActionCapability,
} from "@/lib/lifecycle/widget-action-capability-store";

// ---------------------------------------------------------------------------
// The CONFIRMATION (cinatra#2575, epic #2564 S8b) — the one act on the hosted
// widget-decision page, and the only thing in this slice that mints a spendable
// decision credential.
//
// WHY A SERVER ACTION AND NOT A ROUTE. It is invoked from a Cinatra-origin page
// under the person's ordinary Cinatra cookie session. That is precisely the
// authority the widget's own `cwu_` bearer does NOT carry and a CMS site can
// never obtain: a cross-origin script may open this window, but it can neither
// read it nor press the button in it, and Next's Server Action boundary carries
// its own origin check on the POST.
//
// WHY IT ADDS NOTHING TO THE BINDING. Every field of the capability was written
// down by the request endpoint, from server state, before this page ever
// rendered. This action takes ONE argument — which pending request — and reads
// everything else from that row. There is deliberately no parameter through
// which a gate, a disposition, a rationale or a principal could enter here: if
// there were, the confirmation would be confirming something the person had not
// been shown, which is the failure this whole slice exists to prevent.
//
// THE PRINCIPAL IS THE SESSION'S, NEVER THE ROW'S. The CAS matches
// `user_id = <session user>`, so a request minted for one person cannot be
// confirmed by another even if they somehow hold its id — and because it is the
// same statement that flips `confirmed_at`, there is no window between checking
// who is here and recording that they confirmed.
//
// A REFUSAL IS ONE ANSWER, with one exception. Expired, already confirmed,
// already spent, someone else's, absent: all `unavailable`. The person is told
// to go back to the assistant and try again, which is true for every one of
// them. `not_authenticated` is separate only because it names a fix the person
// can act on and discloses nothing about any request.
// ---------------------------------------------------------------------------

export type WidgetDecisionConfirmResult =
  | { ok: true; capability: string }
  | { ok: false; reason: "not_authenticated" | "unavailable" };

/**
 * Confirm a pending widget decision and mint its single-use action capability.
 *
 * The returned value is a CREDENTIAL. It is handed to the browser that pressed
 * the button and delivered from there to the Cinatra-origin opener that started
 * the flow — never to the CMS page, which the client half enforces by targeting
 * its own origin and nothing else.
 */
export async function confirmWidgetDecisionAction(
  capabilityId: string,
): Promise<WidgetDecisionConfirmResult> {
  if (typeof capabilityId !== "string" || capabilityId.length === 0 || capabilityId.length > 128) {
    return { ok: false, reason: "unavailable" };
  }

  const session = await getAuthSession();
  const userId = session?.user?.id ? String(session.user.id) : "";
  if (!userId) return { ok: false, reason: "not_authenticated" };

  // THE CAS. One statement decides both "is this person the one this request was
  // minted for" and "has anybody confirmed it yet", and re-bases the row's
  // expiry onto the short spend window.
  const row = await confirmActionCapability(capabilityId, userId);
  if (!row) {
    emitWidgetAuthAudit("widget_lifecycle_decide_request_rejected", {
      actor: userId,
      reason: "confirmation_unavailable",
    });
    return { ok: false, reason: "unavailable" };
  }

  // The purpose and audience come from the ROW, which the request endpoint wrote
  // from its own constants; the mint refuses any value it does not itself mint,
  // so a row carrying a purpose or audience this build does not have produces no
  // capability rather than an unspendable one.
  const capability = mintActionCapability(actionCapabilityRowBinding(row));
  if (!capability) {
    // The row is already burnt for confirmation and cannot be confirmed again —
    // which is correct: the person confirmed, and this host could not express
    // the credential. They go back and start a fresh decision.
    emitWidgetAuthAudit("widget_lifecycle_decide_request_rejected", {
      actor: userId,
      orgId: row.orgId,
      siteId: row.siteId,
      client: row.client,
      agentSlug: row.agentSlug,
      instanceId: row.instanceId,
      reason: "capability_mint_failed",
    });
    return { ok: false, reason: "unavailable" };
  }

  emitWidgetAuthAudit("widget_lifecycle_decide_request_authorized", {
    actor: userId,
    orgId: row.orgId,
    siteId: row.siteId,
    client: row.client,
    agentSlug: row.agentSlug,
    instanceId: row.instanceId,
    // Capability NAMES only, never the sealed value and never a row identifier:
    // this line records WHAT was confirmed, not WHICH gate.
    grantedScopes: `${ACTION_CAPABILITY_PURPOSE_DECIDE} ${ACTION_CAPABILITY_DECIDE_ROUTE_PATH}`,
    reason: row.disposition,
  });

  return { ok: true, capability };
}

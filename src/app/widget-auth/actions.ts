"use server";

import {
  getAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import {
  issueUserAuthCode,
  loadActiveTransaction,
} from "@/lib/widget-user-auth";
import {
  WIDGET_SIGNIN_GRANTED_SCOPES,
  displayedScopesAgree,
  formatTokenSet,
} from "@/lib/widget-lifecycle-scope";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

// cinatra#407 — the grant server action for the hosted /widget-auth page.
//
// cinatra#2631 (owner ruling, 2026-08-10: "treat sign in as consent"). This
// action used to be the SUBMIT of a separate consent screen — a "Continue"
// button the signed-in member had to press. That screen is gone. The action now
// runs once, unattended, the moment the signed-in member's page mounts, so a
// successful sign-in is the whole authorization: no interstitial, no click.
//
// Issues the user authorization code AFTER:
//   1. a valid session exists (the user just logged in on the hosted page, or
//      already held a Cinatra session);
//   2. the transaction is still active (single-use, unexpired);
//   3. the logged-in user is a MEMBER of the transaction's org (re-checked here
//      against txn.orgId via resolveOrgRoleForUser — NOT the session's active
//      org, which may differ).
//
// The transaction is consumed atomically inside issueUserAuthCode (single-use).
// The returned code is rendered into the return step (postMessage to the
// verified opener origin) — it is NEVER placed in a URL.
//
// The only input is the TRANSACTION ID. There is deliberately no form, no scope
// parameter and no caller-supplied grant of any kind: the recorded set is the
// server constant below, so a CMS backend, a tampered submission or a replayed
// request has no channel through which to ask for anything. What the sign-in
// screen displayed is read off the TRANSACTION, not off the request.

export type WidgetAuthGrantResult =
  | { ok: true; code: string; state: string; siteOrigin: string }
  | { ok: false; reason: string };

export async function issueWidgetAuthCodeAction(
  txnId: string,
): Promise<WidgetAuthGrantResult> {
  if (!txnId || typeof txnId !== "string") {
    return { ok: false, reason: "invalid_request" };
  }

  const session = await getAuthSession();
  if (!session) {
    emitWidgetAuthAudit("consent_denied", { reason: "no_session" });
    return { ok: false, reason: "not_authenticated" };
  }

  // Re-load the transaction (unconsumed + unexpired). A consumed/expired txn
  // here means a stale or replayed authorization.
  const txn = loadActiveTransaction(txnId);
  if (!txn) {
    emitWidgetAuthAudit("consent_denied", {
      actor: String(session.user.id),
      reason: "txn_not_found",
    });
    return { ok: false, reason: "transaction_expired" };
  }

  const userId = String(session.user.id);

  // What the sign-in screen SHOWED must match what this build would record
  // (cinatra#2631, codex rework rounds 0-1). Removing the consent screen moved
  // the display one request earlier; it did not remove the possibility that a
  // mid-rollout sign-in lands on a node whose granted set has changed. A
  // disagreement means the person read the wrong sentences, so nothing is
  // recorded and they are told to start again.
  //
  // The value is read from the TRANSACTION, written by the server when it
  // rendered that screen, so nothing in the browser can strip it. NULL therefore
  // means — provably — that no screen was rendered, which happens when the person
  // already held a Cinatra session. That case is admitted: it is the stated gap
  // of the owner's ruling, not something this check can close.
  if (!displayedScopesAgree(txn.displayedScopes, WIDGET_SIGNIN_GRANTED_SCOPES)) {
    emitWidgetAuthAudit("consent_denied", {
      actor: userId,
      orgId: txn.orgId,
      siteId: txn.siteId,
      agentSlug: txn.agentSlug,
      siteOrigin: txn.siteOrigin,
      reason: "stale_signin_screen",
    });
    return { ok: false, reason: "stale_screen" };
  }

  // Membership re-check against the TRANSACTION's org (authoritative), not the
  // session's active org. A non-member is denied — no code issued.
  const role = await resolveOrgRoleForUser(txn.orgId, userId);
  if (!role) {
    emitWidgetAuthAudit("consent_denied", {
      actor: userId,
      orgId: txn.orgId,
      siteId: txn.siteId,
      agentSlug: txn.agentSlug,
      siteOrigin: txn.siteOrigin,
      reason: "not_org_member",
    });
    return { ok: false, reason: "not_org_member" };
  }

  // Atomic single-use consume of the txn + issue the user code.
  //
  // cinatra#2574 — the granted scope set is the SERVER constant, never a value
  // that travelled with the request: what the sign-in screen names is what the
  // code records. A widget/CMS backend therefore has no way to ask for more.
  const issued = issueUserAuthCode({
    txnId,
    userId,
    grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
  });
  if (!issued.ok) {
    emitWidgetAuthAudit("consent_denied", {
      actor: userId,
      orgId: txn.orgId,
      siteId: txn.siteId,
      agentSlug: txn.agentSlug,
      reason: issued.reason,
    });
    return { ok: false, reason: "transaction_expired" };
  }

  emitWidgetAuthAudit("code_issued", {
    actor: userId,
    orgId: txn.orgId,
    siteId: txn.siteId,
    client: txn.client,
    agentSlug: txn.agentSlug,
    siteOrigin: txn.siteOrigin,
    instanceId: txn.instanceId,
    // What the sign-in granted, recorded at the moment it was granted (#2574).
    // A scope list is a capability NAME set, never a secret.
    grantedScopes: formatTokenSet(WIDGET_SIGNIN_GRANTED_SCOPES),
  });

  return { ok: true, code: issued.code, state: issued.state, siteOrigin: issued.siteOrigin };
}

"use server";

import {
  getAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import {
  issueUserAuthCode,
  loadActiveTransaction,
  widgetScreenNonceHash,
  widgetSessionFingerprint,
} from "@/lib/widget-user-auth";
import {
  WIDGET_SIGNIN_GRANTED_SCOPES,
  formatTokenSet,
  screenRecordAdmitsArrival,
  widgetNoSignInScreenToken,
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
// The inputs are the TRANSACTION ID and this arrival's SCREEN NONCE, and
// neither is a grant. There is deliberately no form, no scope parameter and no
// caller-supplied grant of any kind: the recorded set is the server constant
// below, so a CMS backend, a tampered submission or a replayed request has no
// channel through which to ask for anything. What the sign-in screen displayed
// is read off the TRANSACTION, not off the request; the nonce only decides
// whether THIS arrival may read it (cinatra#2631, rework round 7, finding 1).
// It travels as an argument because it is a secret the browser holds, and a
// wrong or missing one can only ever cause a REFUSAL.

export type WidgetAuthGrantResult =
  | { ok: true; code: string; state: string; siteOrigin: string }
  | { ok: false; reason: string };

export async function issueWidgetAuthCodeAction(
  txnId: string,
  screenNonce: string,
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
  // The value is read from the TRANSACTION, written there by the SERVER, so
  // nothing in the browser can strip it — and only two of its values are
  // knowledge (round 3, finding 1):
  //   • a real displayed set — a sign-in screen rendered and showed exactly it;
  //   • a NO-SCREEN sentinel NAMING THIS SESSION — a node running this build
  //     PROVED none rendered for this arrival (the session row was already there
  //     when the transaction row was inserted). Admitted: the person went
  //     straight to the return step, which is the stated gap of the owner's
  //     ruling, not something this check can close. One naming a DIFFERENT
  //     session is proof about somebody else and refuses (round 5, finding 1) —
  //     otherwise a member could stamp it with a bare GET and leave it standing
  //     for whoever came next through an older node's legacy screen.
  // The UNCLASSIFIED value a transaction is created with and the pre-column NULL
  // are both the ABSENCE of knowledge — nobody accounted for what was displayed,
  // which is what a legacy node's signed-out page leaves behind mid-rollout — so
  // both refuse here.
  //
  // AND WHATEVER IS RECORDED, IT MUST BE RECORDED FOR THIS ARRIVAL (round 7,
  // finding 1). Knowledge about the transaction is not knowledge about the
  // person redeeming it: two people can be walked through one unconsumed
  // transaction during a rolling deploy, and the one who read a legacy node's
  // copy must not redeem the record the other one's screen wrote. So the record
  // is admitted only to an arrival presenting the nonce it was written with —
  // a record with no nonce hash at all (one left by a node that predates this)
  // fails closed exactly like the unclassified value.
  if (
    !screenRecordAdmitsArrival(txn, WIDGET_SIGNIN_GRANTED_SCOPES, {
      presentedNonceHash: widgetScreenNonceHash(screenNonce),
      expectedNoScreenToken: widgetNoSignInScreenToken(
        widgetSessionFingerprint(session.session?.id),
      ),
    })
  ) {
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
  //
  // cinatra#2684 — the code is BOUND to THIS sign-in. The session id comes off
  // the server-read session, never off the request, so a widget token can always
  // be traced back to the one authenticated session that authorized it and dies
  // when that session does. A session the server cannot name issues nothing.
  const issued = issueUserAuthCode({
    txnId,
    userId,
    authSessionId: String(session.session?.id ?? ""),
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
    // A session the server holds but cannot NAME is not a stale transaction, and
    // saying so would send the person to retry a flow that will refuse again
    // (cinatra#2684). It is the same answer a missing session gets: sign in.
    return {
      ok: false,
      reason: issued.reason === "no_auth_session" ? "not_authenticated" : "transaction_expired",
    };
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

"use server";

import {
  getAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import {
  consumeConsentCsrfToken,
} from "@/lib/connect-provisioning";
import {
  issueUserAuthCode,
  loadActiveTransaction,
} from "@/lib/widget-user-auth";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";

// cinatra#407 — consent server action for the hosted /widget-auth page.
//
// Issues the user authorization code AFTER:
//   1. a valid session exists (the user logged in on the hosted page);
//   2. the consent CSRF token (bound to sessionId + txnId) is valid + single-use;
//   3. the logged-in user is a MEMBER of the transaction's org (re-checked here
//      against txn.orgId via resolveOrgRoleForUser — NOT the session's active
//      org, which may differ).
//
// The transaction is consumed atomically inside issueUserAuthCode (single-use).
// The returned code is rendered into the success step (postMessage to the
// verified opener origin) — it is NEVER placed in a URL.

export type ConsentActionResult =
  | { ok: true; code: string; state: string; siteOrigin: string }
  | { ok: false; reason: string };

export async function issueWidgetAuthCodeAction(
  formData: FormData,
): Promise<ConsentActionResult> {
  const txnId = String(formData.get("txn") ?? "");
  const consentCsrf = String(formData.get("consent_csrf") ?? "");

  if (!txnId) return { ok: false, reason: "invalid_request" };

  const session = await getAuthSession();
  if (!session) {
    emitWidgetAuthAudit("consent_denied", { reason: "no_session" });
    return { ok: false, reason: "not_authenticated" };
  }

  // Re-load the transaction (unconsumed + unexpired). A consumed/expired txn
  // here means a stale or replayed consent.
  const txn = loadActiveTransaction(txnId);
  if (!txn) {
    emitWidgetAuthAudit("consent_denied", { actor: String(session.user.id), reason: "txn_not_found" });
    return { ok: false, reason: "transaction_expired" };
  }

  const userId = String(session.user.id);
  const sessionId = String(session.session?.id ?? "");

  // CSRF: single-use, bound to (sessionId, txnId). Verify BEFORE the membership
  // query so a forged consent does no work.
  if (
    !consumeConsentCsrfToken({ token: consentCsrf, sessionId, requestId: txnId })
  ) {
    emitWidgetAuthAudit("consent_denied", {
      actor: userId,
      orgId: txn.orgId,
      siteId: txn.siteId,
      agentSlug: txn.agentSlug,
      reason: "bad_csrf",
    });
    return { ok: false, reason: "invalid_request" };
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
  const issued = issueUserAuthCode({ txnId, userId });
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
  });

  return { ok: true, code: issued.code, state: issued.state, siteOrigin: issued.siteOrigin };
}

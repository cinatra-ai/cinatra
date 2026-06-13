"use server";

import { redirect } from "next/navigation";

import {
  requireAuthSession,
  resolveOrgRoleForSession,
  isPlatformAdmin,
} from "@/lib/auth-session";
import {
  issueAuthorizationCode,
  validateAuthorizeParams,
  verifyConsentCsrfToken,
  consumeConsentCsrfToken,
} from "@/lib/connect-provisioning";
import { emitConnectAudit } from "@/lib/connect-audit";

// ---------------------------------------------------------------------------
// cinatra#221 — Connect consent Approve/Deny server actions.
//
// Both actions:
//   1. require the existing better-auth session (NOT a public exemption),
//   2. re-resolve the org-admin gate (org_owner | org_admin | platform_admin),
//   3. RE-VALIDATE the parameter set from the submitted hidden fields (never
//      trust the form blindly),
//   4. verify the single-use consent CSRF token bound to (sessionId,
//      requestId) — a cross-site forged POST cannot mint a code,
//   5. on Approve: issue a single-use, short-TTL code bound to the EXACT
//      validated params and 302 to redirect_uri with ?code&state,
//      on Deny: 302 with ?error=access_denied&state.
//
// The redirect_uri the action redirects to is the SAME value that passed
// validateRedirectUri (per-client callback contract path + WP action), so the
// open-redirect surface is closed: an attacker cannot point the 302 at an
// arbitrary origin.
// ---------------------------------------------------------------------------

function appendQuery(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

async function gateAndValidate(formData: FormData): Promise<{
  sessionId: string;
  adminUserId: string;
  orgId: string | null;
  params: ReturnType<typeof validateAuthorizeParams>;
  rawState: string;
}> {
  const session = await requireAuthSession();
  const orgRole = await resolveOrgRoleForSession(session);
  const authorized =
    orgRole === "org_owner" || orgRole === "org_admin" || isPlatformAdmin(session);
  if (!authorized) {
    redirect("/not-authorized");
  }
  const sessionId = String(session.session?.id ?? "");
  const adminUserId = String(session.user.id);
  const orgId = session.session?.activeOrganizationId ?? null;

  const rawState = String(formData.get("state") ?? "");
  const params = validateAuthorizeParams({
    client: String(formData.get("client") ?? ""),
    redirect_uri: String(formData.get("redirect_uri") ?? ""),
    widget_origin: String(formData.get("widget_origin") ?? ""),
    state: rawState,
    scope: String(formData.get("scope") ?? ""),
    code_challenge: String(formData.get("code_challenge") ?? ""),
    code_challenge_method: String(formData.get("code_challenge_method") ?? ""),
  });
  return { sessionId, adminUserId, orgId, params, rawState };
}

export async function approveConnectAction(formData: FormData): Promise<void> {
  const { sessionId, adminUserId, orgId, params, rawState } = await gateAndValidate(formData);
  if (!params.ok) {
    // Params no longer validate (tampered/expired) — refuse without issuing a
    // code. No safe redirect target, so render the not-authorized state.
    redirect("/not-authorized");
  }
  const csrf = String(formData.get("consent_csrf") ?? "");
  // SINGLE-USE consume on the Approve path (mints a code): a same-session replay
  // of the token is rejected (codex adversarial Medium).
  if (
    !consumeConsentCsrfToken({
      token: csrf,
      sessionId,
      requestId: params.params.requestId,
    })
  ) {
    emitConnectAudit("authorize_denied", {
      actor: adminUserId,
      orgId,
      client: params.params.client,
      redirectUri: params.params.redirectUri,
      widgetOrigin: params.params.widgetOrigin,
      reason: "csrf_failed",
    });
    redirect("/not-authorized");
  }

  const { code, codeHash } = issueAuthorizationCode({
    params: params.params,
    adminUserId,
    orgId,
  });
  emitConnectAudit("authorize_approved", {
    actor: adminUserId,
    orgId,
    client: params.params.client,
    redirectUri: params.params.redirectUri,
    widgetOrigin: params.params.widgetOrigin,
    callbackOrigin: params.params.callbackOrigin,
  });
  // code_issued logs the HASH only — never the plaintext code.
  emitConnectAudit("code_issued", {
    actor: adminUserId,
    orgId,
    client: params.params.client,
    codeHash,
  });
  // The redirect_uri already passed the strict per-client callback contract
  // (exact path + exactly-one WP `action`, no other query keys). It is NOT a
  // static-registry-allowlisted origin — by design the admin connects arbitrary
  // new sites, and the human admin on the consent screen is the allowlist. The
  // controls that close the OPEN-REDIRECT class are: scheme/userinfo/fragment/
  // CRLF rejection, the exact callback-path contract, and the per-session
  // single-use consent CSRF token (so an attacker cannot drive this 302 without
  // an org-admin actively approving on their own session). The code is short-
  // lived + single-use + PKCE-bound. URL.searchParams.set percent-encodes both
  // values. Referrer-Policy: no-referrer is set on the consent page response so
  // the code is not leaked via the Referer header on this hop.
  redirect(
    appendQuery(params.params.redirectUri, {
      code,
      state: rawState,
    }),
  );
}

export async function denyConnectAction(formData: FormData): Promise<void> {
  const { sessionId, adminUserId, orgId, params, rawState } = await gateAndValidate(formData);
  if (!params.ok) {
    redirect("/not-authorized");
  }
  // Verify the consent CSRF token on Deny too (codex Low): although Deny issues
  // no code, an unverified Deny would be a CSRFable external-redirect/denial
  // path. A forged cross-site Deny cannot drive this 302 without the bound
  // token.
  const csrf = String(formData.get("consent_csrf") ?? "");
  if (!verifyConsentCsrfToken({ token: csrf, sessionId, requestId: params.params.requestId })) {
    redirect("/not-authorized");
  }
  emitConnectAudit("authorize_denied", {
    actor: adminUserId,
    orgId,
    client: params.params.client,
    redirectUri: params.params.redirectUri,
    widgetOrigin: params.params.widgetOrigin,
    reason: "user_denied",
  });
  redirect(
    appendQuery(params.params.redirectUri, {
      error: "access_denied",
      state: rawState,
    }),
  );
}

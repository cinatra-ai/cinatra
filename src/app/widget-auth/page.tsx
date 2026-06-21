import type { Metadata } from "next";

import { getAuthSession, resolveOrgRoleForUser } from "@/lib/auth-session";
import { issueConsentCsrfToken } from "@/lib/connect-provisioning";
import { loadActiveTransaction } from "@/lib/widget-user-auth";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { Main } from "@/components/layout/main";
import { BrandMark } from "@/components/brand-mark";
import { WidgetAuthLogin } from "@/components/widget-auth/widget-auth-login";
import { WidgetAuthConsent } from "@/components/widget-auth/widget-auth-consent";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// cinatra#407 — hosted /widget-auth login (Plan B, EPIC #406).
//
// The Cinatra-hosted login the assistant widget opens (popup). It is
// LOGIN-ONLY (no signup anywhere), reuses the REAL Cinatra sign-in UI
// (AuthView + BrandMark + Main) so it inherently "looks the same" as /sign-in,
// and the widget NEVER sees raw credentials (they are typed into this
// Cinatra-origin page, not the CMS-origin DOM).
//
// The page is driven by a TRANSACTION (?txn=...) created by the
// site-token-authenticated POST /api/widget-auth/init — the verified context
// (org / siteOrigin / agent / instance) lives in the transaction, NOT the URL.
//
// States:
//   • invalid/expired txn → neutral error card (no oracle).
//   • no session          → login-only AuthView (redirects back here on login).
//   • session, non-member → deny card (not a member of the txn's org).
//   • session, member     → explicit consent → issue code → postMessage to opener.
//
// The page is on the middleware public-path exact allowlist so a SESSIONLESS
// visitor is NOT 307'd to /sign-in (it must render the login form here); a
// PRESENT session is still read normally via getAuthSession().
// ---------------------------------------------------------------------------

const CLIENT_LABELS: Record<string, string> = {
  wordpress: "WordPress",
  drupal: "Drupal",
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Main className="flex min-h-screen items-start justify-center pt-10">
      <div className="flex w-full max-w-md flex-col items-center">
        <div className="mb-8 flex items-center">
          <BrandMark size={30} />
        </div>
        {children}
      </div>
    </Main>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Shell>
      <div className="grid gap-3 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Cannot sign in
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">{message}</p>
      </div>
    </Shell>
  );
}

export default async function WidgetAuthPage({ searchParams }: Props) {
  const sp = await searchParams;
  const txnId = first(sp.txn);

  const txn = loadActiveTransaction(txnId);
  if (!txn) {
    emitWidgetAuthAudit("page_invalid_txn", {});
    return (
      <ErrorCard message="This sign-in request is invalid or has expired. Open the assistant login again from your site." />
    );
  }

  const clientLabel = CLIENT_LABELS[txn.client] ?? txn.client;
  const redirectTo = `/widget-auth?txn=${encodeURIComponent(txn.txnId)}`;

  const session = await getAuthSession();

  // No session → render the login-only view. After credential login Better Auth
  // sets the cookie and redirects back here; the session branch then continues.
  if (!session) {
    emitWidgetAuthAudit("page_viewed", {
      siteId: txn.siteId,
      orgId: txn.orgId,
      client: txn.client,
      agentSlug: txn.agentSlug,
      siteOrigin: txn.siteOrigin,
      reason: "login",
    });
    return (
      <Shell>
        <WidgetAuthLogin redirectTo={redirectTo} />
      </Shell>
    );
  }

  const userId = String(session.user.id);

  // Membership re-check against the TRANSACTION's org (authoritative). A
  // non-member cannot proceed — no code, no consent step.
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
    return (
      <ErrorCard message="Your account is not a member of the organization connected to this site, so it cannot be used in this assistant." />
    );
  }

  // Member → explicit consent. The consent CSRF is bound to (sessionId, txnId)
  // and is single-use; the server action re-validates everything before issuing.
  const sessionId = String(session.session?.id ?? "");
  const consentCsrf = issueConsentCsrfToken({ sessionId, requestId: txn.txnId });

  emitWidgetAuthAudit("page_viewed", {
    actor: userId,
    siteId: txn.siteId,
    orgId: txn.orgId,
    client: txn.client,
    agentSlug: txn.agentSlug,
    siteOrigin: txn.siteOrigin,
    reason: "consent",
  });

  return (
    <Shell>
      <div className="grid w-full gap-5">
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Continue to the assistant
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as {session.user.email}
          </p>
        </div>
        <WidgetAuthConsent
          txnId={txn.txnId}
          consentCsrf={consentCsrf}
          siteOrigin={txn.siteOrigin}
          clientLabel={clientLabel}
        />
      </div>
    </Shell>
  );
}

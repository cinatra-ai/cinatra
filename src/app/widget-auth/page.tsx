import type { Metadata } from "next";

import { getAuthSession, resolveOrgRoleForUser } from "@/lib/auth-session";
import {
  loadActiveTransaction,
  recordDisplayedScopesForTransaction,
} from "@/lib/widget-user-auth";
import {
  WIDGET_EXTENSION_SCOPES,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  widgetDisplayedScopesToken,
} from "@/lib/widget-lifecycle-scope";
import { emitWidgetAuthAudit } from "@/lib/widget-auth-audit";
import { Main } from "@/components/layout/main";
import { BrandMark } from "@/components/brand-mark";
import { WidgetAuthLogin } from "@/components/widget-auth/widget-auth-login";
import { WidgetAuthGrant } from "@/components/widget-auth/widget-auth-grant";

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
// cinatra#2631 — OWNER RULING (2026-08-10): "treat sign in as consent." The
// separate consent step this page used to render — a card headed "Continue to
// the assistant" with a Continue button — is GONE. Signing in is the whole
// authorization: the sign-in screen names what it grants, and a signed-in member
// goes straight to the return step, which records the grant and hands the code
// back to the site.
//
// SAID PRECISELY, because it is easy to overstate: a grant is acquired by
// running THIS FLOW again, and this flow shows the sign-in screen only when
// there is no Cinatra session. A person who already holds one is not
// re-authenticated — their existing session authorizes, and they never read the
// sentences below. What is guaranteed is narrower and still the point of AC-1:
// an ALREADY-MINTED widget token never gains a grant. The grant lives on the
// authorization code, and only a new run of this flow mints one.
//
// States:
//   • invalid/expired txn → neutral error card (no oracle).
//   • no session          → login-only AuthView, naming the sentences this
//                           sign-in grants (redirects back here on login).
//   • session, non-member → deny card (not a member of the txn's org).
//   • session, member     → record the grant → postMessage to opener.
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

// What signing in grants, in the person's own words, ON the screen they sign in
// on. The list is GENERATED from the scope vocabulary and the server action
// records that same constant, so a grant cannot reach a token without its
// sentence being on this screen.
function SignInGrantNotice({ clientLabel }: { clientLabel: string }) {
  if (WIDGET_SIGNIN_GRANTED_SCOPES.length === 0) return null;
  return (
    <div className="mt-5 grid w-full gap-2">
      <p className="text-xs leading-5 text-muted-foreground">
        Signing in connects the assistant on your {clientLabel} site to this
        account. It follows the permissions you already have in Cinatra, and it
        will be allowed to:
      </p>
      <ul className="grid list-disc gap-1 pl-4 text-xs leading-5 text-muted-foreground">
        {WIDGET_SIGNIN_GRANTED_SCOPES.map((scope) => (
          <li key={scope}>{WIDGET_EXTENSION_SCOPES[scope].consentCopy}</li>
        ))}
      </ul>
    </div>
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
    // Record, on the transaction, the scope set this screen is about to show, so
    // the grant taken after the sign-in can be checked against the sentences the
    // person actually read (cinatra#2631). The server is the only party that can
    // state this: a marker carried in the URL could simply be stripped. It is
    // idempotent, first-write-wins, and never touches the single-use consume —
    // which is why it is allowed on a page render, unlike issuing the code.
    //
    // The RECORD wins over this build's opinion. If another request already
    // recorded a different set for this transaction, showing our own list here
    // would put a person in front of sentences that are not what would be
    // granted — the exact failure the record exists to prevent (codex rework
    // round 2, finding 1). So we refuse to render the screen at all.
    const displayed = widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES);
    const recorded = recordDisplayedScopesForTransaction(txn.txnId, displayed);
    if (recorded !== displayed) {
      emitWidgetAuthAudit("consent_denied", {
        siteId: txn.siteId,
        orgId: txn.orgId,
        agentSlug: txn.agentSlug,
        siteOrigin: txn.siteOrigin,
        reason: "stale_signin_screen",
      });
      return (
        <ErrorCard message="Cinatra was updated while this window was open. Close this window and open the assistant login again from your site." />
      );
    }
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
        <SignInGrantNotice clientLabel={clientLabel} />
      </Shell>
    );
  }

  const userId = String(session.user.id);

  // Membership re-check against the TRANSACTION's org (authoritative). A
  // non-member cannot proceed — no code.
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

  // Member → the sign-in stands as the authorization. The grant is recorded by
  // the server action (a POST, so a page render stays non-destructive) and the
  // code goes straight back to the opener. Nothing to read, nothing to press.
  emitWidgetAuthAudit("page_viewed", {
    actor: userId,
    siteId: txn.siteId,
    orgId: txn.orgId,
    client: txn.client,
    agentSlug: txn.agentSlug,
    siteOrigin: txn.siteOrigin,
    reason: "grant",
  });

  return (
    <Shell>
      <WidgetAuthGrant txnId={txn.txnId} />
    </Shell>
  );
}

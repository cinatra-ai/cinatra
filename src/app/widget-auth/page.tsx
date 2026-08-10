import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getAuthSession, resolveOrgRoleForUser } from "@/lib/auth-session";
import {
  loadActiveTransaction,
  mintWidgetScreenNonce,
  recordDisplayedScopesForTransaction,
  sessionRowPredatesTransaction,
  widgetScreenNonceHash,
  widgetSessionFingerprint,
} from "@/lib/widget-user-auth";
import {
  WIDGET_EXTENSION_SCOPES,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  screenRecordAdmitsArrival,
  widgetDisplayedScopesToken,
  widgetNoSignInScreenToken,
  widgetScreenNonceMatches,
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
// Whichever of the two recording branches runs, it makes ONE hop first: it
// writes the record together with the hash of a freshly minted single-use nonce
// and then redirects the browser to the same page carrying that nonce, so the
// arrival that redeems the record is provably the arrival it was written for
// (cinatra#2631, codex rework round 7, finding 1). Every later render of that
// arrival — a reload, the return from the sign-in — presents it and writes
// nothing.
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

  // THE ARRIVAL'S OWN NONCE (cinatra#2631, codex rework round 7, finding 1).
  //
  // The record on the transaction says what was displayed; it did not say to
  // WHOM. Two people can be walked through one unconsumed transaction during a
  // rolling deploy — A opens it sessionless on a current node, which records the
  // current set, and abandons it; B opens the same transaction on a legacy node,
  // reads the legacy copy, signs in and comes back here — and B would redeem A's
  // record. So a current node mints a single-use nonce when it writes a record,
  // stores only its hash beside it, and hands the value to that one browser.
  //
  // The URL is the carrier because it is the only one this render controls: a
  // server component may not set a cookie during a GET. Unlike the displayed set
  // itself (round 1, finding 1) it is SAFE there — stripping it cannot turn a
  // mismatch into an admission, because an arrival that presents no nonce is
  // refused. It is not a claim; it is a secret that is either held or not.
  const presentedNonce = first(sp.n);
  const presentedNonceHash = widgetScreenNonceHash(presentedNonce);
  const arrivalHoldsRecord = widgetScreenNonceMatches(
    txn.screenNonceHash,
    presentedNonceHash,
  );
  const urlFor = (nonce: string) =>
    `/widget-auth?txn=${encodeURIComponent(txn.txnId)}&n=${encodeURIComponent(nonce)}`;

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

    // This arrival already earned this record — a refresh, a back-navigation, or
    // the hop this render made a moment ago. Nothing to write; the same nonce
    // carries forward, so re-reading the screen costs nothing and breaks nothing.
    if (arrivalHoldsRecord && txn.displayedScopes === displayed) {
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
          <WidgetAuthLogin redirectTo={urlFor(presentedNonce)} />
          <SignInGrantNotice clientLabel={clientLabel} />
        </Shell>
      );
    }

    const nonce = mintWidgetScreenNonce();
    const nonceHash = widgetScreenNonceHash(nonce);
    const recorded = recordDisplayedScopesForTransaction(txn.txnId, displayed, nonceHash);
    if (
      recorded?.displayedScopes !== displayed ||
      recorded?.screenNonceHash !== nonceHash
    ) {
      // Either another build recorded a different set (round 2, finding 1), or
      // this transaction is already accounted for by an arrival that is not this
      // one. Both mean the same thing to the person in front of us: this window
      // cannot honestly show them what they would be granting.
      emitWidgetAuthAudit("consent_denied", {
        siteId: txn.siteId,
        orgId: txn.orgId,
        agentSlug: txn.agentSlug,
        siteOrigin: txn.siteOrigin,
        reason:
          recorded?.displayedScopes === displayed
            ? "screen_nonce_mismatch"
            : "stale_signin_screen",
      });
      return (
        <ErrorCard message="Cinatra was updated while this window was open. Close this window and open the assistant login again from your site." />
      );
    }
    // The record and the nonce are now one stored fact, so the browser is sent
    // to the URL that carries its half of it. Hopping instead of rendering here
    // is what keeps the screen REFRESH-SAFE: every later render of this arrival —
    // a reload, the return from the sign-in — presents the nonce it was minted
    // with, and takes the branch above instead of trying to record again.
    redirect(urlFor(nonce));
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

  // THE ONE POINT AT WHICH "no sign-in screen rendered" IS A FACT.
  //
  // cinatra#2631 (codex rework round 3, finding 1). The transaction was created
  // saying nothing about what would be displayed, because at creation nothing is
  // known. Here a node running THIS build is looking at a session, and if that
  // session's ROW was already in the database when the transaction row was
  // inserted, it cannot have come from a sign-in screen shown for this
  // transaction — not this build's screen, and not the legacy screen of an older
  // node still serving traffic mid-rollout. Only then may the no-screen sentinel
  // be written, and the write is first-write-wins, so it can never paint over a
  // screen that really rendered.
  //
  // The ordering is the DATABASE's own, not a clock (round 4, finding 1): a
  // session's `createdAt` is written by whichever node minted it, and an old
  // node's lagging clock would otherwise pass off a session minted after its
  // legacy screen as one that predated the transaction.
  //
  // The sentinel NAMES THIS SESSION (round 5, finding 1). It is a fact about one
  // person's arrival, not about the transaction: without the name, a member
  // could stamp it with a bare GET and leave it standing for whoever came next
  // through an older node's legacy screen. The grant re-derives the same name
  // from its own session and admits the sentinel only for that session.
  //
  // When the session came AFTER, a sign-in happened during this flow: either
  // this build's screen recorded what it displayed (the ordinary path — the
  // record is already there, this arrival is carrying the nonce that screen gave
  // it, and this reads both), or the screen came from a node that records
  // nothing, in which case there is no record naming this arrival and the check
  // below refuses. Nothing is assumed on the person's behalf.
  //
  // A NO-SCREEN PROOF MINTS ITS OWN NONCE (round 7, finding 1). This arrival
  // never passed a sign-in screen, so nothing has handed it one yet; the write
  // that records the sentinel mints it in the same statement and the browser is
  // sent to the URL carrying it, exactly like the screen branch above. The
  // sentinel already names the session, so the nonce adds a second, independent
  // binding rather than the only one — and it means BOTH kinds of record are
  // admitted through one rule, with no value that is redeemable by an arrival
  // that cannot present its own nonce.
  const noScreenToken = widgetNoSignInScreenToken(
    widgetSessionFingerprint(session.session?.id),
  );
  let record = { displayedScopes: txn.displayedScopes, screenNonceHash: txn.screenNonceHash };
  if (!arrivalHoldsRecord) {
    const noScreenProven =
      noScreenToken.length > 0 &&
      sessionRowPredatesTransaction(String(session.session?.id ?? ""), txn.txnId);
    if (noScreenProven) {
      const nonce = mintWidgetScreenNonce();
      const nonceHash = widgetScreenNonceHash(nonce);
      const recorded = recordDisplayedScopesForTransaction(
        txn.txnId,
        noScreenToken,
        nonceHash,
      );
      if (
        recorded?.displayedScopes === noScreenToken &&
        recorded?.screenNonceHash === nonceHash
      ) {
        redirect(urlFor(nonce));
      }
      record = recorded ?? { displayedScopes: null, screenNonceHash: null };
    }
  }
  if (
    !screenRecordAdmitsArrival(record, WIDGET_SIGNIN_GRANTED_SCOPES, {
      presentedNonceHash,
      expectedNoScreenToken: noScreenToken,
    })
  ) {
    emitWidgetAuthAudit("consent_denied", {
      actor: userId,
      orgId: txn.orgId,
      siteId: txn.siteId,
      agentSlug: txn.agentSlug,
      siteOrigin: txn.siteOrigin,
      reason: arrivalHoldsRecord ? "stale_signin_screen" : "screen_nonce_mismatch",
    });
    return (
      <ErrorCard message="Cinatra was updated while this window was open. Close this window and open the assistant login again from your site." />
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
      <WidgetAuthGrant txnId={txn.txnId} nonce={presentedNonce} />
    </Shell>
  );
}

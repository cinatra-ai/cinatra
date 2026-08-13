"use client";

import { useEffect, useRef, useState } from "react";

import { WidgetAuthSuccess } from "@/components/widget-auth/widget-auth-success";
import type { WidgetAuthGrantResult } from "@/app/widget-auth/actions";

// cinatra#2631 — the return step of the hosted /widget-auth flow.
//
// OWNER RULING (2026-08-10): "treat sign in as consent." This replaces the
// consent interstitial cinatra#407 shipped — a card headed "Continue to the
// assistant" with a Continue button the signed-in member had to press. Signing
// in IS the authorization now, so the moment a signed-in member reaches this
// component the grant is recorded and the code is handed back to the site.
//
// WHY A SERVER ACTION AND NOT THE PAGE RENDER. Issuing the code is a MUTATION:
// it consumes the single-use transaction. Doing that while rendering the page
// would make a GET destructive, and the sign-in redirect that lands here is
// followed by a client refresh — the second render would find its own
// transaction already consumed and show an expired error to a user who did
// nothing wrong. So the mutation stays on the POST side of the server-action
// boundary and is simply fired without asking.
//
// ONE REQUEST PER TRANSACTION, AND EVERY EFFECT RUN SEES ITS RESULT. The request
// is kept in a ref KEYED BY the transaction id; each effect run subscribes to
// that same promise rather than guarding itself out (codex rework round 0,
// finding 2; keyed in round 1, finding 2). Under React StrictMode the effect is
// invoked twice on one instance: a guard that skipped the second run would
// discard the only result — the transaction consumed on the server, the popup
// spinning forever.
//
// A REAL REMOUNT (a reload, a closed-and-reopened popup) gets a fresh ref and
// asks again, and the transaction it asks about is already consumed, so it is
// told the request expired and to open the assistant login again. That is the
// same thing the old Continue button did once it had been pressed: the code is
// single-use and delivered once, and losing it costs a new transaction.
//
// The pending copy is IDENTICAL to the success copy, so the person sees ONE
// screen for the whole return — never a second thing to read.

const FAILURE_MESSAGES: Record<string, string> = {
  not_org_member:
    "Your account is not a member of the organization connected to this site, so it cannot be used here.",
  transaction_expired:
    "This sign-in request expired. Close this window and open the assistant login again.",
  not_authenticated: "Your session ended. Please sign in again.",
  stale_screen:
    "Cinatra was updated while this window was open, so what you were shown is out of date. Close this window and open the assistant login again.",
  invalid_request: "This sign-in request is invalid. Open the assistant login again.",
};

// THE NONCE IS CARRIED, NEVER MINTED HERE (cinatra#2631, codex rework round 7,
// finding 1). It is the server's proof that the arrival redeeming the recorded
// sign-in screen is the arrival that screen rendered for; this component only
// hands back what the page handed it, and a wrong or missing value can only
// cause a refusal. It is a request argument rather than page state because the
// action re-checks it against the stored hash on the server.

export function WidgetAuthGrant({ txnId, nonce }: { txnId: string; nonce: string }) {
  const [state, setState] = useState<
    { txnId: string; result: WidgetAuthGrantResult } | null
  >(null);
  const request = useRef<{
    txnId: string;
    result: Promise<WidgetAuthGrantResult>;
  } | null>(null);

  useEffect(() => {
    // KEYED by the transaction, so a changed prop starts its own request instead
    // of resolving to the previous transaction's code (codex rework round 1,
    // finding 2).
    if (request.current?.txnId !== txnId) {
      request.current = {
        txnId,
        result: (async () => {
          const { issueWidgetAuthCodeAction } = await import("@/app/widget-auth/actions");
          return issueWidgetAuthCodeAction(txnId, nonce);
        })().catch(
          // A transport failure must not strand the popup on a spinner.
          () => ({ ok: false, reason: "invalid_request" }) as WidgetAuthGrantResult,
        ),
      };
    }
    const pending = request.current.result;
    let live = true;
    void pending.then((result) => {
      if (live) setState({ txnId, result });
    });
    return () => {
      live = false;
    };
    // `nonce` is listed because the effect reads it, but the request stays KEYED
    // BY THE TRANSACTION: a re-run for the same transaction subscribes to the
    // request already in flight rather than starting a second one, which is the
    // property round 1 finding 2 established. The transaction is single-use, so
    // one request is the whole point — a second nonce for the same transaction
    // would have nothing left to redeem.
  }, [txnId, nonce]);

  // A result belongs to ONE transaction. Showing the previous transaction's
  // outcome while a new one is in flight would deliver the wrong code — or, on
  // the success path, silently not deliver the new one at all, because the
  // success component posts its message on MOUNT (codex rework round 2, finding
  // 4). Hence the identity check here and the key below.
  const outcome = state?.txnId === txnId ? state.result : null;

  if (outcome?.ok) {
    // The site origin the action also returns is NOT passed on (cinatra#2674):
    // the authorization result is delivered to the Cinatra origin only, and the
    // success step derives that from where it is running rather than from data.
    return <WidgetAuthSuccess key={txnId} code={outcome.code} state={outcome.state} />;
  }

  if (outcome) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {FAILURE_MESSAGES[outcome.reason] ?? "Could not complete sign-in."}
      </p>
    );
  }

  return (
    <div className="grid gap-3 text-center" aria-live="polite">
      <p className="text-sm text-muted-foreground">
        Signed in. Returning to the assistant…
      </p>
    </div>
  );
}

"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WidgetAuthSuccess } from "@/components/widget-auth/widget-auth-success";
import type { ConsentActionResult } from "@/app/widget-auth/actions";

// cinatra#407 — consent step for the hosted /widget-auth page.
//
// The logged-in MEMBER explicitly authorizes (a click — NOT auto-issue, per
// codex convergence: a click gives user intent + a CSRF boundary, so a
// compromised/malicious site backend cannot silently mint a code for an already
// signed-in user). On success the server action returns the user auth code,
// which we render into <WidgetAuthSuccess> to postMessage to the verified
// opener origin. On failure (non-member, expired, bad CSRF) we show a message.

const FAILURE_MESSAGES: Record<string, string> = {
  not_org_member:
    "Your account is not a member of the organization connected to this site, so it cannot be used here.",
  transaction_expired:
    "This sign-in request expired. Close this window and open the assistant login again.",
  not_authenticated: "Your session ended. Please sign in again.",
  invalid_request: "This sign-in request is invalid. Open the assistant login again.",
};

export function WidgetAuthConsent({
  txnId,
  consentCsrf,
  siteOrigin,
  clientLabel,
}: {
  txnId: string;
  consentCsrf: string;
  siteOrigin: string;
  clientLabel: string;
}) {
  const [state, formAction] = useActionState<ConsentActionResult | null, FormData>(
    async (_prev, formData) => {
      const { issueWidgetAuthCodeAction } = await import("@/app/widget-auth/actions");
      return issueWidgetAuthCodeAction(formData);
    },
    null,
  );

  if (state?.ok) {
    return (
      <WidgetAuthSuccess
        code={state.code}
        state={state.state}
        siteOrigin={state.siteOrigin}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm leading-6 text-muted-foreground">
        Continue to use the assistant on your {clientLabel} site as{" "}
        <span className="font-medium text-foreground">this account</span>. Your
        actions there will follow the permissions granted to you in this Cinatra
        workspace.
      </p>
      {state && !state.ok ? (
        <p className="text-sm text-destructive" role="alert">
          {FAILURE_MESSAGES[state.reason] ?? "Could not complete sign-in."}
        </p>
      ) : null}
      <form action={formAction}>
        <Input type="hidden" name="txn" value={txnId} />
        <Input type="hidden" name="consent_csrf" value={consentCsrf} />
        <ConsentSubmit />
      </form>
      <p className="break-all text-xs text-muted-foreground">
        Returning to: <span className="font-mono">{siteOrigin}</span>
      </p>
    </div>
  );
}

function ConsentSubmit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Continuing…" : "Continue"}
    </Button>
  );
}

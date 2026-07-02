"use client";

import { AuthUIProvider, AuthView } from "@/components/auth-view-client";
import { authClient } from "@/lib/auth-client";

// cinatra#407 — LOGIN-ONLY hosted login for the /widget-auth page.
//
// Renders the REAL Cinatra sign-in view (AuthView view="SIGN_IN") so it is
// pixel-identical to /sign-in, but wrapped in a SCOPED AuthUIProvider with
// `signUp={false}` so the "Don't have an account? Sign up" footer link is
// suppressed — login-only by spec (no signup anywhere in the widget auth flow).
//
// The scoped provider re-uses the SAME @daveyplate/better-auth-ui module
// instance as the root provider (both imported through
// src/components/auth-view-client.tsx), so nesting overrides the signup flag for
// THIS subtree only without breaking the shared AuthUIContext.
//
// On successful credential login Better Auth sets the session cookie and the
// view redirects to `redirectTo` (back to /widget-auth?txn=...), where the
// server component continues the transaction (membership re-check + consent).
export function WidgetAuthLogin({ redirectTo }: { redirectTo: string }) {
  return (
    <AuthUIProvider
      authClient={authClient}
      signUp={false}
      redirectTo={redirectTo}
      // Keep the rest of the auth UX identical to the app default; only the
      // signup affordance is removed for the widget login.
    >
      <AuthView view="SIGN_IN" redirectTo={redirectTo} />
    </AuthUIProvider>
  );
}

"use client";

import { AuthUIProvider, AuthView, SignUpForm } from "@daveyplate/better-auth-ui";

// These components must live in the main app to share the same @daveyplate/better-auth-ui
// module instance as AuthUIProvider (pnpm creates separate virtual-store instances per package).
//
// AuthUIProvider is re-exported here (cinatra#407) so the hosted /widget-auth
// login can mount a SCOPED provider with `signUp={false}` from the SAME package
// instance as the root provider — a login-only override that suppresses the
// signup footer link without touching the app-wide provider.

export { AuthUIProvider, AuthView, SignUpForm };

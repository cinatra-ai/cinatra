"use client";

import { AuthView, SignUpForm } from "@daveyplate/better-auth-ui";

// These components must live in the main app to share the same @daveyplate/better-auth-ui
// module instance as AuthUIProvider (pnpm creates separate virtual-store instances per package).

export { AuthView, SignUpForm };

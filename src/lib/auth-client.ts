"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, genericOAuthClient, organizationClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { toast } from "@/lib/cinatra-toast";

// Paths where a failed request should surface a visible error toast.
const USER_ACTION_PATHS = ["/sign-in", "/sign-up", "/change-password", "/forgot-password", "/reset-password"];

export const authClient = createAuthClient({
  // Use the current page's origin as baseURL so auth API calls always go to
  // the same host serving the app. Without an explicit value, better-auth falls
  // through to reading NEXT_PUBLIC_BETTER_AUTH_URL from env (hardcoded to
  // http://localhost:3000), which breaks mobile/tunnel clients.
  baseURL: typeof window !== "undefined" ? window.location.origin : (process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000"),
  fetchOptions: {
    onError: async (ctx) => {
      const path = new URL(ctx.response.url).pathname;
      if (!USER_ACTION_PATHS.some((p) => path.includes(p))) return;
      // ctx.response.clone() throws SYNCHRONOUSLY (TypeError) when better-auth
      // has already consumed the body for its own error handling. The
      // chained .catch() only handles Promise rejections, not sync throws.
      // Wrap in try/catch and fall back to ctx.error.message — without this,
      // the raw "Failed to execute 'clone' on 'Response': Response body is
      // already used" string surfaces as the user-facing toast whenever an
      // auth request fails (e.g. invalid session cookie on page load after
      // BETTER_AUTH_SECRET rotation).
      let errorBody: Record<string, unknown> | null = null;
      try {
        errorBody = (await ctx.response.clone().json().catch(() => null)) as Record<string, unknown> | null;
      } catch {
        // body already consumed — fall through to ctx.error
      }
      const message =
        (errorBody?.message as string) ||
        ((errorBody?.error as Record<string, unknown>)?.message as string) ||
        ((ctx.error as Record<string, unknown> | undefined)?.message as string) ||
        ctx.response.statusText ||
        "Authentication failed";
      toast.error(message);
    },
  },
  plugins: [
    usernameClient(),
    twoFactorClient(),
    adminClient(),
    genericOAuthClient(),
    organizationClient(),
  ],
});

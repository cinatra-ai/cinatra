"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, genericOAuthClient, organizationClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { toast } from "@/lib/cinatra-toast";

// Paths where a failed request should surface a visible error toast.
//
// cinatra#884: "/sign-in" is deliberately NOT in this list. The better-auth-ui
// `SignInForm` already surfaces its own failure via the `toast` render prop
// wired up on `AuthUIProvider` (see `src/app/providers.tsx`) — every failed
// `/sign-in` request additionally passes through this client's global
// `fetchOptions.onError` below, so keeping "/sign-in" here fired a SECOND,
// identical "invalid username or password" toast for the same error. The
// other user-action paths don't have (or aren't proven to have) an
// equivalent form-level toast, so they keep relying on this handler.
const USER_ACTION_PATHS = ["/sign-up", "/change-password", "/forgot-password", "/reset-password"];

/** Exported for unit coverage of the de-dup fix (cinatra#884) without reaching into better-fetch internals. */
export function shouldToastAuthFetchError(pathname: string): boolean {
  return USER_ACTION_PATHS.some((p) => pathname.includes(p));
}

export const authClient = createAuthClient({
  // Use the current page's origin as baseURL so auth API calls always go to
  // the same host serving the app. Without an explicit value, better-auth falls
  // through to reading NEXT_PUBLIC_BETTER_AUTH_URL from env (hardcoded to
  // http://localhost:3000), which breaks mobile/tunnel clients.
  baseURL: typeof window !== "undefined" ? window.location.origin : (process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000"),
  fetchOptions: {
    onError: async (ctx) => {
      const path = new URL(ctx.response.url).pathname;
      if (!shouldToastAuthFetchError(path)) return;
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

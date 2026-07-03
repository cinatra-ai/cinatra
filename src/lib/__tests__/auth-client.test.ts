import { describe, it, expect } from "vitest";
import { shouldToastAuthFetchError } from "@/lib/auth-client";

/**
 * cinatra#884: a failed sign-in must show exactly ONE "invalid username or
 * password" toast, not two.
 *
 * The better-auth-ui `SignInForm` already surfaces its own failure via the
 * `toast` render prop wired up on `AuthUIProvider` (src/app/providers.tsx).
 * `authClient`'s global `fetchOptions.onError` (src/lib/auth-client.ts) used
 * to ALSO toast for "/sign-in", firing a second, identical toast for the same
 * failed request. `shouldToastAuthFetchError` is the gate that decides
 * whether the global handler surfaces a toast for a given auth request path
 * — it must exclude "/sign-in" (de-duped at the source) while still covering
 * the other user-action paths that don't have their own form-level toast.
 */
describe("shouldToastAuthFetchError — cinatra#884 toast de-dup", () => {
  it("does NOT toast for a failed /sign-in request (SignInForm already toasts it)", () => {
    expect(shouldToastAuthFetchError("/api/auth/sign-in/email")).toBe(false);
    expect(shouldToastAuthFetchError("/sign-in")).toBe(false);
  });

  it("still toasts for the other user-action paths", () => {
    expect(shouldToastAuthFetchError("/api/auth/sign-up/email")).toBe(true);
    expect(shouldToastAuthFetchError("/api/auth/change-password")).toBe(true);
    expect(shouldToastAuthFetchError("/api/auth/forgot-password")).toBe(true);
    expect(shouldToastAuthFetchError("/api/auth/reset-password")).toBe(true);
  });

  it("does not toast for unrelated auth paths (e.g. session probes)", () => {
    expect(shouldToastAuthFetchError("/api/auth/get-session")).toBe(false);
  });
});

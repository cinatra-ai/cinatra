// Host-injected Google-OAuth connection facade for the google-oauth-connector.
//
// The google-oauth-connector OWNS its setup page in-package but the concrete
// OAuth runtime lives HOST-side at
// `@cinatra-ai/google-oauth-connection` (a `packages/` module imported by
// `src/lib/auth.ts` / `src/app/layout.tsx`). The connector must not import that
// package by name — that re-anchors it and breaks standalone extraction.
//
// The connector's relocated `"use server"` save action runs OUTSIDE the
// render-time host-context: it cannot close over the `ctx` the dispatch route
// builds, so it resolves the host facade through this SDK DI slot. The host
// injects ONE implementation at boot via `setGoogleOAuthConnectionProvider`, and
// the connector calls `requireGoogleOAuthConnectionProvider()`. The SDK stays a
// leaf contract — it owns the shape, the host owns the binding (to the real
// google-oauth-connection runtime). This is a DI slot (same class as
// `action-guard` / `a2a-connection`), NOT a new `ctx` host-port, so it does not
// bump the SDK ABI version.

import { createHostDepsSlot } from "./dependencies";

/**
 * The host-supplied Google-OAuth client-credential facade. Bound once at boot to
 * the real `@cinatra-ai/google-oauth-connection` runtime. `saveSettings` MUST be
 * resolved only AFTER the connector's action has passed
 * `requireExtensionAction(pkg, "manage")`.
 */
export interface GoogleOAuthConnectionProvider {
  /** Read the persisted OAuth client values (Nango-overlaid where present). */
  getSettings(): Promise<{
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  }>;
  /** Derive the connection status surfaced in the settings panel. */
  getStatus(): Promise<{
    status: "connected" | "incomplete" | "not_connected";
    accountEmail?: string;
    detail?: string;
  }>;
  /** The Nango-derived OAuth redirect URI to register in Google Cloud. */
  getOAuthCallbackUrl(): string;
  /** Persist the OAuth client values. Honours the "leave blank to keep the
   *  saved value" contract (blank inputs merge with the current saved values). */
  saveSettings(input: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  }): Promise<{
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  }>;
}

// Anchor the provider on `globalThis` via a namespaced+versioned Symbol so the
// host `setGoogleOAuthConnectionProvider` boot call and the extension's
// `requireGoogleOAuthConnectionProvider` action call resolve the SAME slot even
// when Next.js compiles `@cinatra-ai/sdk-extensions` into more than one module
// instance (server / RSC / route segments). Same cross-compilation reason as the
// action-guard + a2a-connection contracts.
// Built on the shared `createHostDepsSlot` primitive (see ./dependencies); the
// slot identity (the `Symbol.for` key) is unchanged.
const _slot = createHostDepsSlot<GoogleOAuthConnectionProvider>(
  "@cinatra-ai/sdk-extensions:google-oauth-connection-provider/v1",
);

/**
 * Wire the host Google-OAuth connection provider. Called exactly once at boot
 * (host instrumentation). Re-calling replaces the previous impl — tests can swap
 * a stub between blocks.
 */
export function setGoogleOAuthConnectionProvider(impl: GoogleOAuthConnectionProvider): void {
  _slot.set(impl);
}

/** @internal test-only — clear the provider so a fresh wiring is required. */
export function _resetGoogleOAuthConnectionProviderForTests(): void {
  _slot.reset();
}

/**
 * Resolve the host-bound Google-OAuth connection provider. Fails CLOSED (throws)
 * if the host never wired it — an unbound provider is a boot-wiring bug, never a
 * silent no-op that could drop a credential save.
 */
export function requireGoogleOAuthConnectionProvider(): GoogleOAuthConnectionProvider {
  return _slot.require(
    "[sdk-extensions] requireGoogleOAuthConnectionProvider() was called before the host wired " +
      "the Google-OAuth connection provider. The host must call setGoogleOAuthConnectionProvider(...) " +
      "at boot (src/lib/register-google-oauth-provider.ts, imported from instrumentation.node.ts).",
  );
}

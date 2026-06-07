import "server-only";

// ---------------------------------------------------------------------------
// Host-side wiring for @cinatra-ai/google-oauth-connector (SDK-only
// decouple).
//
// The connector's setup page OWNS its setup-impl + save action and resolves the
// Google-OAuth facade through ONE SDK DI slot —
// `requireGoogleOAuthConnectionProvider()` — for BOTH the render and
// the relocated "use server" save action (the action runs in a separate bundle
// with no ctx). This module binds that slot at boot via
// `setGoogleOAuthConnectionProvider`, delegating to the host-side
// google-oauth-connection facade (a `packages/` host module — not an extension —
// so importing it here is allowed). `register(ctx)` does NOT fire for this
// connector (serverEntry:null, the StaticBundleLoader skips it), so the provider
// is bound host-side here.
//
// This module imports ONLY the SDK + host packages — it names NO
// @cinatra-ai/<extension>, so it adds ZERO core→extension edge (no baseline
// entry, unlike register-email-providers). Auto-registers on import;
// src/instrumentation.node.ts imports it at boot.
// ---------------------------------------------------------------------------

import { setGoogleOAuthConnectionProvider } from "@cinatra-ai/sdk-extensions";
import {
  getGoogleOAuthSettings,
  getGoogleOAuthStatus,
  saveGoogleOAuthSettings,
} from "@cinatra-ai/google-oauth-connection";
import { getNangoOAuthCallbackUrl } from "@/lib/nango";

// The single host-side Google-OAuth facade, delegating to the google-oauth-connection
// host module. The connector resolves it via requireGoogleOAuthConnectionProvider()
// in both its setup-page render and its "use server" save action.
const googleOAuthFacade = {
  getSettings: getGoogleOAuthSettings,
  getStatus: getGoogleOAuthStatus,
  getOAuthCallbackUrl: getNangoOAuthCallbackUrl,
  saveSettings: saveGoogleOAuthSettings,
};

setGoogleOAuthConnectionProvider(googleOAuthFacade);

// Pure (no React/Nango imports) so it unit-tests directly in the node vitest env,
// unlike the component module it serves (see nango-user-connect-button.tsx).
//
// A Nango Connect "error" event carries the provider's raw OAuth error. The most
// common actionable class is a redirect_uri mismatch — the provider rejects the
// callback because it is not in the app's registered redirect-URL allow-list.
// Detect that class and APPEND actionable guidance while PRESERVING the raw
// provider message (which usually names the exact redirect_uri Nango sent). We do
// NOT reconstruct the URI: a connector's nangoFrontendConfig.baseURL is the
// Connect-UI origin, not the OAuth callback server, so deriving it would echo the
// wrong value (#761). The connector setup page is the canonical place to read the
// exact "Authorized redirect URI" to register. Any other error passes through
// unchanged (falling back to a generic message when empty).

export function describeNangoConnectError(rawMessage: string | undefined | null): string {
  const message = rawMessage?.trim() || "Authorization failed.";
  // Accept redirect/callback × uri/url (and _, space, - separators): providers
  // word this as redirect_uri (OAuth spec), "redirect URL", or "callback URL".
  const mentionsRedirectUri = /(redirect|callback)[\s_-]?ur[il]/i.test(message);
  const looksLikeMismatch = /match|registered|allow|whitelist|invalid/i.test(message);
  if (!mentionsRedirectUri || !looksLikeMismatch) return message;
  return `${message} — the OAuth redirect URI sent to the provider is not in its registered allow-list. Copy the “Authorized redirect URI” shown on this connector's setup page and add it to the provider app's OAuth redirect-URL settings exactly (no trailing slash), then reconnect.`;
}

// Pure builder for the OAuth handshake URLs the MCP server advertises to
// external clients. Leaf module (no React/UI imports) so it can be unit-tested
// against the on-disk route files without dragging in the full mount barrel.
//
// The shapes carry the `/auth` and `/account` prefixes that match the actual
// route-file layout (`<base>/auth/[path]`, `<base>/account/[path]`,
// `<base>/consent`) — a bare `<base>/sign-in` would 404 against the real routes.

function normalizeBase(value: string | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim();
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

export function buildMcpHandshakeUrls(handshakeBasePath: string) {
  const base = normalizeBase(handshakeBasePath, "/api/mcp");
  return {
    loginPage: `${base}/auth/sign-in`,
    signupPage: `${base}/auth/sign-up`,
    consentPage: `${base}/consent`,
    accountSettings: `${base}/account/settings`,
    accountSecurity: `${base}/account/security`,
  };
}

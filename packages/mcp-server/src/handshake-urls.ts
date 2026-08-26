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

// Base-path normalizer shared by the auth-plugin factory and the mount builder.
// Lives in this LEAF module (not in the mount barrel) so the factory can be
// reached without pulling the barrel's runtime/UI graph: the /sign-in route
// mounts the auth plugins and nothing else.
//
// Strip trailing "/" via a LINEAR char-index scan. The anchored greedy
// `/\/+$/` is flagged polynomial-ReDoS on slash-heavy input
// (CodeQL js/polynomial-redos); this mirrors the trim already used in
// mcp-public-base-url-shape.mjs and is O(n) with no backtracking.
function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return value.slice(0, end);
}

export function normalizeMcpBasePath(path: string | undefined, fallback: string) {
  const value = (path ?? fallback).trim();
  if (!value) {
    return fallback;
  }

  return value.startsWith("/")
    ? trimTrailingSlash(value) || "/"
    : `/${trimTrailingSlash(value)}`;
}

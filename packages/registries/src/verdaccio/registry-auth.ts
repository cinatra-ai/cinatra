// Registry-scoped credential options for pacote / npm-registry-fetch.
//
// Pure module — no "server-only" import. Must stay loadable from plain Node
// contexts (CLI extractors, vitest, scripts) like the rest of this package.

/**
 * Build the credential entry pacote's HTTP layer (npm-registry-fetch) actually
 * reads.
 *
 * npm-registry-fetch (v19.x, pacote ^21's fetch layer) resolves auth
 * EXCLUSIVELY from registry-scoped option keys of the form
 * `'//<host>/<path>:_authToken'` (the npmrc "nerf-dart" convention, walked up
 * the request URI's path) or from an explicit `forceAuth` object — a flat
 * `token` option is read by NEITHER path and silently produces requests with
 * no Authorization header at all (see npm-registry-fetch lib/auth.js). That
 * was the #179 regression: every pacote read built on a flat `token` ran
 * unauthenticated.
 *
 * The scoped key is preferred over `forceAuth` deliberately: `forceAuth`
 * attaches the credential to EVERY request made with the options object,
 * including packument-referenced tarball URLs that may point at a different
 * host. The scoped key sends the token only to URIs under the configured
 * registry host — npm-registry-fetch walks the request URI's path up to the
 * host root, so same-host tarball URLs (the Verdaccio layout) still match.
 *
 * Key derivation matches npm's nerf-dart: `//<host><pathname>/` (host keeps
 * its port; pathname keeps any registry path prefix; trailing slash enforced).
 * Returns `{}` when no token is configured (anonymous registry access).
 * Throws on a malformed registry URL — fail fast at the call boundary rather
 * than emit a silently-wrong key (same stance as cli-flags' extractHost).
 */
export function registryScopedAuthOptions(
  registryUrl: string,
  token: string | null | undefined,
): Record<string, string> {
  if (!token) return {};
  const parsed = new URL(registryUrl);
  const pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return { [`//${parsed.host}${pathname}:_authToken`]: token };
}

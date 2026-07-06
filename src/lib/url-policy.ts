/**
 * URL reachability policy — a NEUTRAL, vendor-agnostic mechanism.
 *
 * `isPrivateUrl` classifies a URL's host as a private/local address that an
 * external LLM provider (OpenAI, Anthropic, …) cannot reach. It is a pure
 * mechanism with NO vendor coupling: the external-MCP registry, the WordPress
 * MCP connection helpers, and the Drupal MCP connection helpers all consume it.
 *
 * Extracted from `@/lib/wordpress-mcp-connection` (cinatra#975, epic
 * cinatra#978 — "core owns integration MECHANISM, never vendor CODE") so the
 * generic external-MCP registry no longer imports a vendor-named module for a
 * neutral concern.
 */

/**
 * Returns true if the given URL hostname is a private/local address that cannot
 * be reached by external LLM providers (OpenAI, Anthropic). Such sites can still
 * show "Registered" in the administration UI (Cinatra's server can reach them) but must
 * not be registered as external MCP server tools.
 */
export function isPrivateUrl(siteUrl: string): boolean {
  try {
    const { hostname } = new URL(siteUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

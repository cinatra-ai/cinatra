/**
 * Dev-only MCP admin bypass policy.
 *
 * Mirrors `src/lib/a2a-auth.ts`'s `A2A_DEV_BYPASS=true` localhost bypass
 * but for the MCP transport's `platformRole` stamp. When all three guards
 * pass, the MCP request store's `platformRole` is forced to
 * `"platform_admin"`, letting admin-gated handlers (e.g.
 * `skills_match_batch_run_now`) succeed without an OAuth admin claim.
 *
 * THREE GUARDS, ALL REQUIRED:
 *   1. `NODE_ENV !== "production"` — never elevate in production builds
 *   2. `CINATRA_MCP_DEV_ADMIN_BYPASS === "true"` — explicit opt-in env
 *      (distinct from `A2A_DEV_BYPASS` / `BETTER_AUTH_DEV_BYPASS` so an
 *      accidental enable of an existing flag does not also unlock MCP
 *      admin)
 *   3. `isTrustedDevHost === true` — the request reached a host the
 *      operator has declared trusted. The set is:
 *        - true loopback (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`)
 *        - any hostname listed in `CINATRA_MCP_DEV_TRUSTED_HOSTS`
 *(comma-separated, exact host match after normalization)
 *
 * `CINATRA_MCP_DEV_TRUSTED_HOSTS` extends the trust boundary to an
 * explicitly-named external hostname (e.g. a Tailscale Serve FQDN). DB
 * configuration is intentionally NOT consulted: the operator must literally
 * type the FQDN into env, so a DB write alone cannot widen trust.
 *
 * NEVER list a publicly-reachable hostname in `CINATRA_MCP_DEV_TRUSTED_HOSTS`
 * unless you accept that any caller who can reach that hostname becomes an
 * unauthenticated platform admin on this MCP server. Tailscale Funnel,
 * ngrok public, and named public Cloudflare Tunnels are all "publicly
 * reachable" in this sense — only `tailscale serve` (tailnet-only) is
 * network-isolated.
 *
 * Pure functions so they can be unit-tested without mounting the MCP server.
 */

const LOOPBACK_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/**
 * Normalize a host string to its comparable form:
 *   - reject inputs that look like URLs (contain `://`) — these are not
 *     hostnames; treating their colon as a port separator would yield a
 *     wrong token (e.g. `https://foo.ts.net` → `"https"`) and could
 *     accidentally trust requests with that token. Operator must write
 *     bare hostnames in `CINATRA_MCP_DEV_TRUSTED_HOSTS`.
 *   - strip surrounding `[...]` (IPv6 bracketed form)
 *   - strip a single trailing `:<port>` from plain hostnames
 *   - lowercase
 * Returns null for empty / whitespace-only / URL-shaped input.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let host = raw.trim();
  if (host === "") return null;
  // Reject anything that looks like a URL (`scheme://...`). A bare hostname
  // never contains `://`, so any input that does is a misuse — drop it
  // rather than risk producing a token that matches something else (e.g.
  // `https://foo.ts.net` would otherwise normalize to `"https"`).
  if (host.includes("://")) return null;
  // Strip an IPv6 bracketed form: `[::1]` or `[::1]:3000`. Reject malformed
  // suffixes such as `[::1]evil.com` — only an empty suffix or `:<port>`
  // is accepted.
  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    if (closeIdx <= 0) return null;
    const inside = host.slice(1, closeIdx);
    const after = host.slice(closeIdx + 1);
    if (after !== "" && !/^:\d+$/.test(after)) return null;
    host = inside;
  } else if (host.includes(":")) {
    // Plain `host:port` — strip the rightmost `:<port>` only when the port
    // is all digits. Skip when the string has multiple colons (raw IPv6
    // like `::1` without brackets) — leave such inputs to fail the
    // loopback / allowlist match downstream rather than mangling them.
    // Reject when single-colon suffix is non-numeric (e.g.
    // `localhost:notaport`) so the malformed-veto path in
    // `isTrustedDevHost` can fire.
    const colonCount = (host.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const idx = host.indexOf(":");
      const suffix = host.slice(idx + 1);
      if (!/^\d+$/.test(suffix)) return null;
      host = host.slice(0, idx);
    }
  }
  host = host.toLowerCase();
  return host === "" ? null : host;
}

/**
 * Resolve the URL-only request host (no `x-forwarded-host` lookup).
 *
 * Both trust paths require this signal to be a recognised host. The
 * loopback path additionally considers `x-forwarded-host` (loopback OR
 * allowlisted — the local-reverse-proxy Funnel topology). The non-loopback
 * allowlist path ignores `x-forwarded-host` so a spoofed header cannot
 * rescue a non-loopback URL host. See `isTrustedDevHost` for the full
 * decision tree.
 *
 * Topology notes:
 *   - Tailscale Serve / ngrok / cloudflared *quick* tunnel typically
 *     preserves `Host` end-to-end → URL host equals the public hostname.
 *   - Tailscale Funnel / named Cloudflare Tunnel / nginx-on-localhost
 *     typically rewrites `Host` to the local origin → URL host is
 *     loopback, and the public hostname is in `X-Forwarded-Host`. This
 *     case is handled by the loopback path's forwarded-host branch.
 */
export function urlRequestHost(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Pluck the first value from a possibly multi-valued `x-forwarded-host`
 * header and normalize it. Returns null when absent / unparseable.
 */
export function forwardedRequestHost(headers: {
  get(name: string): string | null;
}): string | null {
  const raw = headers.get("x-forwarded-host");
  if (!raw) return null;
  const first = raw.split(",")[0];
  return normalizeHost(first);
}

/**
 * Composite host resolver that returns BOTH signals — exposed for
 * convenience at the call site so we don't compute the headers' `.get()`
 * lookup twice. Loopback evaluation uses both; allowlist evaluation uses
 * `urlHost` only.
 *
 * `effectiveRequestHost` provides a proxy-aware view for call sites:
 * forwarded-host wins when present, URL fallback when not. This view is
 * suitable for callers that need localhost-shaped request handling and for
 * the startup-warning emitter; it is NOT used for trust decisions in
 * `isTrustedDevHost`.
 */
export function effectiveRequestHost(headers: {
  get(name: string): string | null;
}, url: string): string | null {
  const forwarded = forwardedRequestHost(headers);
  if (forwarded) return forwarded;
  return urlRequestHost(url);
}

/**
 * Parse the comma-separated allowlist env var into a Set of normalized
 * hostnames. Entries that fail to normalize (empty, malformed) are skipped.
 * Entries with a scheme prefix (e.g. `https://foo.ts.net`) are NOT auto-
 * stripped — they will simply not match any normalized request host.
 * Document that and let it be: keeping the parser literal avoids surprising
 * matches.
 */
export function parseTrustedHosts(raw: string | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(",")) {
    const normalized = normalizeHost(part);
    if (normalized) set.add(normalized);
  }
  return set;
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Decide whether the given request is from a trusted dev host
 * (loopback OR explicitly env-allowlisted). All operational guards must
 * pass; this is the unified "trust tier" boolean for the MCP transport.
 *
 * Trust paths:
 *
 *   - **Loopback** — `urlHost` is loopback. The `forwardedHostRaw` header
 *     when present must parse to either (a) a loopback host (Turbopack
 *     dev proxy compatibility), or (b) an entry in
 *     `CINATRA_MCP_DEV_TRUSTED_HOSTS` (the Tailscale Funnel / named
 *     Cloudflare Tunnel / nginx-on-localhost topology, where the proxy
 *     terminates TLS at the public edge, connects to the localhost
 *     listener with `Host: localhost`, and stamps the original public
 *     hostname into `X-Forwarded-Host`). Present-but-malformed values OR
 *     present-and-neither-loopback-nor-allowlisted veto.
 *
 *   - **Allowlist** — `urlHost` is literally in the operator's allowlist.
 *     The forwarded-host header is intentionally NOT consulted here: a
 *     non-loopback URL host must not be "rescued" by a spoofed
 *     `X-Forwarded-Host`.
 *
 * Threat model for the loopback-allowlisted-forwarded path: a same-host
 * attacker already has the loopback bypass simply by NOT sending
 * `X-Forwarded-Host` at all, so allowing an additional value the
 * operator has explicitly typed into env does not widen the same-host
 * attack surface. Off-host attackers can only reach the loopback
 * listener through an operator-deployed reverse proxy, which sets
 * forwarded-host based on the URL they actually hit — which IS the
 * allowlist entry. This is a DEV trust path, NOT a production
 * reverse-proxy auth model.
 *
 * `urlHost` is normalized defensively inside the helper. `forwardedHostRaw`
 * is the RAW `x-forwarded-host` header value (`null` when absent, the raw
 * header string when present even if unparseable) — passing the raw value
 * lets the helper distinguish "absent" from "present but invalid."
 */
export function isTrustedDevHost(opts: {
  nodeEnv: string | undefined;
  envBypassFlag: string | undefined;
  trustedHostsEnv: string | undefined;
  urlHost: string | null;
  forwardedHostRaw: string | null;
}): boolean {
  if (opts.nodeEnv === "production") return false;
  if (opts.envBypassFlag !== "true") return false;
  const urlOnly = normalizeHost(opts.urlHost);
  if (!urlOnly) return false;
  const allowlist = parseTrustedHosts(opts.trustedHostsEnv);
  // Loopback path. Three cases the `forwardedHostRaw` header can be in:
  //   - absent  (null)           → trust (localhost request handling)
  //   - present, loopback        → trust (Turbopack dev-proxy handling)
  //   - present, allowlisted     → trust (legit local reverse proxy on
  //                                localhost: Tailscale Funnel/Serve,
  //                                cloudflared named tunnel, nginx, etc.
  //                                that terminates TLS at the public edge
  //                                and forwards to the localhost listener,
  //                                setting Host: localhost AND
  //                                X-Forwarded-Host: <public hostname>)
  //   - present, anything else   → veto
  //
  // Why allowing "present + allowlisted" is safe in dev:
  //   A same-host caller already has the loopback bypass simply by NOT
  //   sending X-Forwarded-Host at all. Permitting an extra value that the
  //   operator has explicitly typed into env therefore does not widen the
  //   same-host attack surface. For OFF-host callers, the only path to the
  //   loopback listener is through an operator-deployed reverse proxy, which sets
  //   X-Forwarded-Host based on the URL the caller actually hit — that
  //   value IS the allowlist entry.
  //
  // This is a DEV trust path, NOT a production reverse-proxy auth model.
  if (isLoopbackHost(urlOnly)) {
    if (opts.forwardedHostRaw !== null) {
      const first = opts.forwardedHostRaw.split(",")[0];
      const parsed = normalizeHost(first);
      if (!parsed) return false; // present but malformed → veto
      if (isLoopbackHost(parsed)) return true; // loopback forwarded → trust
      if (allowlist.has(parsed)) return true; // allowlisted forwarded → trust
      return false; // present but neither loopback nor allowlisted → veto
    }
    return true;
  }
  // Allowlist path: URL host must literally appear in the operator-defined
  // allowlist. Forwarded-host is intentionally NOT consulted on this path —
  // a non-loopback urlHost must not be "rescued" by a spoofed forwarded
  // header.
  return allowlist.has(urlOnly);
}

/**
 * Decide whether to grant platform_admin on a request that already passed
 * the trust tier check. The boolean argument carries the trust decision
 * (loopback OR env-allowlisted hostname) — kept opaque here so the policy
 * remains pure and unit-testable.
 */
export function shouldGrantDevAdminBypass(opts: {
  nodeEnv: string | undefined;
  envBypassFlag: string | undefined;
  isTrustedDevHost: boolean;
}): boolean {
  if (opts.nodeEnv === "production") return false;
  if (opts.envBypassFlag !== "true") return false;
  if (!opts.isTrustedDevHost) return false;
  return true;
}

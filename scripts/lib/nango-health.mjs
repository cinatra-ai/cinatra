// Nango connector-service health probing — shared by the `pnpm dev` preflight
// (scripts/dev-server.mjs) and the manual service check (scripts/check-services.mjs).
//
// Nango is the connector OAuth gateway. On arm64 dev hosts the upstream
// amd64-only `nangohq/nango-server:hosted` image runs under qemu and can
// segfault; a plain TCP connect to :3003 still "passes" while the process is
// hung but port-bound, so both callers probe the HTTP `/health` contract
// instead — the same contract scripts/setup.sh and the CI works-after smoke
// already wait on.
//
// Pure + dependency-free with no import-time side effects, so it is safe to
// pull into a unit test without booting anything (cf. scripts/lib/docker-port-drift.mjs).

import http from "node:http";
import https from "node:https";

// Default local Nango server URL — matches `.env.example` (NANGO_SERVER_URL)
// and the docker-compose `nango-server` host publication on 3003.
export const DEFAULT_NANGO_URL = "http://127.0.0.1:3003";

// Hosts that mean "the Nango on this machine" — the only case the dev preflight
// may auto-heal via docker compose. Mirrors docker-port-drift's loopback set.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

// Resolve the effective base URL: a trimmed non-empty env value, else the local
// default.
export function resolveNangoBaseUrl(envValue) {
  const v = typeof envValue === "string" ? envValue.trim() : "";
  return v || DEFAULT_NANGO_URL;
}

// Build the `/health` URL from a base Nango server URL, collapsing any trailing
// slash so we never emit `…//health`.
export function nangoHealthUrl(baseUrl) {
  return `${resolveNangoBaseUrl(baseUrl).replace(/\/+$/, "")}/health`;
}

// Is this Nango URL a local/default one we may auto-heal via docker compose? A
// custom remote NANGO_SERVER_URL (hosted Nango / shared infra) is NOT ours to
// start or restart, so the dev preflight only attempts a heal for loopback.
export function isLocalNangoUrl(baseUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(resolveNangoBaseUrl(baseUrl)).hostname);
  } catch {
    return false;
  }
}

// HTTP GET `url`; resolve `{ ok, status }` where `ok` is true iff the response
// is 2xx. Never rejects — a connection error, timeout, or malformed URL
// resolves `{ ok: false }` so callers can treat "unreachable" and "unhealthy"
// uniformly.
export function probeHttpHealth(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let req;
    try {
      const client = url.startsWith("https:") ? https : http;
      req = client.get(url, { timeout: timeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain the body so the socket can close
        finish({ ok: status >= 200 && status < 300, status });
      });
    } catch {
      finish({ ok: false });
      return;
    }
    req.on("timeout", () => {
      req.destroy();
      finish({ ok: false });
    });
    req.on("error", () => finish({ ok: false }));
  });
}

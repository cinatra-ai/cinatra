import "server-only";

// ---------------------------------------------------------------------------
// Admin/operator route origin guard — pure same-origin enforcement.
//
// The admin/operator routes (background-job operations, default-LLM-provider)
// are COOKIE-BACKED: the browser attaches the session cookie automatically on
// any request the page can make, including a cross-site fetch. The absence of
// an `Access-Control-Allow-Origin` header is NOT sufficient protection — a
// cross-origin POST still reaches the handler and runs (the browser only
// blocks the attacker from *reading* the response, not from triggering the
// side effect). So we reject cross-origin requests SERVER-SIDE before any
// mutation runs. This doubles as CSRF defense-in-depth.
//
// Policy (deliberately strict — no allowlist, no credentialed CORS):
//   - No `Origin` header (same-origin GET/navigation, server-to-server) -> allow.
//   - `Origin` equals the canonical app origin -> allow.
//   - In development, `Origin` equal to the request's own origin or a localhost
//     origin -> allow (so the local dev server on any port works).
//   - Any other `Origin` -> 403 with NO `Access-Control-Allow-Origin` and NO
//     `Access-Control-Allow-Credentials`. We NEVER emit `*` with credentials.
//
// `rejectCrossOrigin` returns a `Response` (the 403) to short-circuit the
// handler, or `null` to proceed. Callers MUST `return` the Response when it is
// non-null.
// ---------------------------------------------------------------------------

function canonicalAppOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    return new URL(raw).origin;
  } catch {
    return "http://localhost:3000";
  }
}

function isDevelopment(): boolean {
  return process.env.NODE_ENV !== "production";
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Build the set of origins considered same-origin for THIS request. Always
 * includes the canonical app origin. In development it also admits the
 * request's own origin and localhost variants so the local dev server (any
 * port) is not self-blocked. In production the set is the canonical origin
 * ONLY — no localhost, no request-origin reflection.
 */
function allowedOrigins(req: Request): Set<string> {
  const allowed = new Set<string>([canonicalAppOrigin()]);
  if (isDevelopment()) {
    allowed.add("http://localhost:3000");
    try {
      allowed.add(new URL(req.url).origin);
    } catch {
      // Non-absolute/invalid req.url — ignore; canonical origin still applies.
    }
  }
  return allowed;
}

/**
 * Reject a cross-origin request to a cookie-backed admin/operator route.
 *
 * Returns a 403 `Response` (with NO CORS headers) when the request carries an
 * `Origin` header that is not same-origin, or `null` to proceed.
 */
export function rejectCrossOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  // Same-origin browser requests and server-to-server callers omit Origin.
  if (!origin) return null;

  // In development, allow any localhost origin even if it is not the canonical
  // app origin (e.g. a second dev server on a different port).
  if (isDevelopment() && isLocalhostOrigin(origin)) return null;

  if (allowedOrigins(req).has(origin)) return null;

  // Cross-origin: hard 403. Intentionally NO Access-Control-Allow-Origin and
  // NO Access-Control-Allow-Credentials — never reflect the attacker origin,
  // never emit `*` with credentials.
  return new Response(
    JSON.stringify({ error: "Cross-origin request rejected." }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    },
  );
}

import "server-only";

// ---------------------------------------------------------------------------
// A2A CORS allowlist helper
//
// Replaces the "reflect-origin-verbatim" pattern in /api/a2a and
// /api/a2a/resume with an allowlist check. Only origins on the list receive
// their own value reflected back; all other origins get the canonical app
// origin, which is safe for same-origin browser clients but won't grant
// cross-origin access to arbitrary domains.
//
// Allowlist sources (checked in order):
//  1. CINATRA_A2A_ALLOWED_ORIGINS — comma-separated list of explicit origins
//     e.g. "https://app.example.com,https://dev.example.com"
//  2. NEXT_PUBLIC_APP_URL — the canonical app origin (always included)
//  3. http://localhost:3000 — always included for local dev
//
// The `Vary: Origin` header is set on all responses so caches correctly
// differentiate CORS responses for different origins.
// ---------------------------------------------------------------------------

function buildAllowlist(): Set<string> {
  const canonical =
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const extras =
    process.env.CINATRA_A2A_ALLOWED_ORIGINS
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  return new Set([canonical, "http://localhost:3000", ...extras]);
}

// Build once at module load — env vars don't change at runtime.
const ALLOWED_ORIGINS = buildAllowlist();

export function allowedOrigin(req: Request): string {
  let origin: string;
  try {
    origin = req.headers.get("origin") ?? new URL(req.url).origin;
  } catch {
    return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  }
  return ALLOWED_ORIGINS.has(origin)
    ? origin
    : (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

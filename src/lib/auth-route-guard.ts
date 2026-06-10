import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { GENERATED_WIDGET_STREAM_PUBLIC_PATHS } from "@/lib/generated/widget-stream-public-paths";

const PUBLIC_PATH_PREFIXES = [
  "/permissions",
  "/api/auth",
  "/api/nango/webhook",
  "/api/mcp",      // MCP transport — auth is enforced by the transport handler itself
  "/api/a2a",      // A2A transport — auth enforced inside route handlers (Bearer JWT)
  "/api/llm-bridge", // WayFlow ApiNode bridge — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/context-resolve",  // Context-selection-agent resolve ApiNode — bridge/JWT auth + run-bound actor enforced inside (deriveContextRouteContext)
  "/api/context-finalize", // Context-selection-agent finalize ApiNode — bridge/JWT auth + run-bound actor enforced inside (deriveContextRouteContext)
  "/api/agents/passthrough", // Deterministic-dispatch passthrough — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/oas-lint",   // Agent-lint-policy scan-all endpoint — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/review",     // Review-merge endpoint — bridge-token auth enforced inside via isAuthorizedBridgeRequest. The route is kept for external callers that want the trust boundary without writing TypeScript. Host-app callers SHOULD use mergeReviewLanes from @cinatra-ai/agents directly.
  "/api/auditor",    // Auditor-agent run-skills/apply WayFlow ApiNode callbacks — bridge-token auth enforced inside via isAuthorizedBridgeRequest (direct UI/MCP callers still require a session in-handler)
  "/.well-known",  // OAuth / OIDC discovery metadata (RFC 8414, RFC 8707)
  "/api/wordpress/bundle.js", // Assistant widget bundle (public JS; also matcher-excluded as *.js). Precise path — do NOT broaden to /api/wordpress. Widget chat is covered by the generated PUBLIC_AGENT_STREAM_PATHS below.
  "/api/webhooks/wordpress", // WordPress publish-event webhook receiver — auth enforced inside route handler (HMAC-SHA256)
  "/api/health",   // Unauthenticated host-native Next.js health probe for local startup polling; no session is available
  "/api/extensions/purge", // Human-origin `cinatra extensions purge` CLI loopback POST — auth enforced inside the route handler (NODE_ENV!=production + CINATRA_RUNTIME_MODE=development + loopback-only, mirrors /api/skills/reset-repo). Without this exemption guardAppRoute 307s the unauthenticated loopback CLI to /sign-in before the handler's triple-guard runs.
];

// Only the CMS content-editor agent stream slugs are widget-public.
// These are hit by unauthenticated browser widgets (CMS admin pages) and the
// route handler enforces auth via CORS Origin allowlist + Bearer API key
// (see src/app/api/agents/[agentSlug]/stream/route.ts — generic widget-stream
// origin/token validation). The list is GENERATED from each extension's
// cinatra.widgetStream declaration (slug-only, proxy-bundle-safe file) — adding
// a widget-stream extension requires no edit here. Do NOT generalize to a
// /api/agents prefix — other agent routes must continue to require a session.
const PUBLIC_AGENT_STREAM_PATHS = GENERATED_WIDGET_STREAM_PUBLIC_PATHS;

const PUBLIC_EXACT_PATHS = [
  "/favicon.ico",
  "/sign-in",
  "/sign-up",
  "/api/openai/connection-status",
  "/api/app/setup-status",
  "/api/app/route-guard-status",
  "/api/chat", // Called internally from MCP handlers — auth is optional, userId used for personalization only
];

// Internal design-system verification route. Static React server component;
// renders only the shadcn primitive catalog, token swatches, and design
// fixtures. No DB queries, no user data. Public access is gated to
// non-production environments so the Playwright pixel-diff + axe-core harness
// (`tests/e2e/design/design-fixtures.spec.ts`) can capture baselines from a CI
// runner without an authenticated session, and so a production deployment still
// requires auth. Public auth bypasses should not become production precedent.
//
// Exception for the CI harness: the design-visual-verify workflow now runs
// against a PRODUCTION standalone build (NODE_ENV=production) — the legacy
// `pnpm dev` cold-compile of the app + 79 extensions exceeded any practical
// timeout. Under a production build the route would be auth-gated, so the
// unauthenticated readiness probe + Playwright would be 307'd to /sign-in. So
// the route is ALSO public when the explicit e2e switch
// `CINATRA_E2E_SETUP_BYPASS === "true"` is set — the SAME env the setup-wizard
// honors (src/lib/setup-wizard.ts), which is never set in a real production
// deployment. The route is dataless, so this exposes no user data even if the
// env were ever mis-set.
const DEV_ONLY_PUBLIC_EXACT_PATHS = ["/design-fixtures"];
function isDevOnlyPublicPath(pathname: string) {
  if (!DEV_ONLY_PUBLIC_EXACT_PATHS.includes(pathname)) return false;
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.CINATRA_E2E_SETUP_BYPASS === "true";
}

const SETUP_PATH_PREFIXES = [
  "/setup",
  "/configuration/llm/initial-setup",
  "/configuration/llm/openai",
  "/configuration/apps/openai",
];

function isPublicPath(pathname: string) {
  if (pathname.startsWith("/_next")) {
    return true;
  }

  if (pathname.startsWith("/images/")) {
    return true;
  }

  if (PUBLIC_EXACT_PATHS.includes(pathname)) {
    return true;
  }

  if (isDevOnlyPublicPath(pathname)) {
    return true;
  }

  // Only the two CMS content-editor agent stream slugs are widget-public.
  if (PUBLIC_AGENT_STREAM_PATHS.includes(pathname)) {
    return true;
  }

  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isSetupPath(pathname: string) {
  return SETUP_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function guardAppRoute(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check for session cookie only — no HTTP fetch back to the server.
  // Full session validation and setup-complete checks happen in API routes
  // and server components via better-auth. Middleware only gates unauthenticated
  // users (no cookie) from reaching protected routes at all.
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  return NextResponse.next();
}

export const authRouteGuardConfig = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml)$).*)"],
};

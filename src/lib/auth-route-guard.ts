import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
  GENERATED_WIDGET_STREAM_PUBLIC_PATHS,
  GENERATED_WIDGET_STREAM_TOKEN_PATHS,
  GENERATED_WIDGET_STREAM_CAPABILITY_PATHS,
} from "@/lib/generated/widget-stream-public-paths";
import { isRuntimeApprovedWidgetStreamPublicPath } from "@/lib/widget-stream-runtime-slug-snapshot";
import { frameAncestorsDirectiveFor } from "@/lib/embed/frame-ancestors.server";

const PUBLIC_PATH_PREFIXES = [
  "/permissions",
  "/api/auth",
  "/api/nango/webhook", // Nango auth-event webhook receiver — auth enforced inside the nango-connector route handler (HMAC-SHA256 over the raw body keyed by the Nango environment API secret key NANGO_SECRET_KEY, matching how self-hosted nango-server signs the X-Nango-Hmac-Sha256 header); an unsigned/invalid/unconfigured signature fails closed. The sender is an unauthenticated third party (Nango), so there is no session.
  "/api/mcp",      // MCP transport — auth is enforced by the transport handler itself
  "/api/cli",      // cinatra CLI control-plane — auth enforced inside each route handler via authorizeCliRequest (src/lib/cli-api/route-guard.ts): a Better-Auth session, a JWKS-verified OAuth Bearer on the DEDICATED /api/cli audience (reciprocal isolation from /api/mcp above) with per-endpoint scope + LIVE role resolution, or the loopback dev-admin bypass. The published `cinatra` bin drives a remote instance as a COOKIELESS OAuth API client, so without this exemption guardAppRoute 307s every /api/cli/* request (reconcile / status / agent export|import) to /sign-in before authorizeCliRequest runs — the CLI then receives the /sign-in HTML and crashes parsing it as JSON. Reachability only; the route still self-authorizes (a caller with no valid Bearer/session/bypass gets the route's own 401, never data).
  "/api/a2a",      // A2A transport — auth enforced inside route handlers (Bearer JWT)
  "/api/llm-bridge", // WayFlow ApiNode bridge — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/context-resolve",  // Context-selection-agent resolve ApiNode — bridge/JWT auth + run-bound actor enforced inside (deriveContextRouteContext)
  "/api/context-finalize", // Context-selection-agent finalize ApiNode — bridge/JWT auth + run-bound actor enforced inside (deriveContextRouteContext)
  "/api/agents/passthrough", // Deterministic-dispatch passthrough — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/oas-lint",   // Agent-lint-policy scan-all endpoint — bridge-token auth enforced inside via isAuthorizedBridgeRequest
  "/api/review",     // Review-merge endpoint — bridge-token auth enforced inside via isAuthorizedBridgeRequest. The route is kept for external callers that want the trust boundary without writing TypeScript. Host-app callers SHOULD use mergeReviewLanes from @cinatra-ai/agents directly.
  "/api/auditor",    // run-skills WayFlow ApiNode callback — bridge-token auth enforced inside via isAuthorizedBridgeRequest (direct UI/MCP callers still require a session in-handler). cinatra#1796 / #2047 row 8: the /apply + /exclude callbacks under this prefix were DELETED with the auditor retirement; run-skills was outside the authorized scope and is kept, so the prefix stays. Codex flagged the breadth of this exemption as a bounded latent risk — narrowing it (or removing run-skills outright) is an owner-gated follow-up, NOT this PR.
  "/.well-known",  // OAuth / OIDC discovery metadata (RFC 8414, RFC 8707)
  "/api/webhooks/wordpress", // WordPress publish-event webhook receiver — auth enforced inside route handler (HMAC-SHA256)
  "/api/connect/token", // cinatra#221 Connect provisioning code/install-code exchange — server-to-server (CMS backend); auth enforced inside via the authorization-code/PKCE/install-code itself (no session, no cookies), mirrors /api/webhooks/wordpress. NOTE: /connect/authorize is NOT exempted — it stays session-gated (org-admin consent screen).
  "/api/widget-auth/init", // cinatra#407 hosted /widget-auth PKCE login — server-to-server transaction init; auth enforced inside via the per-site `cnx_` credential (no session). NOTE: the /widget-auth PAGE is exempted separately below (it must render the login form for a SESSIONLESS visitor instead of 307→/sign-in).
  "/api/widget-auth/token", // cinatra#407 hosted /widget-auth PKCE login — server-to-server code→user-token redeem; auth enforced inside via the per-site `cnx_` credential + PKCE (no session), mirrors /api/connect/token.
  "/api/health",   // Unauthenticated host-native Next.js health probe for local startup polling; no session is available
  "/api/extensions/purge", // Human-origin `cinatra extensions purge` CLI loopback POST — auth enforced inside the route handler (NODE_ENV!=production + CINATRA_RUNTIME_MODE=development + loopback-only, mirrors /api/skills/reset-repo). Without this exemption guardAppRoute 307s the unauthenticated loopback CLI to /sign-in before the handler's triple-guard runs.
  "/webhook", // cinatra#340 generic inbound-webhook namespace — a webhook arrives from an unauthenticated connected site; auth is the Standard-Webhooks signature enforced INSIDE the route (verified via the per-binding secret resolved from the server-issued opaque bindingId, never the payload). One static namespace prefix (the route owns the declared→dispatch / undeclared→404 verdict, so an undeclared hook 404s rather than 307s); do NOT import GENERATED_WEBHOOK_PUBLIC_PREFIXES here. NOTE: /api/webhooks/wordpress stays a SEPARATE hand-pin above (#343 supersedes it).
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

// Token-exchange + capabilities siblings of each widget-stream slug (cinatra#220),
// GENERATED from the same cinatra.widgetStream declarations as the stream paths.
// "Public path" here means "skip the Better-Auth session redirect so the route
// enforces its OWN auth" — a self-authenticating route NOT on this list gets
// 307'd to /sign-in before its handler runs. Each route still enforces auth:
//   - .../token: server-to-server long-lived-key Bearer auth INSIDE the handler;
//   - .../capabilities: AUTH-FREE static contract metadata (leaks no instance data).
// Exact slug paths only — do NOT broaden to an /api/agents prefix (that would
// make every agent route public).
const PUBLIC_AGENT_TOKEN_PATHS = GENERATED_WIDGET_STREAM_TOKEN_PATHS;
const PUBLIC_AGENT_CAPABILITY_PATHS = GENERATED_WIDGET_STREAM_CAPABILITY_PATHS;

// cinatra#1221 S5 Lane B (§2/§7). The provisional embed-page path (OQ2): if it
// is renamed, ONLY this constant + the CMS iframe `src` change; the bridge and
// schemas are stable.
const EMBED_ASSISTANT_PATH = "/embed/assistant";

const PUBLIC_EXACT_PATHS = [
  "/favicon.ico",
  "/sign-in",
  "/sign-up",
  "/widget-auth", // cinatra#407 hosted widget login — a SESSIONLESS visitor must render the login form here (NOT be 307'd to /sign-in). The page itself reads a present session normally and gates issuing a code on org membership + explicit consent. Exact path only (the ?txn=... query carries the transaction id).
  "/api/assistants/chat", // cinatra#1221 S5 — the UNIFIED assistant chat route also serves the public-site (WordPress/Drupal) widget via its broker-auth branch (Bearer cit_ + X-Cinatra-Widget-User-Token cwu_). A cross-origin browser widget holds no cookie, so the middleware must NOT 307 it to /sign-in — the route's OWN dual-token fail-closed sequence is the authoritative gate (a non-widget, session-less request still 401s inside the handler; the cookie-session @cinatra path is byte-unchanged). Exact path only (no widget subpaths are public).
  "/api/assistants/chat/capabilities", // cinatra#1998 Lane A (epic #1216 S6) — the capability-negotiation surface the cross-origin embed GETs client-side with `credentials:"omit"` + the SAME broker-auth headers (Bearer cit_ + X-Cinatra-Widget-User-Token cwu_ + the forwarded parent origin/handle). A sessionless broker embed holds no cookie, so the middleware must NOT 307 it to /sign-in before the handler's OWN dual-token fail-closed sequence can authenticate it and serve the static advertisement (a sessionless, non-broker request still 401s inside the handler; the cookie-session /chat negotiation is byte-unchanged). Exact path only.
  EMBED_ASSISTANT_PATH, // cinatra#1221 S5 Lane B — the Cinatra-served embed page GET /embed/assistant (§2). A SESSIONLESS cross-origin CMS end user must RENDER the iframe shell here, not be 307'd to /sign-in (exactly like /widget-auth). The page renders NO user data before a bootstrap; tokens are NEVER in the URL — they arrive only via the postMessage bootstrap (§4). The per-request `frame-ancestors` CSP is applied below (§7). Exact path only (the ?instanceId=…&assistant=… query carries the non-secret disambiguators).
  "/api/openai/connection-status",
  "/api/app/setup-status",
  "/api/app/route-guard-status",
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
// "/design-fixtures/marketplace-detail-modal" (cinatra#989/#739): the §V
// detail-modal seeded-fixture route — same static, dataless, seeded-render
// contract as the index page (its Playwright guard runs in the same
// production-standalone design-visual-verify harness).
// "/design-fixtures/conformance" (cinatra#985): the design-conformance
// functional-acceptance harness — same static, dataless, seeded-render
// contract (real components mounted with deterministic fixtures; no DB, no
// user data); its Playwright suite runs in the same production-standalone
// design-visual-verify harness.
// "/design-fixtures/conformance/seeded" (cinatra#986): the SEEDED
// data-contract harness — real components rendered from the run-namespaced
// seeded fixture kit (deterministic fixture rows only; no user data). Its
// Playwright suite runs in the same production-standalone harness. Unlike its
// siblings it READS the canonical installed_extension store (fixture rows the
// seed endpoint provisioned); it exposes no user data.
// "/design-fixtures/conformance/seed" (cinatra#986): the seeded-fixture
// provisioning endpoint. The handler additionally SELF-GUARDS with the same
// non-production/CINATRA_E2E_SETUP_BYPASS contract and only ever writes
// deterministic fixture rows inside the @cinatra-e2e/<runId>-- namespace
// through the real extension lifecycle primitive.
// "/design-fixtures/agents-card" (cinatra#1121): the /agents All-Agents card
// accent-panel-as-detail-hotspot fixture — same static, dataless, seeded-render
// contract as its siblings (the real AgentAllCard mounted with an injected
// detail loader; no DB, no user data). Its Playwright guard runs in the same
// production-standalone design-visual-verify harness.
// "/design-fixtures/header-rule" (cinatra#1101): the page-header SECTION-RULE
// conformance harness — the REAL shared chrome (PageHeader divider + TabsListRow,
// both → <Separator major> → .divider-etched) mounted beside the app.html
// reference rule so the header-rule gate can pixel-classify the etched
// paired-line divider. Same static, dataless, seeded-render contract as its
// siblings (no DB, no user data); its Playwright suite runs in the same
// production-standalone design-visual-verify harness. Without this exemption
// guardAppRoute 307s the unauthenticated harness to /sign-in before the fixture
// renders, so the gate's own specs time out locating the fixture testids.
const DEV_ONLY_PUBLIC_EXACT_PATHS = [
  "/design-fixtures",
  "/design-fixtures/marketplace-detail-modal",
  "/design-fixtures/conformance",
  "/design-fixtures/conformance/seeded",
  "/design-fixtures/conformance/seed",
  "/design-fixtures/agents-card",
  "/design-fixtures/header-rule",
];
function isDevOnlyPublicPath(pathname: string) {
  if (!DEV_ONLY_PUBLIC_EXACT_PATHS.includes(pathname)) return false;
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.CINATRA_E2E_SETUP_BYPASS === "true";
}

// cinatra#1881 — the assistant AG-UI resume/tail route
// (GET /api/assistants/runs/<runId>/stream). A cookieless caller resuming a
// dropped run (the S5 public-site CMS widget, #1221, under its run-bound resume
// token) holds no Better-Auth cookie, so the middleware must NOT 307 it to
// /sign-in before the handler's own fail-closed auth can run — matching the
// posture /api/assistants/chat already has. The handler
// (src/app/api/assistants/runs/[runId]/stream/route.ts) is the authoritative
// gate: MODE 1 a Better-Auth SESSION, else MODE 2 a DISTINCT, short-lived,
// RUN-BOUND resume token (`cinatra.widget.chat-resume`, #1855) verified against
// THIS exact runId + its own audience; any missing/invalid/expired/cross-run/
// cross-type token — and a sessionless caller with no token — is an EXPLICIT
// 401. NARROW dynamic matcher: the runId segment is a UUID (minted via
// randomUUID(), see src/lib/assistant-runtime/ag-ui-stream-route.ts) and the
// path must TERMINATE at /stream, so a sibling /api/assistants/runs/<id>/<other>
// or a non-UUID segment stays session-guarded. A too-narrow match only 307s a
// legit resume (self-healing → client degrades to a fresh mount); it can never
// open a protected route. Structural match ONLY — never an /api/assistants
// prefix (that would expose every sibling assistant API route).
//
// SCOPE (#1881, DEFERRED): this opens the SAME-ORIGIN cookieless resume path
// only. The cross-origin half stays deferred — the shared CORS builder still
// permits only POST/OPTIONS and does not expose/reflect the resume-token header,
// Authorization, or Last-Event-ID on a GET, so a real cross-origin resume
// additionally needs that header exposure + OPTIONS/GET origin reflection, which
// rides the embed wave. The CORS builder is intentionally UNTOUCHED here.
const ASSISTANT_RUN_STREAM_PATH =
  /^\/api\/assistants\/runs\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/stream$/;
function isAssistantRunStreamPath(pathname: string) {
  return ASSISTANT_RUN_STREAM_PATH.test(pathname);
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

  // The token-exchange + capabilities siblings of those exact slugs (cinatra#220).
  // Each enforces its own auth in-handler (token: long-lived key; capabilities:
  // auth-free static metadata). Exact-match only — never an /api/agents prefix.
  if (
    PUBLIC_AGENT_TOKEN_PATHS.includes(pathname) ||
    PUBLIC_AGENT_CAPABILITY_PATHS.includes(pathname)
  ) {
    return true;
  }

  // RUNTIME-approved widget-stream slugs (widget-stream runtime trust, slice 4).
  // A widget-stream connector approved at RUNTIME (its metadata grant admin-
  // approved after build) is not in the generated build-time arrays above, so
  // its three exact /api/agents/<slug>/{stream,token,capabilities} paths would
  // 307 to /sign-in before their in-handler auth runs. A per-replica in-memory
  // snapshot (kept warm out-of-band by a background refresher over the approved
  // grants) unions those exact paths in. Checked AFTER the build-time arrays so
  // build-time wins absolutely (the runtime snapshot drops any build-time-slug
  // collision). This is PURE LIVENESS — an EXACT-match, DB-free, synchronous
  // redirect-skip; each route still self-authenticates in its handler and the
  // fail-closed in-handler runtime resolver is the real wall. A cold/stale
  // snapshot can only ever 307 a legit widget route (self-healing), never open
  // a protected one, and never an /api/agents wildcard. Valid because in Next 16
  // the proxy always runs on the Node.js runtime (see src/proxy.ts).
  if (isRuntimeApprovedWidgetStreamPublicPath(pathname)) {
    return true;
  }

  // cinatra#1881 — the assistant AG-UI resume/tail stream. NARROW UUID-shaped
  // dynamic matcher (not an /api/assistants prefix); the handler's own session-
  // OR-resume-token fail-closed auth is the gate. See ASSISTANT_RUN_STREAM_PATH.
  if (isAssistantRunStreamPath(pathname)) {
    return true;
  }

  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isSetupPath(pathname: string) {
  return SETUP_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// cinatra#1221 S5 Lane B §7 — apply the per-request `frame-ancestors` CSP to the
// embed page. An RSC cannot set a per-request response header, so the directive
// is computed by the read-only, exception-wrapped resolver and set HERE for this
// ONE exact path. FAIL-CLOSED to `'none'` on EVERY failure (unknown assistant,
// missing/duplicate/non-normalizable instance row, any thrown DB/normalize
// exception — the resolver never throws): a `'none'` page still renders the
// shell but the browser refuses to frame it anywhere (a safe, debuggable wall).
// NO `'self'` (the policy is "ONLY the registered site"; `'self'` would let the
// Cinatra origin frame it too). `X-Frame-Options` is OMITTED deliberately (XFO
// cannot express an allow-list origin and would override to SAMEORIGIN, blocking
// the legitimate CMS frame). `Cache-Control: no-store` so a per-instance CSP is
// never cached and served to a different instance. Gated on the EXACT path so no
// other route pays.
function applyEmbedFrameAncestors(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  const directive = frameAncestorsDirectiveFor({
    assistant: request.nextUrl.searchParams.get("assistant"),
    instanceId: request.nextUrl.searchParams.get("instanceId"),
  });
  response.headers.set("Content-Security-Policy", `frame-ancestors ${directive}`);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function guardAppRoute(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // The embed page is public (below) AND carries a per-request frame-ancestors
  // CSP (§7). Handle it first so the header is set on the response.
  if (pathname === EMBED_ASSISTANT_PATH) {
    return applyEmbedFrameAncestors(request);
  }

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

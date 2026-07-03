/**
 * All-routes render-smoke — automates the manual all-routes render-smoke pass.
 *
 * Data-driven: the route inventory is enumerated at RUN TIME from
 * `find src/app -name page.tsx` (NOT a hand-curated list), so adding a new
 * static page.tsx is picked up on the next run with no spec edit. Each page.tsx
 * path is converted to its URL route (route groups `(...)` dropped), then the
 * set is split into STATIC vs DYNAMIC (`[param]` / `[...catch-all]` segments).
 *
 * Optional-catch-all routes (`[[...slug]]`) are a special case: their trailing
 * optional segment matches the EMPTY path, so the route with that segment
 * stripped (e.g. `chat/[[...slug]]` → `/chat`) is a real, reachable, render-
 * smokeable BASE route with no synthesized param. The base route is treated as
 * STATIC; only routes that still carry a `[param]` / `[...catch-all]` after
 * that stripping stay DYNAMIC-skipped.
 *
 * For each STATIC route the spec visits it under the platform-admin storageState
 * (auth.setup.ts) with `CINATRA_E2E_SETUP_BYPASS=true` (set on the webServer /
 * the CI server) and asserts the FLOOR:
 *   - the response is NOT an HTTP 500, AND
 *   - the page did NOT render the error boundary ("Application Error" /
 *     Next.js "Application error: a {client|server}-side exception …").
 * This is a no-500 / no-error-boundary FLOOR, NOT a behavioral or pixel claim.
 *
 * A redirect to /sign-in counts as PASS ONLY for genuinely public/unauth routes
 * (the allow-list derived from src/lib/auth-route-guard.ts — /sign-in, /sign-up,
 * /setup/*, /permissions/*, /accept-invitation, and the dev-public
 * /design-fixtures + /api/mcp/* pages). A /sign-in redirect on a should-render
 * route is a FAIL (the admin session should have rendered it).
 *
 * A redirect to /not-authorized is ALWAYS a FAIL on a should-render route: it
 * means requireAdminSession (src/lib/auth-session.ts) saw a non-admin session,
 * i.e. the admin storageState did not take. Treating it as anything but a
 * failure would let auth-denied admin pages false-pass.
 *
 * The DYNAMIC routes are SKIPPED-with-reason; the skipped list and the
 * count of static routes visited are printed to the run output AND attached to
 * the test report so "automated render-smoke" never silently overstates coverage.
 *
 * EXCEPTION to the dynamic skip (twenty-connector#39): the connector setup
 * dispatch route `/connectors/[vendor]/[slug]/[subroute]` has a fully
 * ENUMERABLE instance set — the connectors-catalog descriptors. Each catalog
 * connector's real setup route is visited under the same floor, because these
 * pages bind host server actions into `<form action>` and an RSC-serialization
 * regression there is invisible to every unit suite while 500ing the page for
 * the platform admin (the exact shipped failure this suite now pins).
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
// CLI-safe, dependency-free catalog data (plain .mjs, no imports — the same
// module the plain-Node CLI consumes), so a Playwright spec can import it
// directly. Source of the connector setup-page route enumeration below.
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

// ---------------------------------------------------------------------------
// Route enumeration (from source, at run time)
// ---------------------------------------------------------------------------

/** Enumerate every `src/app/**​/page.tsx` relative to the repo root. */
function enumeratePageFiles(): string[] {
  const cwd = resolve(process.cwd());
  const out = execFileSync("find", ["src/app", "-name", "page.tsx"], {
    cwd,
    encoding: "utf-8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/** True for an optional-catch-all segment: `[[...slug]]`. */
function isOptionalCatchAllSegment(seg: string): boolean {
  return seg.startsWith("[[...") && seg.endsWith("]]");
}

/** True for any dynamic placeholder segment: `[param]`, `[...x]`, or `[[...x]]`. */
function isDynamicSegment(seg: string): boolean {
  return seg.startsWith("[") && seg.endsWith("]");
}

/**
 * Convert a `src/app/.../page.tsx` path to its URL route. Route-group segments
 * — `(group)` — are layout-only and contribute nothing to the URL, so they are
 * dropped. A TRAILING optional-catch-all segment (`[[...slug]]`) is also dropped:
 * it matches the empty path, so the remaining path is the route's reachable base
 * (e.g. `chat/[[...slug]]` → `/chat`). The root page maps to "/".
 */
function pageFileToRoute(file: string): string {
  const rel = file.replace(/^src\/app/, "").replace(/\/page\.tsx$/, "");
  const segments = rel
    .split("/")
    .filter((seg) => seg.length > 0 && !(seg.startsWith("(") && seg.endsWith(")")));
  if (segments.length > 0 && isOptionalCatchAllSegment(segments[segments.length - 1])) {
    segments.pop();
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/**
 * A route is DYNAMIC when any remaining segment is a `[param]` or
 * `[...catch-all]` placeholder — those need real IDs to render and are
 * skipped-with-reason. Optional-catch-all base routes have already had their
 * trailing `[[...x]]` stripped by pageFileToRoute, so a route that reaches here
 * with no bracket segment left is STATIC (render-smokeable).
 */
function isDynamicRoute(route: string): boolean {
  return route.split("/").some(isDynamicSegment);
}

const ALL_ROUTES = [...new Set(enumeratePageFiles().map(pageFileToRoute))].sort();
const STATIC_ROUTES = ALL_ROUTES.filter((r) => !isDynamicRoute(r));
const DYNAMIC_ROUTES = ALL_ROUTES.filter(isDynamicRoute);

// ---------------------------------------------------------------------------
// Connector setup-page routes (dynamic-but-ENUMERABLE — twenty-connector#39)
//
// `/connectors/[vendor]/[slug]/[subroute]` is a dynamic route, so the generic
// enumeration skips it — which is exactly how the twenty-connector setup page
// shipped a deterministic admin-session 500 (a non-server-reference function
// bound into `<form action>`; RSC rejects it at render, digest 1769553696)
// while every unit suite stayed green: nothing rendered these pages to a
// client payload. The catalog descriptors make the real instances enumerable
// at run time (no hand-curated list): every catalog connector's setup page is
// `/connectors/<vendor>/<slug>/<setupSubroute>`, with the vendor segment
// derived from the packageId scope the same way the dispatch route derives it.
// These render under the SAME floor as the static routes below.
// ---------------------------------------------------------------------------

const CONNECTOR_SETUP_ROUTES = CONNECTOR_DESCRIPTORS.map(
  (d: { packageId: string; slug: string; setupSubroute: string }) =>
    `/connectors/${d.packageId.replace(/^@/, "").split("/")[0]}/${d.slug}/${d.setupSubroute}`,
).sort();

// ---------------------------------------------------------------------------
// Public / unauth allow-list (derived from src/lib/auth-route-guard.ts)
//
// For these routes a redirect to /sign-in is the EXPECTED behavior, so a
// /sign-in redirect counts as PASS. For every other route the admin session
// should render the page — a /sign-in redirect is a FAIL.
// ---------------------------------------------------------------------------

const PUBLIC_EXACT_PATHS = new Set<string>([
  "/sign-in",
  "/sign-up",
  "/accept-invitation",
  // Dataless dev-public design verification route; public only when
  // NODE_ENV!=production OR CINATRA_E2E_SETUP_BYPASS=true (this suite sets it).
  "/design-fixtures",
]);

// Setup-wizard prefixes are auth-optional (gated by setup-completion, not a
// session). With CINATRA_E2E_SETUP_BYPASS=true they render; a /sign-in redirect
// is nevertheless acceptable for them.
const PUBLIC_PREFIXES = ["/setup", "/permissions", "/api/mcp"];

function isPublicRoute(route: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(route)) return true;
  return PUBLIC_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
}

// ---------------------------------------------------------------------------
// Error-boundary detection
// ---------------------------------------------------------------------------

/** Both the custom global-error chrome AND the default Next.js boundary copy. */
const ERROR_BOUNDARY_MARKERS = [
  "Application Error", // src/app/global-error.tsx <h1>
  "Application error: a client-side exception has occurred", // Next default
  "Application error: a server-side exception has occurred", // Next default
];

async function trippedErrorBoundary(page: Page): Promise<string | null> {
  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  for (const marker of ERROR_BOUNDARY_MARKERS) {
    if (body.includes(marker)) return marker;
  }
  return null;
}

// ---------------------------------------------------------------------------
// record the skipped inventory + the visited count.
// ---------------------------------------------------------------------------

function buildInventorySummary(): string {
  const skipped = DYNAMIC_ROUTES.map((r) =>
    r === "/connectors/[vendor]/[slug]/[subroute]"
      ? `  - ${r}  (dynamic-[segment]; catalog instances visited separately — see "connector setup" count)`
      : `  - ${r}  (dynamic-[segment]; needs real ID / seeded data)`,
  );
  return [
    `Render-smoke route inventory (enumerated from src/app at run time):`,
    `  total routes:            ${ALL_ROUTES.length}`,
    `  static visited:          ${STATIC_ROUTES.length}`,
    `  connector setup visited: ${CONNECTOR_SETUP_ROUTES.length} (enumerated from the connectors catalog)`,
    `  dynamic skipped:         ${DYNAMIC_ROUTES.length}`,
    ``,
    `Skipped routes (reasons):`,
    ...skipped,
  ].join("\n");
}

test.beforeAll(() => {
  // Surface the inventory in the run output regardless of which test attaches it.
  // eslint-disable-next-line no-console
  console.log(`\n${buildInventorySummary()}\n`);
});

// ---------------------------------------------------------------------------
// One test per STATIC route.
// ---------------------------------------------------------------------------

test.describe("all-routes render-smoke (static)", () => {
  // Guard: the inventory must be non-empty (a broken `find` would otherwise
  // silently pass a zero-route suite). Also attaches the skipped-route ledger
  // to the report from a real test context.
  test("enumerates a non-empty static-route inventory", async () => {
    expect(STATIC_ROUTES.length).toBeGreaterThan(0);
    await test.info().attach("render-smoke-skipped-routes.txt", {
      body: buildInventorySummary(),
      contentType: "text/plain",
    });
  });

  for (const route of STATIC_ROUTES) {
    test(`renders ${route}`, async ({ page }) => {
      await visitAndAssertRenderFloor(page, route);
    });
  }
});

// Shared per-route floor: not-5xx, no error boundary, no unexpected auth
// redirect. Used by both the static enumeration and the connector setup-page
// enumeration below.
async function visitAndAssertRenderFloor(page: Page, route: string): Promise<void> {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });

  const status = response?.status() ?? 0;
  expect(
    status,
    `${route} returned HTTP ${status} (expected not 5xx)`,
  ).toBeLessThan(500);

  // Redirect handling: a /sign-in redirect is a PASS only for genuinely
  // public/unauth routes; otherwise the admin session should have rendered.
  const landedPath = new URL(page.url()).pathname;
  if (landedPath.startsWith("/sign-in")) {
    expect(
      isPublicRoute(route),
      `${route} redirected to /sign-in under an admin session — should-render route must NOT redirect`,
    ).toBeTruthy();
    return;
  }

  // A /not-authorized redirect proves the admin session didn't take
  // (requireAdminSession redirects non-admins there). On a should-render
  // route this is ALWAYS a FAIL — never let an auth-denied admin page
  // false-pass as "rendered". The `route !== landedPath` guard is what
  // makes this a *redirect* check: visiting the /not-authorized page itself
  // lands on /not-authorized with no redirect, and must still render.
  if (landedPath.startsWith("/not-authorized") && route !== landedPath) {
    expect(
      false,
      `${route} redirected to /not-authorized — admin session did not take (saved storageState is not platform-admin)`,
    ).toBeTruthy();
    return;
  }

  // Error-boundary FLOOR: the page must not be the error boundary chrome.
  const marker = await trippedErrorBoundary(page);
  expect(marker, `${route} tripped the error boundary ("${marker}")`).toBeNull();
}

// ---------------------------------------------------------------------------
// One test per CONNECTOR SETUP route (catalog-enumerated dynamic instances).
//
// Regression surface for twenty-connector#39: these pages render connector-
// bound host server actions into `<form action={…}>` — an RSC-serialization
// failure there is INVISIBLE to unit suites (nothing renders the page to a
// client payload) and 500s deterministically for the platform admin. The
// floor is identical to the static pass; a not-installed connector legitimately
// renders its Install/Activate CTA or "requires rebuild" state (200), and a
// policy-denied one 404s — all pass the floor; only a 5xx / error boundary /
// auth redirect fails.
// ---------------------------------------------------------------------------

test.describe("connector setup-page render-smoke (catalog-enumerated)", () => {
  test("enumerates a non-empty connector setup-route inventory", () => {
    expect(CONNECTOR_SETUP_ROUTES.length).toBeGreaterThan(0);
  });

  for (const route of CONNECTOR_SETUP_ROUTES) {
    test(`renders ${route}`, async ({ page }) => {
      await visitAndAssertRenderFloor(page, route);
    });
  }
});

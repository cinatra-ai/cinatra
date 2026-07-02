/**
 * Regression test for the auth-route-guard PUBLIC_PATH_PREFIXES list.
 *
 * `/api/oas-lint` and `/api/review` must stay in PUBLIC_PATH_PREFIXES.
 * Both routes rely on `isAuthorizedBridgeRequest()` inside the handler for
 * auth, but without the prefix exemption, the auth-route-guard would redirect
 * unauthenticated WayFlow ApiNode calls to /sign-in before the handler runs.
 *
 * This test pins the prefix list so any future refactor that drops these
 * entries breaks the test, not silently breaks WayFlow -> Cinatra calls.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { guardAppRoute } from "../auth-route-guard";
import type { NextRequest } from "next/server";

const GUARD_PATH = path.resolve(__dirname, "..", "auth-route-guard.ts");
const guardSource = fs.readFileSync(GUARD_PATH, "utf-8");

// A minimal NextRequest-shaped object for behavioral guard tests: only the
// fields guardAppRoute reads (nextUrl.pathname, url, the session cookie). No
// session cookie is present, so a protected path would 307 → /sign-in; a
// PUBLIC path returns NextResponse.next() (status 200, no Location).
function fakeRequest(pathname: string): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost${pathname}`,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}

const WIDGET_PATHS_PATH = path.resolve(
  __dirname,
  "..",
  "generated",
  "widget-stream-public-paths.ts",
);
const widgetPathsSource = fs.readFileSync(WIDGET_PATHS_PATH, "utf-8");

describe("auth-route-guard PUBLIC_PATH_PREFIXES - WayFlow ApiNode bridge routes", () => {
  it("contains /api/llm-bridge (existing pattern)", () => {
    expect(guardSource).toMatch(/"\/api\/llm-bridge"/);
  });

  it("contains /api/oas-lint (agent-lint-policy scan-all endpoint)", () => {
    expect(guardSource).toMatch(/"\/api\/oas-lint"/);
  });

  it("contains /api/review (review-merge endpoint for external callers)", () => {
    expect(guardSource).toMatch(/"\/api\/review"/);
  });

  it("contains /api/auditor (auditor-agent run-skills/apply WayFlow ApiNode callbacks)", () => {
    expect(guardSource).toMatch(/"\/api\/auditor"/);
  });

  it("contains /api/extensions/purge (cinatra extensions purge CLI loopback; in-handler NODE_ENV+devmode+loopback guard)", () => {
    expect(guardSource).toMatch(/"\/api\/extensions\/purge"/);
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/extensions/purge"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/auth enforced inside/);
  });

  it("contains /api/connect/token (cinatra#221 connect provisioning exchange; server-to-server, in-handler code/PKCE/install-code auth)", () => {
    expect(guardSource).toMatch(/"\/api\/connect\/token"/);
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/connect/token"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/auth enforced inside/);
  });

  it("contains the /webhook generic inbound-webhook namespace (cinatra#340; in-handler Standard-Webhooks signature auth)", () => {
    expect(guardSource).toMatch(/"\/webhook"/);
    const line = guardSource.split("\n").find((l) => /"\/webhook",/.test(l));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/standard-webhooks signature/);
    // It must be ONE static namespace prefix — the guard must never IMPORT the
    // generated webhook-prefix list (the route owns the declared/undeclared 404
    // verdict). A comment naming it as the thing NOT to import is fine; the
    // load-bearing check is that the generated module is never imported.
    expect(guardSource).not.toMatch(/from\s+["']@\/lib\/generated\/webhook-public-paths["']/);
  });

  it("keeps /api/webhooks/wordpress as a SEPARATE hand-pin (the #343 boundary), not folded into /webhook", () => {
    expect(guardSource).toMatch(/"\/api\/webhooks\/wordpress"/);
  });

  it("does NOT exempt /connect/authorize (the consent screen stays session-gated)", () => {
    // The authorize page is a server component behind the normal auth-route
    // guard — it must never appear in the public-path list.
    expect(guardSource).not.toMatch(/"\/connect\/authorize"/);
    expect(guardSource).not.toMatch(/"\/api\/connect\/authorize"/);
  });

  it("each prefix has an inline comment documenting that auth is enforced inside the handler", () => {
    // Defense against silent removal: every bridge-route entry must
    // call out the in-handler auth gate so a future contributor doesn't
    // accidentally treat these as "unauthenticated public endpoints."
    const lines = guardSource.split("\n");
    const bridgeRouteLines = lines.filter(
      (line) =>
        line.includes('"/api/llm-bridge"') ||
        line.includes('"/api/oas-lint"') ||
        line.includes('"/api/review"') ||
        line.includes('"/api/auditor"'),
    );
    expect(bridgeRouteLines.length).toBe(4);
    for (const line of bridgeRouteLines) {
      // Each line should mention "auth" somewhere (case-insensitive)
      expect(line.toLowerCase()).toMatch(/auth/);
    }
  });
});

describe("auth-route-guard - cinatra#407 hosted /widget-auth surface", () => {
  // The two server-to-server routes are PREFIX-exempt (self-authenticated by the
  // per-site cnx_ credential inside the handler); the hosted PAGE is EXACT-exempt
  // so a sessionless visitor renders the login form instead of being 307'd.

  it("exempts /api/widget-auth/init (server-to-server transaction init; in-handler cnx_ auth)", () => {
    expect(guardSource).toMatch(/"\/api\/widget-auth\/init"/);
    const line = guardSource.split("\n").find((l) => l.includes('"/api/widget-auth/init"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/auth enforced inside/);
  });

  it("exempts /api/widget-auth/token (server-to-server redeem; in-handler cnx_ + PKCE auth)", () => {
    expect(guardSource).toMatch(/"\/api\/widget-auth\/token"/);
    const line = guardSource.split("\n").find((l) => l.includes('"/api/widget-auth/token"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/auth enforced inside/);
  });

  it("EXACT-exempts the /widget-auth page so a sessionless visitor renders login (not 307→/sign-in)", () => {
    // It must be in PUBLIC_EXACT_PATHS (so it matches the bare pathname, the
    // ?txn=... query stripped), NOT a broad prefix that would expose sub-paths.
    expect(guardSource).toMatch(/"\/widget-auth",\s*\/\//);
    expect(guardSource).not.toMatch(/"\/widget-auth\//); // never a prefix entry
  });

  it("does NOT exempt /api/widget-auth as a broad prefix (only the two precise routes)", () => {
    // A bare "/api/widget-auth" prefix would expose any future sub-route. Only
    // the init + token leaf paths are listed.
    const lines = guardSource.split("\n");
    const hasBroad = lines.some((l) => /"\/api\/widget-auth"\s*,/.test(l));
    expect(hasBroad).toBe(false);
  });
});

describe("auth-route-guard - CMS widget public surface stays NARROW", () => {
  // The WP plugin / Drupal module extraction narrowed the public WordPress
  // surface from the broad legacy `/api/wordpress-widget` prefix to the precise
  // `/api/wordpress/bundle.js` bundle path. Broadening it back to `/api/wordpress`
  // would expose EVERY WordPress API route unauthenticated. These regressions are a
  // source edit, so a source-text pin (matching this file's style) is the right guard.

  it("exposes the PRECISE WordPress bundle path, never a broad /api/wordpress prefix", () => {
    expect(guardSource).toMatch(/"\/api\/wordpress\/bundle\.js"/);
    // The broad prefix entry must NOT exist (would make all WP API routes public).
    expect(guardSource).not.toMatch(/"\/api\/wordpress"/);
  });

  it("drops the pre-rename `*-widget` public prefixes", () => {
    expect(guardSource).not.toMatch(/"\/api\/wordpress-widget"/);
    expect(guardSource).not.toMatch(/"\/api\/drupal-widget"/);
  });

  it("keeps the 'do NOT broaden' guard comment on the WordPress bundle entry", () => {
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/wordpress/bundle.js"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/do not broaden/);
  });

  // Helper: extract the array entries of a single generated `export const NAME`
  // block so each list can be asserted in isolation (cinatra#220 added two more
  // lists to the same file).
  function entriesOf(name: string): string[] {
    const block = widgetPathsSource.match(
      new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`),
    );
    expect(block, `missing generated list ${name}`).toBeTruthy();
    return [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  it("widget-public agent streams are exact generated slugs, not a broad /api/agents prefix", () => {
    // The exact-path list is GENERATED from each extension's cinatra.widgetStream
    // declaration; the guard consumes it as PUBLIC_AGENT_STREAM_PATHS. The two
    // CMS slugs must be present in the generated list...
    expect(widgetPathsSource).toMatch(
      /"\/api\/agents\/wordpress-content-editor\/stream"/,
    );
    expect(widgetPathsSource).toMatch(
      /"\/api\/agents\/drupal-content-editor\/stream"/,
    );
    // ...every STREAM-list entry must be a precise /api/agents/<slug>/stream path
    // (never a prefix), and the file must stay imports-free + slug-only
    // (proxy-bundle-safe; no extension package identifiers).
    const streamEntries = entriesOf("GENERATED_WIDGET_STREAM_PUBLIC_PATHS");
    expect(streamEntries.length).toBeGreaterThanOrEqual(2);
    for (const e of streamEntries) {
      expect(e).toMatch(/^\/api\/agents\/[a-z0-9-]+\/stream$/);
    }
    expect(widgetPathsSource).not.toMatch(/^import /m);
    expect(widgetPathsSource).not.toMatch(/@cinatra-ai\//);
    // The guard wires the generated list in and must remain an exact-match
    // list (.includes), never collapse into a public `/api/agents` prefix.
    expect(guardSource).toMatch(/GENERATED_WIDGET_STREAM_PUBLIC_PATHS/);
    expect(guardSource).not.toMatch(/"\/api\/agents"/);
  });

  it("token-exchange + capabilities siblings are exact generated slugs (cinatra#220), not prefixes", () => {
    // Each list is the precise /api/agents/<slug>/{token,capabilities} paths.
    const tokenEntries = entriesOf("GENERATED_WIDGET_STREAM_TOKEN_PATHS");
    const capEntries = entriesOf("GENERATED_WIDGET_STREAM_CAPABILITY_PATHS");
    expect(tokenEntries.length).toBeGreaterThanOrEqual(2);
    expect(capEntries.length).toBeGreaterThanOrEqual(2);
    for (const e of tokenEntries) expect(e).toMatch(/^\/api\/agents\/[a-z0-9-]+\/token$/);
    for (const e of capEntries) expect(e).toMatch(/^\/api\/agents\/[a-z0-9-]+\/capabilities$/);
    expect(tokenEntries).toContain("/api/agents/wordpress-content-editor/token");
    expect(tokenEntries).toContain("/api/agents/drupal-content-editor/token");
    expect(capEntries).toContain("/api/agents/wordpress-content-editor/capabilities");
    expect(capEntries).toContain("/api/agents/drupal-content-editor/capabilities");
    // The guard consumes BOTH new lists as exact-match (.includes), never a prefix.
    expect(guardSource).toMatch(/GENERATED_WIDGET_STREAM_TOKEN_PATHS/);
    expect(guardSource).toMatch(/GENERATED_WIDGET_STREAM_CAPABILITY_PATHS/);
  });
});

describe("auth-route-guard - cinatra#340 generic /webhook namespace (behavioral)", () => {
  // The whole /webhook namespace skips the sign-in redirect (a webhook arrives
  // from an unauthenticated connected site). Both a DECLARED hook path and an
  // UNDECLARED one are exempt at the guard — the ROUTE owns the declared→dispatch
  // / undeclared→404 verdict, so neither is ever 307'd to /sign-in. A sessionless
  // request to a NON-/webhook protected path still redirects (control).
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    // NextResponse.next() has no Location header and is not a 307 redirect.
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }

  it("a declared-shaped /webhook/<vendor>/<slug>/<hook>/<bindingId> path is exempt (no 307), even sessionless", async () => {
    const res = await guardAppRoute(
      fakeRequest("/webhook/cinatra-ai/wordpress-connector/post-published/abc123"),
    );
    expect(isNext(res)).toBe(true);
  });

  it("an UNDECLARED /webhook/... path is also exempt at the guard (the route 404s, never 307s)", async () => {
    const res = await guardAppRoute(fakeRequest("/webhook/nobody/nothing/none/xyz"));
    expect(isNext(res)).toBe(true);
  });

  it("the bare /webhook path is exempt (boundary-aware prefix match)", async () => {
    const res = await guardAppRoute(fakeRequest("/webhook"));
    expect(isNext(res)).toBe(true);
  });

  it("CONTROL: a sessionless request to a protected non-/webhook path is 307'd to /sign-in", async () => {
    const res = await guardAppRoute(fakeRequest("/dashboards"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });
});

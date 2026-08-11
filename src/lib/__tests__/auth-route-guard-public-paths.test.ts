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

  it("contains /api/auditor (the run-skills WayFlow ApiNode callback; /apply + /exclude retired in cinatra#1796)", () => {
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

  it("contains /api/connect/site-inventory (cinatra#2018 S3 PR-D, absorbed by cinatra#2021 S6; server-to-server, in-handler cnx_ + Origin auth)", () => {
    expect(guardSource).toMatch(/"\/api\/connect\/site-inventory"/);
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/connect/site-inventory"'));
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

  it("no longer exempts /api/webhooks/wordpress (cinatra#2022: the dedicated legacy route was deleted)", () => {
    expect(guardSource).not.toMatch(/"\/api\/webhooks\/wordpress"/);
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
  // `/api/wordpress/bundle.js` bundle path; cinatra#977 then DELETED the dead
  // pre-Option-A bundle routes together with that exemption (the vendored
  // plugin/module widget copies are the only shipped widget source — see
  // docs/internals/contracts/widget-source-of-truth.md). No `/api/wordpress` public entry of ANY
  // width may come back: the precise one would exempt a nonexistent route, a
  // broad prefix would expose EVERY WordPress API route unauthenticated. These
  // regressions are a source edit, so a source-text pin (matching this file's
  // style) is the right guard.

  it("keeps the retired bundle.js exemption removed and never exempts an /api/wordpress prefix", () => {
    // The dead widget-bundle route was removed (cinatra#411 disposition,
    // executed by cinatra#977) — its public-path exemption must stay gone.
    expect(guardSource).not.toMatch(/"\/api\/wordpress\/bundle\.js"/);
    // The broad prefix entry must NOT exist (would make all WP API routes public).
    expect(guardSource).not.toMatch(/"\/api\/wordpress"/);
  });

  it("drops the pre-rename `*-widget` public prefixes", () => {
    expect(guardSource).not.toMatch(/"\/api\/wordpress-widget"/);
    expect(guardSource).not.toMatch(/"\/api\/drupal-widget"/);
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

describe("auth-route-guard - cinatra#1221 S5 /api/assistants/chat broker-auth widget branch", () => {
  // The unified assistant chat route ALSO serves the cross-origin public-site
  // (WordPress/Drupal) widget via its broker-auth branch (Bearer cit_ + cwu_).
  // A cookie-less browser widget must reach the handler (whose OWN dual-token
  // sequence is the authoritative gate), not be 307'd to /sign-in. It is an
  // EXACT-path exemption (never a broad /api/assistants prefix that would expose
  // sibling sub-routes).
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }

  it("EXACT-exempts /api/assistants/chat so a cookie-less widget reaches the handler (not 307→/sign-in)", async () => {
    const res = await guardAppRoute(fakeRequest("/api/assistants/chat"));
    expect(isNext(res)).toBe(true);
    // Source pin: the exact entry is present with an in-handler-auth comment.
    expect(guardSource).toMatch(/"\/api\/assistants\/chat",\s*\/\//);
    const line = guardSource.split("\n").find((l) => l.includes('"/api/assistants/chat"'));
    expect((line ?? "").toLowerCase()).toMatch(/dual-token|broker-auth/);
  });

  it("does NOT expose a sibling assistants sub-route (exact-path list, no prefix)", async () => {
    // A broad /api/assistants prefix would make every assistant API route
    // public; only the exact exempt pathnames are. A different assistants
    // sub-route (threads) stays session-guarded (307→/sign-in).
    expect(guardSource).not.toMatch(/"\/api\/assistants"\s*,/);
    const res = await guardAppRoute(fakeRequest("/api/assistants/threads"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });

  it("EXACT-exempts /api/assistants/chat/capabilities so the sessionless broker embed reaches the handler (cinatra#1998 Lane A)", async () => {
    // The cross-origin embed GETs the advertisement client-side with no cookie
    // + broker headers; the middleware must NOT 307 it before the handler's own
    // dual-token fail-closed auth runs. Exact path only, with a broker-auth
    // source comment (mirrors the /api/assistants/chat exemption above).
    const res = await guardAppRoute(fakeRequest("/api/assistants/chat/capabilities"));
    expect(isNext(res)).toBe(true);
    expect(guardSource).toMatch(/"\/api\/assistants\/chat\/capabilities",\s*\/\//);
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/assistants/chat/capabilities"'));
    expect((line ?? "").toLowerCase()).toMatch(/broker-auth|dual-token/);
  });
});

describe("auth-route-guard - cinatra#1881 assistant run-stream resume matcher", () => {
  // OPTION 1: a NARROW UUID-shaped dynamic matcher for
  // GET /api/assistants/runs/<runId>/stream so a cookieless resume caller
  // reaches the handler, whose OWN fail-closed auth (session OR run-bound
  // resume token, audience-checked) is the authoritative gate — the same
  // posture /api/assistants/chat has. It must NOT over-match: a sibling
  // assistants sub-route, a non-UUID segment, a longer suffix, or the bare
  // /runs collection all stay session-guarded (307→/sign-in).
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }
  // A representative v4 UUID (the shape randomUUID() mints for a runId).
  const RUN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("a cookieless GET to /api/assistants/runs/<uuid>/stream passes the guard (no 307)", async () => {
    const res = await guardAppRoute(fakeRequest(`/api/assistants/runs/${RUN}/stream`));
    expect(isNext(res)).toBe(true);
  });

  it("accepts an upper-case-hex UUID (case-insensitive shape; handler still governs run binding)", async () => {
    const res = await guardAppRoute(
      fakeRequest(`/api/assistants/runs/${RUN.toUpperCase()}/stream`),
    );
    expect(isNext(res)).toBe(true);
  });

  it("OVER-MATCH CONTROL: a NON-UUID run segment still 307s (fail-closed to the session gate)", async () => {
    for (const seg of ["not-a-uuid", "..", "run-broker-xyz", "12345"]) {
      const res = await guardAppRoute(fakeRequest(`/api/assistants/runs/${seg}/stream`));
      expect(res.status, `${seg} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("OVER-MATCH CONTROL: a sibling sub-route under the same run still 307s (must END at /stream)", async () => {
    for (const suffix of ["", "/", "/cancel", "/stream/extra", "/stream/"]) {
      const res = await guardAppRoute(
        fakeRequest(`/api/assistants/runs/${RUN}${suffix}`),
      );
      expect(res.status, `suffix "${suffix}" must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("OVER-MATCH CONTROL: the bare /runs collection and other assistants siblings stay guarded", async () => {
    for (const p of [
      "/api/assistants/runs",
      "/api/assistants/runs/stream",
      "/api/assistants/threads/" + RUN,
      "/api/assistants/list",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("SOURCE PIN: the matcher is a UUID-shaped structural regex, never an /api/assistants prefix, with an in-handler-auth comment", () => {
    // The dynamic matcher must be present (defense against silent removal)...
    expect(guardSource).toMatch(/ASSISTANT_RUN_STREAM_PATH/);
    expect(guardSource).toMatch(
      /\/\^\\\/api\\\/assistants\\\/runs\\\/\[0-9a-fA-F\]\{8\}/,
    );
    // ...it must be a STRUCTURAL match terminating at /stream (never a broad
    // /api/assistants prefix that would expose every sibling assistant route)...
    expect(guardSource).not.toMatch(/"\/api\/assistants"\s*,/);
    // ...and it must carry the in-handler-auth rationale (session OR run-bound
    // resume token is the gate).
    const block = guardSource.slice(
      guardSource.indexOf("cinatra#1881"),
      guardSource.indexOf("ASSISTANT_RUN_STREAM_PATH ="),
    );
    expect(block.toLowerCase()).toMatch(/resume token/);
    expect(block.toLowerCase()).toMatch(/fail-closed/);
  });

  it("SOURCE PIN: the CORS half is documented as DEFERRED (the shared CORS builder is untouched)", () => {
    // #1881 lands the same-origin allowlist only; the cross-origin CORS half
    // (header exposure + OPTIONS/GET origin reflection) rides the embed wave.
    // The scope note keeps a later reader from assuming cross-origin resume works.
    const block = guardSource.slice(
      guardSource.indexOf("cinatra#1881"),
      guardSource.indexOf("ASSISTANT_RUN_STREAM_PATH ="),
    );
    expect(block.toUpperCase()).toMatch(/DEFERRED/);
    expect(block.toLowerCase()).toMatch(/cors builder is intentionally untouched/);
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

describe("auth-route-guard - cinatra#2386 /setup/account (first-account bootstrap step)", () => {
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }

  it("EXACT-exempts /setup/account so a sessionless visitor reaches the bootstrap form (not 307->/sign-in)", async () => {
    const res = await guardAppRoute(fakeRequest("/setup/account"));
    expect(isNext(res)).toBe(true);
    // Source pin: the exact entry is present with an in-handler rationale.
    expect(guardSource).toMatch(/"\/setup\/account",\s*\/\//);
    const line = guardSource.split("\n").find((l) => l.includes('"/setup/account"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/bootstrap/);
  });

  it("does NOT exempt a broad /setup prefix — every other /setup/* route stays session-guarded", async () => {
    // PUBLIC_EXACT_PATHS (exact-match list) must not carry a bare "/setup"
    // entry. SETUP_PATH_PREFIXES (a SEPARATE, unrelated list used only for
    // isSetupPath's app-shell bypass classification, not by guardAppRoute)
    // legitimately contains "/setup" — scope the assertion to the
    // PUBLIC_EXACT_PATHS block only so that unrelated list doesn't false-positive.
    const publicExactPathsBlock = guardSource.match(
      /const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\];/,
    )?.[1];
    expect(publicExactPathsBlock).toBeDefined();
    expect(publicExactPathsBlock ?? "").not.toMatch(/"\/setup"\s*,/);
    for (const p of ["/setup", "/setup/key", "/setup/name", "/setup/model", "/setup/secrets", "/setup/complete"]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("PREFIX-BOUNDARY CONTROL: a string-prefix sibling NOT the exact path (e.g. /setup/account-extra) still 307s", async () => {
    const res = await guardAppRoute(fakeRequest("/setup/account-extra"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });
});

describe("auth-route-guard - cinatra#2576 (S8c) /api/lifecycle-views/capture widget egress", () => {
  // The capture egress is painted by a plain `<img src>` inside cinatra's own
  // embed iframe. Its reader is a broker `cwu_` principal, so there is NO
  // Better-Auth cookie and an `<img>` cannot send a bearer header either — the
  // sealed capability in the URL is the whole credential. Without the
  // PUBLIC_PATH_PREFIXES exemption guardAppRoute 307s the load to /sign-in and
  // the handler's six-rung ladder never runs at all (the browser then tries to
  // decode the /sign-in HTML as a PNG). This mirrors /api/assistants/chat and
  // /api/widget-auth/*: reachability only — the route still self-authorizes.
  //
  // The exemption is an EXACT-path entry, not a prefix. A PUBLIC_PATH_PREFIXES
  // entry would match `pathname === prefix || pathname.startsWith(prefix + "/")`
  // — which leaves the siblings guarded today, but would ALSO exempt any
  // /api/lifecycle-views/capture/<descendant> that a later parent catch-all or
  // a rewrite made routable. The egress is a static leaf that reads no path
  // params, so the exact list expresses the real contract and does not depend
  // on the route tree keeping its current shape (Codex round 1 on this diff).
  //
  // The sibling lifecycle-view routes (resolve, decide) are COOKIE-SESSION ONLY
  // by design (their route headers say so) and are pinned below as regressions:
  // widening this entry to an /api/lifecycle-views prefix would unguard both.
  //
  // STRICT admission check: `NextResponse.next()` is a 200 carrying
  // `x-middleware-next: 1`. Asserting that exact signal (rather than merely
  // "not a 307") means a future guard that answered 401/403/500 here — the
  // handler still never running — fails this suite instead of passing it.
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    return (
      (res.status ?? 200) === 200 &&
      res.headers?.get?.("x-middleware-next") === "1" &&
      (res.headers?.get?.("location") ?? null) === null
    );
  }

  // The real request carries the sealed capability as `?c=…`; the guard keys on
  // the pathname only, so the query is present here purely to model the actual
  // shape of the `<img>` load the route serves.
  function captureRequest(search: string): NextRequest {
    return {
      nextUrl: { pathname: "/api/lifecycle-views/capture", search },
      url: `http://localhost/api/lifecycle-views/capture${search}`,
      cookies: { get: () => undefined },
      headers: new Headers(),
    } as unknown as NextRequest;
  }

  it("a COOKIELESS GET to /api/lifecycle-views/capture passes the guard (no 307 — the handler runs)", async () => {
    const res = await guardAppRoute(fakeRequest("/api/lifecycle-views/capture"));
    expect(isNext(res)).toBe(true);
  });

  it("the same request WITH the sealed ?c= capability also passes (the real `<img>` shape)", async () => {
    const res = await guardAppRoute(captureRequest("?c=sealed.capability.value"));
    expect(isNext(res)).toBe(true);
    // The regression this pins is the measured one on PR #2640: a 307 whose
    // Location echoed the whole capability into /sign-in?next=…
    expect(res.headers?.get?.("location") ?? null).toBeNull();
  });

  it("SOURCE PIN: the entry is a LIVE exact-path entry with an in-handler-auth comment naming the ladder", () => {
    // Defense against silent removal — the file's convention for every
    // security-relevant exemption (see /api/cli, /api/extensions/purge).
    expect(guardSource).toMatch(/"\/api\/lifecycle-views\/capture"/);
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/lifecycle-views/capture"'));
    expect(line).toBeDefined();
    // A LIVE array entry, not a commented-out one (the behavioural tests above
    // are the real gate; this keeps the pin from passing on a corpse).
    expect((line ?? "").trimStart().startsWith('"')).toBe(true);
    expect((line ?? "").toLowerCase()).toMatch(/auth enforced inside/);
    expect((line ?? "").toLowerCase()).toMatch(/sealed capability/);
    expect(line ?? "").toMatch(/decideCaptureCapabilityServe/);
    // It lives in PUBLIC_EXACT_PATHS and NOT in PUBLIC_PATH_PREFIXES, so a
    // later move onto the prefix list — which would silently pick up any
    // descendant path — is a visible, failing edit rather than a quiet one.
    const exactBlock = guardSource.match(
      /const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(exactBlock).toBeDefined();
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/capture"/);
    const prefixBlock = guardSource.match(
      /const PUBLIC_PATH_PREFIXES = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(prefixBlock).toBeDefined();
    expect(prefixBlock ?? "").not.toMatch(/lifecycle-views/);
  });

  it("SOURCE PIN: the exempted path is byte-equal to the route constant the minter builds URLs from", () => {
    // capture-capability.ts is a `server-only` module and the guard runs in the
    // proxy bundle, so the guard deliberately carries a LITERAL (exactly like
    // every other entry) rather than importing it. This reads both sources as
    // text so a rename on either side breaks here instead of silently
    // reintroducing the 307.
    const capabilitySource = fs.readFileSync(
      path.resolve(__dirname, "..", "lifecycle", "capture-capability.ts"),
      "utf-8",
    );
    const routeConst = capabilitySource.match(
      /CAPTURE_CAPABILITY_ROUTE\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(routeConst).toBe("/api/lifecycle-views/capture");
    expect(guardSource).toContain(`"${routeConst}"`);
  });

  it("EXACTNESS: a DESCENDANT of the capture path is NOT exempt (307) — the entry is one path, not a subtree", () => {
    // The load-bearing consequence of the exact list. On the prefix list these
    // would all be public; here every one of them stays session-guarded, so a
    // later parent catch-all or rewrite that made a descendant routable could
    // not inherit this exemption.
    return Promise.all(
      [
        "/api/lifecycle-views/capture/",
        "/api/lifecycle-views/capture/anything",
        "/api/lifecycle-views/capture/../resolve",
        "/api/lifecycle-views/capture/1/bytes",
      ].map(async (p) => {
        const res = await guardAppRoute(fakeRequest(p));
        expect(res.status, `${p} must stay guarded`).toBe(307);
        expect(res.headers.get("location")).toContain("/sign-in");
      }),
    );
  });

  it("cinatra#2577 (S8d): the sibling /api/lifecycle-views/resolve is reachable cookieless too", async () => {
    // S1's refetch was COOKIE SESSION ONLY; S8d opened its broker branch, which
    // presents `credentials:"omit"`. A 307 here is invisible in production — the
    // card renders no DOM on a failed resolve — so it is pinned as reachability.
    // The HANDLER still authenticates both branches and 401s an unplaceable one.
    const res = await guardAppRoute(fakeRequest("/api/lifecycle-views/resolve"));
    expect(res.status).not.toBe(307);
  });

  it("REGRESSION: every OTHER lifecycle-views path stays session-guarded", async () => {
    for (const p of [
      "/api/lifecycle-views",
      "/api/lifecycle-views/",
      // /decide is S8b's and keeps its cookie gate until that slice lands.
      "/api/lifecycle-views/decide",
      "/api/lifecycle-views/anything-else",
      // The two exemptions are EXACT: no descendant inherits them.
      "/api/lifecycle-views/resolve/",
      "/api/lifecycle-views/resolve/anything",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("PREFIX-BOUNDARY CONTROL: a string-prefix sibling (/api/lifecycle-views/capture-foo) still 307s", async () => {
    // The match is `pathname === prefix || pathname.startsWith(prefix + "/")`,
    // never a loose substring.
    for (const p of [
      "/api/lifecycle-views/capture-foo",
      "/api/lifecycle-views/captures",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("the exemptions are never broadened to an /api/lifecycle-views prefix", () => {
    // A bare namespace prefix would unguard capture, resolve AND decide in one
    // edit. Two paths are exempt (capture, and resolve since cinatra#2577) and
    // both must be EXACT entries; `decide` must not be exempt at all.
    expect(guardSource).not.toMatch(/"\/api\/lifecycle-views"\s*,/);
    expect(guardSource).not.toMatch(/"\/api\/lifecycle-views\/decide"/);
    const exactBlock = guardSource.match(
      /const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/resolve"/);
    const prefixBlock = guardSource.match(
      /const PUBLIC_PATH_PREFIXES = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(prefixBlock ?? "").not.toMatch(/lifecycle-views/);
  });

  it("SOURCE PIN: cinatra#2577's resolve entry states that the handler still authenticates", () => {
    // Same convention as the capture entry above: a reachability exemption
    // carries, on its own line, the reason it is safe.
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/lifecycle-views/resolve"'));
    expect(line).toBeDefined();
    expect((line ?? "").trimStart().startsWith('"')).toBe(true);
    expect((line ?? "").toLowerCase()).toMatch(/lifecycle\.read/);
    expect((line ?? "").toLowerCase()).toMatch(/401/);
  });
});

describe("auth-route-guard DEV_ONLY_PUBLIC_EXACT_PATHS — design-fixture harness routes", () => {
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }

  // NODE_ENV is "test" here (non-production), the same branch the dev server
  // takes; the production-standalone CI harness takes the
  // CINATRA_E2E_SETUP_BYPASS branch of the same helper.
  it("/design-fixtures stays public in non-production (pixel-diff harness)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures"));
    expect(isNext(res)).toBe(true);
  });

  it("/design-fixtures/marketplace-detail-modal is public in non-production (§V modal harness, cinatra#989/#739)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures/marketplace-detail-modal"));
    expect(isNext(res)).toBe(true);
  });

  it("/design-fixtures/agents-card is public in non-production (accent-hotspot harness, cinatra#1121)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures/agents-card"));
    expect(isNext(res)).toBe(true);
  });

  it("/design-fixtures/header-rule is public in non-production (page-header section-rule harness, cinatra#1101)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures/header-rule"));
    expect(isNext(res)).toBe(true);
  });

  it("/design-fixtures/extension-settings is public in non-production (§V settings + Skills harness, cinatra#2349)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures/extension-settings"));
    expect(isNext(res)).toBe(true);
  });

  it("CONTROL: an arbitrary /design-fixtures/* sibling is NOT public (exact-path list, no prefix wildcard)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures/anything-else"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });
});

describe("auth-route-guard - /api/cli control-plane exemption (behavioral + pin)", () => {
  // The published `cinatra` bin drives a remote instance as a COOKIELESS OAuth
  // API client. Every /api/cli/* route enforces its OWN authorization at the
  // route via authorizeCliRequest (src/lib/cli-api/route-guard.ts): a Better-Auth
  // session, a JWKS-verified OAuth Bearer on the dedicated /api/cli audience with
  // per-endpoint scope + LIVE role, or the loopback dev-admin bypass. Without the
  // PUBLIC_PATH_PREFIXES exemption guardAppRoute 307s the cookieless request to
  // /sign-in BEFORE authorizeCliRequest runs, and the CLI crashes parsing the
  // /sign-in HTML as JSON. This mirrors /api/mcp and /api/extensions/purge.
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    // NextResponse.next() has no Location header and is not a 307 redirect.
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }

  it("keeps /api/cli in PUBLIC_PATH_PREFIXES with an in-handler-auth comment naming authorizeCliRequest", () => {
    // Source-text pin (this file's convention for every security-relevant
    // exemption, e.g. /api/extensions/purge and /webhook): defends against a
    // future refactor silently dropping the entry and re-breaking the CLI.
    expect(guardSource).toMatch(/"\/api\/cli"/);
    const line = guardSource.split("\n").find((l) => l.includes('"/api/cli"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/auth enforced inside/);
    expect(line ?? "").toMatch(/authorizeCliRequest/);
  });

  it("a cookieless /api/cli/status request passes the guard (NextResponse.next(), no 307)", async () => {
    const res = await guardAppRoute(fakeRequest("/api/cli/status"));
    expect(isNext(res)).toBe(true);
  });

  it("cookieless /api/cli/extensions/reconcile/{plan,apply} pass the guard (no 307)", async () => {
    for (const p of [
      "/api/cli/extensions/reconcile/plan",
      "/api/cli/extensions/reconcile/apply",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(isNext(res), `${p} should reach its route`).toBe(true);
    }
  });

  it("the bare /api/cli path is exempt (boundary-aware prefix match)", async () => {
    const res = await guardAppRoute(fakeRequest("/api/cli"));
    expect(isNext(res)).toBe(true);
  });

  it("PREFIX-BOUNDARY CONTROL: a string-prefix sibling NOT under /api/cli/ (e.g. /api/cli-foo) still 307s", async () => {
    // The guard matches `pathname === prefix || pathname.startsWith(prefix + "/")`,
    // not a loose substring — /api/cli-foo must NOT be exempted by the /api/cli entry.
    const res = await guardAppRoute(fakeRequest("/api/cli-foo"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });

  it("CONTROL: a cookieless request to an unrelated protected path (/dashboards) still 307s to /sign-in", async () => {
    const res = await guardAppRoute(fakeRequest("/dashboards"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/sign-in");
  });

  it("the exemption is the precise /api/cli prefix, never a bare /api prefix", () => {
    // A bare "/api" prefix would make EVERY api route public. Only /api/cli.
    expect(guardSource).not.toMatch(/"\/api"\s*,/);
  });
});

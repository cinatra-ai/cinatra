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
import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe("auth-route-guard - the hosted /widget-auth surface (cinatra#2674)", () => {
  // WHY THE ENTRY IS NOW THE NAMESPACE PREFIX, having deliberately NOT been one.
  //
  // Before S8e the exemption named the two leaf routes precisely, and a bare
  // "/api/widget-auth" prefix was called out as a thing to avoid: it would
  // exempt any future sub-route. S8e adds two sub-routes (`frame/init`,
  // `frame/token`) whose ENTIRE PURPOSE is to be reachable without a session —
  // the visitor has none, which is what the flow exists to fix — and retires the
  // other two to a 410 that must also be reachable so a legacy plugin gets an
  // honest answer rather than a redirect.
  //
  // So every route in this namespace is, by construction, self-authenticating
  // and session-less. The prefix now EXPRESSES that rather than enumerating it,
  // and the assertion below moves accordingly: instead of pinning two names, it
  // pins that the entry documents in-handler authorization, and that the widget
  // NAMESPACE is the widest thing exempted — no `/api` prefix, no bare `/api/w`.

  it("exempts the /api/widget-auth namespace, documented as authorized in-handler", () => {
    const line = guardSource
      .split("\n")
      .find((l) => /"\/api\/widget-auth",/.test(l));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toMatch(/authorized inside|auth enforced inside/);
  });

  it("EXACT-exempts the /widget-auth page so a sessionless visitor renders login (not 307→/sign-in)", () => {
    // It must be in PUBLIC_EXACT_PATHS (so it matches the bare pathname, the
    // ?txn=... query stripped), NOT a broad prefix that would expose sub-paths.
    expect(guardSource).toMatch(/"\/widget-auth",\s*\/\//);
    expect(guardSource).not.toMatch(/"\/widget-auth\//); // never a prefix entry
  });

  it("does NOT widen beyond that namespace", () => {
    const lines = guardSource.split("\n");
    expect(lines.some((l) => /"\/api",/.test(l))).toBe(false);
    expect(lines.some((l) => /"\/api\/widget",/.test(l))).toBe(false);
  });
});

describe("auth-route-guard - the review island (cinatra#2674 scope addition)", () => {
  // The island is framed by cinatra's OWN embed iframe on a third-party CMS
  // page, where a SameSite-bound session cookie is not sent. Without the
  // exemption the guard 307s that frame to /sign-in and the island can never
  // paint on the deployments the parity criterion is about. Reachability only:
  // the page authorizes with a sealed, ref-bound island credential, or with a
  // session when there is one.

  it("EXACT-exempts /lifecycle/review-island, never as a prefix", () => {
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/lifecycle/review-island"'));
    expect(line).toBeDefined();
    expect((line ?? "").toLowerCase()).toContain("reachability only");
    expect(guardSource).not.toMatch(/"\/lifecycle\/review-island\//);
    // The sibling lifecycle surfaces stay session-gated.
    expect(guardSource).not.toMatch(/"\/lifecycle",/);
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
    // public; only the exact exempt pathnames are. An assistants sub-route that
    // was never given an entry stays session-guarded (307→/sign-in).
    //
    // The probe used to be `/api/assistants/threads`, which now HAS its own
    // exact entry (cinatra#2683 item 1, write half). Pinning "no prefix" needs a
    // path nobody exempted, not a path that happens to still be closed — so it
    // is a genuinely unexempted sibling, and the assertion means what it says.
    expect(guardSource).not.toMatch(/"\/api\/assistants"\s*,/);
    const res = await guardAppRoute(fakeRequest("/api/assistants/runs"));
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
    // `/api/assistants/list` used to be listed here as a fourth control, and
    // `/api/assistants/threads/<id>` as a third. Neither is one any more:
    // cinatra#2683 gave the directory its OWN exact entry and the thread read
    // its OWN pattern entry (a thread id is an opaque CMS-minted string, not a
    // UUID, so the two matchers cannot be confused), each pinned by its own
    // tests. The two below still prove the point this control exists for — the
    // run-stream matcher is structural, and `/api/assistants` is not a public
    // prefix.
    for (const p of ["/api/assistants/runs", "/api/assistants/runs/stream"]) {
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

describe("auth-route-guard - cinatra#2902 inline run panel seed matcher", () => {
  // The inline run panel's SEED — GET /api/agents/runs/<runId> — is the one read
  // the panel makes before it can draw anything. On the embedded widget that
  // request carries no cookie, so the guard used to answer it with a 307 to
  // sign-in before the handler ran, `fetch` followed the redirect, the JSON parse
  // failed, and the panel drew "Could not load agent run … — please try again."
  // for ever.
  //
  // A BOUNDED dynamic matcher admits exactly this path shape and nothing around
  // it. Every row below proves either that admission REACHES THE HANDLER'S OWN
  // CHECK (never a 307) or that a neighbour stays guarded.
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    const status = res.status ?? 200;
    const location = res.headers?.get?.("location") ?? null;
    return status !== 307 && location === null;
  }
  // A representative v4 UUID — the shape `randomUUID()` mints for a run id at
  // the one creation perimeter (`createAgentRun`).
  const RUN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  it("a cookieless GET to /api/agents/runs/<uuid> passes the guard (no 307 — the handler runs)", async () => {
    const res = await guardAppRoute(fakeRequest(`/api/agents/runs/${RUN}`));
    expect(isNext(res)).toBe(true);
  });

  it("accepts the `run_` prefixed form the dispatch paths mint", async () => {
    // `src/lib/project-dispatch.ts` and both mint sites in
    // `src/lib/host-content-editor-dispatch.ts` key their runs `run_<uuid>`. A
    // matcher that admitted only the bare form would leave exactly those runs
    // answering the widget with the 307 this entry removes.
    const res = await guardAppRoute(fakeRequest(`/api/agents/runs/run_${RUN}`));
    expect(isNext(res)).toBe(true);
  });

  it("accepts the `run-` prefixed form of the same id (the column is opaque text)", async () => {
    const res = await guardAppRoute(fakeRequest(`/api/agents/runs/run-${RUN}`));
    expect(isNext(res)).toBe(true);
  });

  it("accepts an upper-case-hex id (case-insensitive shape; the handler still binds the run)", async () => {
    const res = await guardAppRoute(fakeRequest(`/api/agents/runs/${RUN.toUpperCase()}`));
    expect(isNext(res)).toBe(true);
  });

  it("MALFORMED-ID CONTROL: a non-UUID run segment still 307s (fail-closed to the session gate)", async () => {
    for (const seg of [
      "not-a-uuid",
      "..",
      "12345",
      "run-broker-xyz",
      // one hex digit short of a UUID
      "3f2504e0-4f89-41d3-9a0c-0305e82c330",
      // one too long
      `${RUN}0`,
      // the right characters, the wrong grouping
      "3f2504e04f8941d39a0c0305e82c3301",
      // a `run-` prefix over something that is not a UUID
      "run-not-a-uuid",
      // …and the same for the underscore form the dispatch paths mint
      "run_not-a-uuid",
      // a prefix the mint sites never produce, over a real UUID
      `runs-${RUN}`,
      `run${RUN}`,
    ]) {
      const res = await guardAppRoute(fakeRequest(`/api/agents/runs/${seg}`));
      expect(res.status, `${seg} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("DESCENDANT CONTROL: the run's live transports under the same id still 307", async () => {
    // The panel's stream is deliberately OUT of this slice's scope: it is
    // separately session-only and is named as follow-up, not opened here. A
    // matcher that admitted it would silently promise a transport that does not
    // work.
    for (const suffix of ["/stream", "/", "/stream/", "/stream/extra", "/cancel", "/messages"]) {
      const res = await guardAppRoute(fakeRequest(`/api/agents/runs/${RUN}${suffix}`));
      expect(res.status, `suffix "${suffix}" must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("SIBLING CONTROL: the bare collection and its non-run siblings stay guarded", async () => {
    for (const p of [
      "/api/agents/runs",
      "/api/agents/runs/",
      "/api/agents/runs/stream",
      "/api/agents/templates",
      `/api/agents/${RUN}`,
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("UNRELATED-PATH CONTROL: a UUID-shaped segment elsewhere is not admitted by this matcher", async () => {
    for (const p of [
      `/api/agents/runs-archive/${RUN}`,
      `/api/agent/runs/${RUN}`,
      `/agents/runs/${RUN}`,
      `/api/artifacts/${RUN}`,
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  // ---------------------------------------------------------------------
  // METHOD (cinatra#2902 convergence F1). The exemption is a READ exemption.
  // Before this pin, admission was decided on the PATHNAME ALONE, so ANY verb
  // on a matching path skipped the cookie guard. Nothing was exploitable today
  // — the route module exports GET alone, so Next answers a POST there with 405
  // — but the guard was relying on a fact stated in another file, and a writing
  // verb added to this path later would have silently inherited a cookieless
  // exemption written for a read. These rows pin the rule where it is decided.
  // ---------------------------------------------------------------------
  function methodRequest(pathname: string, method: string, search = ""): NextRequest {
    return {
      nextUrl: { pathname, search },
      url: `http://localhost${pathname}${search}`,
      method,
      cookies: { get: () => undefined },
      headers: new Headers(),
    } as unknown as NextRequest;
  }

  it("a cookieless GET on a matching path IS admitted (the seed still reaches its handler)", async () => {
    const res = await guardAppRoute(methodRequest(`/api/agents/runs/${RUN}`, "GET"));
    expect(isNext(res)).toBe(true);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "%s on a matching path is NOT admitted cookieless — it meets the session guard",
    async (method) => {
      const res = await guardAppRoute(methodRequest(`/api/agents/runs/${RUN}`, method));
      expect(isNext(res)).toBe(false);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    },
  );

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "%s is refused for the `run_` and `run-` id shapes too (the pin is on the rule, not one row)",
    async (method) => {
      for (const id of [`run_${RUN}`, `run-${RUN}`]) {
        const res = await guardAppRoute(methodRequest(`/api/agents/runs/${id}`, method));
        expect(isNext(res)).toBe(false);
      }
    },
  );

  // A QUERY STRING CANNOT WIDEN ADMISSION. `nextUrl.pathname` excludes the query
  // (that is `nextUrl.search`), so the rule is evaluated on the path alone: a
  // query neither creates a match on a non-matching path nor rescues a non-GET.
  // A matching GET therefore STAYS ADMITTED whatever query it carries, and that
  // is safe because admission means only "reach the handler" — the handler's own
  // credential branch, not this guard, decides who may read the run, and it
  // reads no query parameter at all.
  it("a query string does not widen admission: a matching GET stays admitted with any query", async () => {
    for (const search of ["?a=1", "?redirect=/etc", "?x=%2Fapi%2Fagents%2Fruns"]) {
      const res = await guardAppRoute(methodRequest(`/api/agents/runs/${RUN}`, "GET", search));
      expect(isNext(res)).toBe(true);
    }
  });

  it("a query string does not rescue a non-GET on a matching path", async () => {
    const res = await guardAppRoute(methodRequest(`/api/agents/runs/${RUN}`, "POST", "?a=1"));
    expect(isNext(res)).toBe(false);
  });

  it("a query string cannot make a NON-matching path match (the guarded neighbours stay guarded)", async () => {
    for (const path of [
      "/api/agents/runs",
      `/api/agents/runs/${RUN}/stream`,
      "/api/agents/runs/not-a-uuid",
    ]) {
      const res = await guardAppRoute(methodRequest(path, "GET", `?id=${RUN}`));
      expect(isNext(res)).toBe(false);
    }
  });

  it("SOURCE PIN: admission is method-gated, not pathname-only", () => {
    expect(guardSource).toMatch(/method === "GET" && isAgentRunByIdPath\(pathname\)/);
    // …and the one caller actually feeds the request's method in.
    expect(guardSource).toMatch(/isPublicPath\(pathname, request\.method/);
  });

  it("SOURCE PIN: the matcher is a UUID-shaped structural regex, never an /api/agents prefix, with an in-handler-auth comment", () => {
    expect(guardSource).toMatch(/AGENT_RUN_BY_ID_PATH/);
    expect(guardSource).toMatch(
      /\/\^\\\/api\\\/agents\\\/runs\\\/\(\?:run\[-_\]\)\?\[0-9a-fA-F\]\{8\}/,
    );
    // Never a broad /api/agents prefix — that would expose every sibling route.
    expect(guardSource).not.toMatch(/"\/api\/agents"\s*,/);
    const block = guardSource.slice(
      guardSource.indexOf("cinatra#2902"),
      guardSource.indexOf("const AGENT_RUN_BY_ID_PATH"),
    );
    // The rationale a later reader needs: what the handler's own gate is, and
    // that the branch does not fall back to an ambient cookie.
    expect(block.toLowerCase()).toMatch(/never falls back/);
    expect(block.toLowerCase()).toMatch(/conversation\.read/);
    // …and the scope note, so nobody assumes the live transports came with it.
    expect(block.toLowerCase()).toMatch(/stream/);
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

  it("cinatra#2575 (S8b, corrected): /api/lifecycle-views/decide is reachable cookieless too", async () => {
    // The widget review card POSTs its decision here with `credentials:"omit"`.
    // A 307 would turn a real decision into a transport error, so reachability
    // is pinned — the handler still 401s a caller it cannot place, and the one
    // core decision module still re-checks the decision op, the pinned targets,
    // the provenance and the gate CAS.
    const res = await guardAppRoute(fakeRequest("/api/lifecycle-views/decide"));
    expect(res.status).not.toBe(307);
  });

  it("cinatra#2683 (S8f): /api/assistants/list is reachable cookieless — the @-mention directory", async () => {
    // The embed frame GETs the participant directory with `credentials:"omit"`
    // and the widget proof header. A 307 does not fail loudly here: `fetch`
    // follows it, the client parses the sign-in HTML, and the composer simply
    // draws no flyout — indistinguishable from "this org has nobody to mention".
    // The HANDLER still places the caller and tenant-scopes the directory.
    const res = await guardAppRoute(fakeRequest("/api/assistants/list"));
    expect(res.status).not.toBe(307);
  });

  it("EXACT, not a prefix: /api/assistants/list descendants and siblings stay guarded", async () => {
    // `/api/assistants/autosave` and `/api/chat/pending-tool-calls` used to be
    // listed here, as evidence that this entry exempted only itself. They are
    // not controls any more — cinatra#2683 gave each of them its OWN entry and
    // its own reasoning, pinned by its own test below. What this control still
    // proves is the thing it was written for: the list entry is one PATH, and
    // `/api/assistants` is not a public prefix.
    for (const p of [
      "/api/assistants/list/",
      "/api/assistants/list/anything",
      "/api/assistants/listing",
      "/api/assistants",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  // -------------------------------------------------------------------------
  // cinatra#2683 (epic #2564 S8f) — the five sibling widget-branch routes.
  //
  // Each gets its own reachability test AND its own negative control, because
  // each is a different shape: one dynamic path, one read, and three that
  // MUTATE. A batch test would have made them look like one decision, which is
  // exactly what the entries refuse to be.
  //
  // The shared negative control every one of them carries: an unrelated,
  // structurally similar route on the same namespace still 307s. A test that
  // only asserts "this path is reachable" cannot tell an exact entry from an
  // accidental prefix.
  // -------------------------------------------------------------------------

  it("cinatra#2683 (S8f): /api/assistants/autosave is reachable cookieless — the Skill-autosave row (GET and PATCH)", async () => {
    // The flyout READS this on open and WRITES it on toggle. Both are invisible
    // failures behind a 307: the read parses sign-in HTML and the row is absent;
    // the write is followed as a GET, so the switch appears to take and nothing
    // is stored. The guard is method-blind, so ONE entry serves both — the
    // HANDLER is what splits them, consuming GET under `conversation.read` and
    // PATCH under `conversation.write`.
    const res = await guardAppRoute(fakeRequest("/api/assistants/autosave"));
    expect(res.status).not.toBe(307);
  });

  it("SOURCE PIN: the autosave entry describes BOTH PATCH arms, not just one", () => {
    // codex round 1, finding 3. The first draft of this entry said "a
    // non-platform actor is refused" AND "the write lands in the caller's own
    // account setting" — two true sentences about two DIFFERENT arms, which
    // together describe a handler that does not exist. An entry that
    // misdescribes what it admits is the failure mode this convention exists to
    // prevent, so the correction is pinned rather than trusted to stay.
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/assistants/autosave"'));
    expect(line).toBeDefined();
    // The app-wide arm: named, and named as platform-admin-only.
    expect(line ?? "").toMatch(/settings\.update/);
    expect(line ?? "").toMatch(/platform.admin/i);
    // The self arm: named, and named as the caller's own row under the flag.
    expect(line ?? "").toMatch(/userChatCaptureEnabled/);
    expect(line ?? "").toMatch(/userCanConfigure/);
  });

  it("NEGATIVE CONTROL: /api/assistants/autosave neighbours and descendants still 307", async () => {
    for (const p of [
      "/api/assistants/autosave/",
      "/api/assistants/autosave/anything",
      "/api/assistants/autosaves",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("cinatra#2683 (S8f): /api/chat/pending-tool-calls is reachable cookieless — list AND decide", async () => {
    // The list (GET) and the decision (POST) share one path, so they share one
    // entry; they do NOT share a grant. The list consumes `conversation.read`,
    // the decision `tools.confirm`, and `canDecide` comes off the same consume —
    // a session holding only the read is served cards with no decision tokens.
    const res = await guardAppRoute(fakeRequest("/api/chat/pending-tool-calls"));
    expect(res.status).not.toBe(307);
  });

  it("NEGATIVE CONTROL: /api/chat/pending-tool-calls descendants and /api/chat siblings still 307", async () => {
    for (const p of [
      "/api/chat/pending-tool-calls/",
      "/api/chat/pending-tool-calls/decide",
      "/api/chat/pending-tool-callsx",
      // `/api/chat` is NOT a public prefix — the rest of the namespace is
      // cookie-only and stays that way.
      "/api/chat",
      "/api/chat/save",
      "/api/chat/thread/abc",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("cinatra#2683 (S8f): /api/chat/undo-candidate is reachable cookieless — the undo chip's read", async () => {
    // A 307 here renders as "this run changed nothing", which is a state a
    // reader would believe. The handler still runs the ONE §VI eligibility gate
    // and answers `{changeSetId:null}` for an ineligible reader and an unchanged
    // run alike, so reachability discloses nothing.
    const res = await guardAppRoute(fakeRequest("/api/chat/undo-candidate"));
    expect(res.status).not.toBe(307);
  });

  it("NEGATIVE CONTROL: /api/chat/undo-candidate descendants still 307 (and the RESTORE surface is not here at all)", async () => {
    for (const p of [
      "/api/chat/undo-candidate/",
      "/api/chat/undo-candidate/anything",
      "/api/chat/undo-candidates",
      // The undo ITSELF is a first-party surface under the reader's own
      // session. Nothing in this slice makes a restore path reachable.
      "/api/chat/undo",
      "/api/chat/restore",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("cinatra#2683 (S8f): /api/artifacts/upload is reachable cookieless — the composer's attachment", async () => {
    // The only entry admitting a route that CREATES an object. Behind a 307 the
    // POST is followed as a GET, the bytes are dropped, and the composer reports
    // a refusal with no reason. The handler still resolves the uploader FIRST
    // (widget → the conversation door under `conversation.write`), 401s when it
    // cannot, and files the artifact private to the WIDGET PRINCIPAL.
    const res = await guardAppRoute(fakeRequest("/api/artifacts/upload"));
    expect(res.status).not.toBe(307);
  });

  it("NEGATIVE CONTROL: the artifact BYTE routes stay guarded — writing an attachment never opens reading one", async () => {
    // The load-bearing half of this entry. `/api/artifacts` must not become a
    // prefix: a cookieless caller may reach the door that WRITES their own
    // upload and must still be redirected away from every route that READS
    // artifact content.
    for (const p of [
      "/api/artifacts",
      "/api/artifacts/upload/",
      "/api/artifacts/uploads",
      "/api/artifacts/abc",
      "/api/artifacts/abc/versions/v1/content",
      "/api/artifacts/abc/versions/v1/preview",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("cinatra#2683 (S8f): /api/assistants/threads/<threadId> is reachable cookieless — the transcript restore", async () => {
    // The PATTERN entry. A thread id is whatever the embedding CMS minted (an
    // opaque 1..200-char string in the bridge bootstrap), so the matcher can
    // only be structural: exactly one non-empty segment. Behind a 307 the
    // restore settles EMPTY and the panel opens on a blank conversation.
    for (const id of [
      "wp-thread-42",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "thread.with.dots",
      encodeURIComponent("thread with spaces"),
    ]) {
      const res = await guardAppRoute(fakeRequest(`/api/assistants/threads/${id}`));
      expect(res.status, `${id} must be reachable`).not.toBe(307);
    }
  });

  it("NEGATIVE CONTROL: any path DEEPER than one segment still 307s — one segment, no more", async () => {
    // The one-segment matcher must not become a subtree. `/threads` itself is
    // admitted by its OWN exact entry (the write half, cinatra#2683 item 1) and
    // is asserted separately below — everything under it stays guarded.
    for (const p of [
      "/api/assistants/threads/",
      "/api/assistants/threads/abc/",
      "/api/assistants/threads/abc/messages",
      "/api/assistants/threads/abc/anything/deeper",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("cinatra#2683 (S8f, write half): the threads COLLECTION is reachable cookieless, by its OWN exact entry", async () => {
    // The widget POSTs its transcript here with `credentials:"omit"`. A 307 is
    // followed by the browser as a GET with the body dropped, so the save 200s
    // and nothing is written — the reload then opens on a blank panel.
    const res = await guardAppRoute(fakeRequest("/api/assistants/threads"));
    expect(res.status).not.toBe(307);
    // The entry must state the scope split that makes admitting a MUTATING
    // route safe: the same audience, read for the restore, write for the save.
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/assistants/threads",'));
    expect(line ?? "").toMatch(/conversation\.write/);
    expect(line ?? "").toMatch(/conversation\.read/);
    // ...and that the LIST stays closed: reachability is not a widget branch.
    expect((line ?? "").toLowerCase()).toMatch(/no widget branch/);
  });

  it("SOURCE PIN: /api/assistants/threads/<id> is a PATTERN, never an /api/assistants/threads prefix", () => {
    // A prefix entry would exempt the collection POST and every future
    // descendant in one edit. The matcher must be the structural regex.
    expect(guardSource).toMatch(/ASSISTANT_THREAD_BY_ID_PATH/);
    expect(guardSource).toMatch(
      /ASSISTANT_THREAD_BY_ID_PATH\s*=\s*\/\^\\\/api\\\/assistants\\\/threads\\\/\[\^\/\]\+\$\//,
    );
    const prefixBlock = guardSource.match(
      /const PUBLIC_PATH_PREFIXES = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(prefixBlock ?? "").not.toMatch(/assistants\/threads/);
    // The COLLECTION is exempted by an EXACT entry and by nothing else. That is
    // the whole distinction this test protects: an exact path admits one path,
    // a prefix would admit the collection AND every future descendant in one
    // edit that nobody would have to argue for.
    const exactBlock = guardSource.match(
      /const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(exactBlock ?? "").toMatch(/"\/api\/assistants\/threads",/);
    expect(exactBlock ?? "").not.toMatch(/"\/api\/assistants\/threads\/"/);
  });

  it("RESIDUAL PIN: /api/assistants/threads/ has exactly ONE child, the dynamic one the matcher was written for", () => {
    // The stated residual of a one-segment matcher: a future STATIC child would
    // be admitted without anyone deciding it should be. Pin the directory so
    // adding a sibling breaks here and the decision lands on its author.
    const threadsDir = path.resolve(
      __dirname,
      "..",
      "..",
      "app",
      "api",
      "assistants",
      "threads",
    );
    const children = fs
      .readdirSync(threadsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "__tests__")
      .map((e) => e.name)
      .sort();
    expect(children).toEqual(["[threadId]"]);
  });

  it("SOURCE PIN: every S8f entry states the grant it consumes under and the refusal it produces", () => {
    // The convention the capture/resolve/decide entries established: a
    // reachability exemption carries, on its own line, the reason it is safe.
    // Applied to all five so none of them can be reduced to "the widget needs
    // it" by a later edit.
    const expectations: ReadonlyArray<[string, RegExp]> = [
      ['"/api/assistants/autosave"', /conversation\.write/],
      ['"/api/chat/pending-tool-calls"', /tools\.confirm/],
      ['"/api/chat/undo-candidate"', /conversation\.read/],
      ['"/api/artifacts/upload"', /conversation\.write/],
    ];
    for (const [needle, grant] of expectations) {
      const line = guardSource.split("\n").find((l) => l.includes(needle));
      expect(line, `${needle} must have an entry`).toBeDefined();
      expect((line ?? "").trimStart().startsWith('"')).toBe(true);
      expect((line ?? ""), `${needle} must name its grant`).toMatch(grant);
      expect((line ?? ""), `${needle} must name its refusal`).toMatch(/401/);
      expect(
        (line ?? "").toLowerCase(),
        `${needle} must state it is reachability only`,
      ).toMatch(/reachability only/);
      expect(
        (line ?? "").toLowerCase(),
        `${needle} must state the entry is exact`,
      ).toMatch(/exact path, never a prefix/);
    }
    // The dynamic one lives in its own commented block, not on a list line.
    const threadBlock = guardSource.match(
      /\/\/ cinatra#2683 \(epic #2564 S8f\) — GET \/api\/assistants\/threads([\s\S]*?)const ASSISTANT_THREAD_BY_ID_PATH/,
    )?.[1];
    expect(threadBlock ?? "").toMatch(/conversation\.read/);
    expect(threadBlock ?? "").toMatch(/Reachability only/);
  });

  it("REGRESSION: every OTHER lifecycle-views path stays session-guarded", async () => {
    for (const p of [
      "/api/lifecycle-views",
      "/api/lifecycle-views/",
      "/api/lifecycle-views/anything-else",
      // The five exemptions are EXACT: no descendant inherits them. The
      // recommendation hold is the case that makes this concrete — its own
      // `/decide` IS a descendant and is public only by its own entry
      // (cinatra#2790), so everything else under that subtree stays guarded.
      "/api/lifecycle-views/resolve/",
      "/api/lifecycle-views/resolve/anything",
      "/api/lifecycle-views/decide/",
      "/api/lifecycle-views/decide/anything",
      "/api/lifecycle-views/recommendation-hold/",
      "/api/lifecycle-views/recommendation-hold/anything",
      "/api/lifecycle-views/recommendation-hold/decide/",
      "/api/lifecycle-views/recommendation-hold/decide/anything",
      // cinatra#2930 — the HITL screen's pair is the same shape: `/submit` IS a
      // descendant of the read and is public only by its own entry.
      "/api/lifecycle-views/hitl-screen/",
      "/api/lifecycle-views/hitl-screen/anything",
      "/api/lifecycle-views/hitl-screen/submit/",
      "/api/lifecycle-views/hitl-screen/submit/anything",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("cinatra#2930: BOTH HITL-screen paths are ADMITTED cookieless, and each on its own entry", async () => {
    // THE DEFECT THIS PINS. The card's whole widget arm posts to these two
    // paths with `credentials: "omit"`. Neither was on the exact list, so the
    // guard 307'd every read and every submit to /sign-in BEFORE the handler
    // that authorizes the `cwu_` ever ran: the card drew nothing and no answer
    // ever resumed a run. Direct route-handler tests cannot see it, because
    // they call the handler and never pass the proxy.
    //
    // Admission is asserted STRICTLY — `NextResponse.next()` is a 200 carrying
    // `x-middleware-next: 1` and no Location — so a future guard answering
    // 401/403/500 here, with the handler still never running, fails this.
    for (const p of [
      "/api/lifecycle-views/hitl-screen",
      "/api/lifecycle-views/hitl-screen/submit",
    ]) {
      const res = await guardAppRoute(fakeRequest(p));
      expect(res.status ?? 200, `${p} must be admitted`).toBe(200);
      expect(res.headers.get("x-middleware-next"), `${p} must be admitted`).toBe("1");
      expect(res.headers.get("location"), `${p} must not redirect`).toBeNull();
    }
    // AND EACH ON ITS OWN ENTRY: the submit is a DESCENDANT of the read, and
    // the exact list does not admit descendants. Remove either line and one of
    // the two halves dies while the other keeps working — the shape that made
    // this defect survive a whole slice.
    const exact = guardSource.match(/const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\n\];/)?.[1] ?? "";
    for (const needle of [
      '"/api/lifecycle-views/hitl-screen"',
      '"/api/lifecycle-views/hitl-screen/submit"',
    ]) {
      const line = exact.split("\n").find((l) => l.includes(needle));
      expect(line, `${needle} must have its own entry`).toBeDefined();
      expect((line ?? "").trimStart().startsWith('"')).toBe(true);
      expect((line ?? "").toLowerCase()).toMatch(/reachability only/);
      expect((line ?? "").toLowerCase()).toMatch(/exact path, never a prefix/);
      expect((line ?? ""), `${needle} must name its refusal`).toMatch(/401/);
    }
    // The two halves consume under DIFFERENT grants — seeing the question is
    // not answering it — and each line has to say which.
    const readLine = exact
      .split("\n")
      .find((l) => l.includes('"/api/lifecycle-views/hitl-screen"'));
    const submitLine = exact
      .split("\n")
      .find((l) => l.includes('"/api/lifecycle-views/hitl-screen/submit"'));
    expect(readLine ?? "").toMatch(/lifecycle\.read/);
    expect(submitLine ?? "").toMatch(/lifecycle\.decide/);
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
    // A bare namespace prefix would unguard every exempted path in one edit,
    // and would also unguard every future sibling. SEVEN paths are exempt
    // (capture; resolve since cinatra#2577; decide since #2575's correction;
    // the recommendation hold's read and its decision since cinatra#2790; and
    // the HITL screen's read and its submit since cinatra#2930) and all seven
    // must be EXACT entries.
    expect(guardSource).not.toMatch(/"\/api\/lifecycle-views"\s*,/);
    const exactBlock = guardSource.match(
      /const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/resolve"/);
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/decide"/);
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/recommendation-hold"/);
    expect(exactBlock ?? "").toMatch(
      /"\/api\/lifecycle-views\/recommendation-hold\/decide"/,
    );
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/hitl-screen"/);
    expect(exactBlock ?? "").toMatch(
      /"\/api\/lifecycle-views\/hitl-screen\/submit"/,
    );
    const prefixBlock = guardSource.match(
      /const PUBLIC_PATH_PREFIXES = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(prefixBlock ?? "").not.toMatch(/lifecycle-views/);
  });

  it("SOURCE PIN: the decide entry states that the handler still authenticates", () => {
    // The mutating exemption carries the heaviest justification burden, so its
    // line must name the grant it consumes under and the refusal it produces.
    const line = guardSource
      .split("\n")
      .find((l) => l.includes('"/api/lifecycle-views/decide"'));
    expect(line).toBeDefined();
    expect((line ?? "").trimStart().startsWith('"')).toBe(true);
    expect((line ?? "").toLowerCase()).toMatch(/lifecycle\.decide/);
    expect((line ?? "").toLowerCase()).toMatch(/401/);
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

describe("auth-route-guard - cinatra#2790 (S9f) the recommendation hold's two BROKER routes", () => {
  // WHAT THIS BLOCK EXISTS FOR, stated as the measured defect it closes.
  //
  // S9f gave the run-start skills question a broker read and a broker decision
  // so the card could finally be drawn on the site widget. Both handlers were
  // correct — they authenticate by the presented `cwu_` and 401 without one, on
  // purpose, with no session fallback. Neither PATH was added to
  // PUBLIC_EXACT_PATHS, so guardAppRoute 307'd every cookieless request to
  // /sign-in BEFORE either handler ran. The widget always calls cookieless
  // (`credentials:"omit"`, its own headers), so the card could never resolve on
  // a running app: `fetch` follows the redirect with the method and body intact
  // (a 307 preserves both), /sign-in serves GET only and refuses the POST, the
  // transport bails on the non-OK answer, the card renders nothing, and the
  // bounded retry ends. The run is genuinely blocked on an answer the person is
  // never shown — a hung assistant, with no error anywhere naming the proxy
  // that ate the request. That is the SAME invisible class the
  // resolve entry above was written for, which is why the rows below assert
  // more than "not a 307": they assert the guard ADMITS the request and that
  // the answer the caller then gets is the HANDLER'S OWN refusal.
  const READ_PATH = "/api/lifecycle-views/recommendation-hold";
  const DECIDE_PATH = "/api/lifecycle-views/recommendation-hold/decide";

  // STRICT admission, exactly as the S8c block defines it: NextResponse.next()
  // is a 200 carrying `x-middleware-next: 1` and no Location. Asserting that
  // signal (rather than merely "not a 307") means a future guard answering
  // 401/403/500 here — the handler still never running — fails this suite.
  function isNext(res: { status?: number; headers?: Headers }): boolean {
    return (
      (res.status ?? 200) === 200 &&
      res.headers?.get?.("x-middleware-next") === "1" &&
      (res.headers?.get?.("location") ?? null) === null
    );
  }

  // The real request shape: a cross-origin-embedded frame POSTing JSON with no
  // cookie. The guard keys on the pathname alone, so the method and headers are
  // here to model the caller honestly rather than because the guard reads them.
  function widgetPost(pathname: string, cookie?: string): NextRequest {
    const headers = new Headers({ "content-type": "application/json" });
    if (cookie) headers.set("cookie", cookie);
    return {
      nextUrl: { pathname, search: "" },
      url: `http://localhost${pathname}`,
      method: "POST",
      cookies: { get: () => undefined },
      headers,
    } as unknown as NextRequest;
  }

  // The same POST as a plain Request, for driving the REAL handler.
  function handlerPost(pathname: string, cookie?: string): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    return new Request(`https://app.example.com${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: "run-2790", decision: "skip" }),
    });
  }

  // A Better-Auth-shaped session cookie. Its VALUE is immaterial and that is
  // the contract being pinned: these two routes never read a cookie at all.
  const SESSION_COOKIE = "better-auth.session_token=abc123";

  // The two REAL handlers, loaded with only the agents-package graph stubbed —
  // that graph reaches Drizzle and is not what is under test here. Everything
  // that DECIDES the 401 is loaded for real: the route module, the widget
  // branch resolver, the actor door and the audit sink. `vi.doMock` is used
  // (not `vi.mock`) so the stubs are scoped to these dynamic imports instead of
  // being hoisted over this whole shared file.
  let READ: (request: Request) => Promise<Response>;
  let DECIDE: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    vi.doMock("@cinatra-ai/agents/store", () => ({
      readAgentRunById: async () => null,
    }));
    vi.doMock("@cinatra-ai/agents/run-recommendation-core", () => ({
      resolveRecommendationHoldStateForActor: async () => ({ state: "none" }),
      confirmRecommendationForActor: async () => ({ ok: false }),
      skipRecommendationForActor: async () => ({ ok: false }),
      writeRunSkillSelectionForActor: async () => ({ ok: false }),
    }));
    vi.doMock("@cinatra-ai/agents/recommendation-hold", () => ({
      RECOMMENDATION_DECISION_REFUSAL: "unused-in-this-suite",
    }));
    vi.doMock("@cinatra-ai/agents/run-actions", () => ({
      triggerAgentRun: async () => undefined,
    }));
    READ = (await import("../../app/api/lifecycle-views/recommendation-hold/route"))
      .POST as typeof READ;
    DECIDE = (
      await import("../../app/api/lifecycle-views/recommendation-hold/decide/route")
    ).POST as typeof DECIDE;
  });

  it("a COOKIELESS POST to the recommendation-hold READ passes the guard (no 307)", async () => {
    const res = await guardAppRoute(widgetPost(READ_PATH));
    expect(isNext(res)).toBe(true);
  });

  it("a COOKIELESS POST to the recommendation-hold DECIDE passes the guard (no 307)", async () => {
    const res = await guardAppRoute(widgetPost(DECIDE_PATH));
    expect(isNext(res)).toBe(true);
  });

  it("REACHES THE HANDLER: the cookieless READ is answered by the ROUTE's own 401, not a redirect", async () => {
    // The composition is the point. The guard admits the request, and what the
    // caller then receives is the handler's own refusal for a missing
    // credential — a JSON 401 with its reason — which is only producible by
    // code that actually ran. A 307 (the measured defect) or a followed
    // redirect's sign-in HTML would both fail here.
    expect(isNext(await guardAppRoute(widgetPost(READ_PATH)))).toBe(true);
    const res = await READ(handlerPost(READ_PATH));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("REACHES THE HANDLER: the cookieless DECIDE is answered by the ROUTE's own 401, not a redirect", async () => {
    // Costlier than an unanswered read if it 307s: `fetch` follows the redirect
    // with the method and body intact (a 307 preserves both), /sign-in serves
    // GET only and refuses the POST, and the transport turns that into the
    // row's own refusal — so the run stays blocked and no decision ever reached
    // the core. The handler's 401 is the proof that the decision was refused by
    // the ROUTE rather than swallowed by the proxy.
    expect(isNext(await guardAppRoute(widgetPost(DECIDE_PATH)))).toBe(true);
    const res = await DECIDE(handlerPost(DECIDE_PATH));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("NO SESSION FALLBACK: a COOKIE-BEARING POST is still 401 on both routes", async () => {
    // The contract these two routes were built to: the `cwu_` is the only way
    // in. The embed frame is same-origin to the app, so an ambient cookie
    // belonging to whoever else uses that browser must never answer for the
    // widget's reader. Reachability is unchanged by the cookie (the paths are
    // public), and the handler refuses identically with one present.
    expect(isNext(await guardAppRoute(widgetPost(READ_PATH, SESSION_COOKIE)))).toBe(true);
    expect(isNext(await guardAppRoute(widgetPost(DECIDE_PATH, SESSION_COOKIE)))).toBe(true);
    const read = await READ(handlerPost(READ_PATH, SESSION_COOKIE));
    expect(read.status).toBe(401);
    await expect(read.json()).resolves.toEqual({ error: "Unauthorized" });
    const decide = await DECIDE(handlerPost(DECIDE_PATH, SESSION_COOKIE));
    expect(decide.status).toBe(401);
    await expect(decide.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("EXACTNESS: descendants and near-miss siblings of BOTH paths stay guarded (307)", async () => {
    // The load-bearing consequence of an exact list. `/decide` is a DESCENDANT
    // of the read path and is admitted ONLY by its own entry — so nothing else
    // under that subtree inherits an exemption, and a later parent catch-all or
    // rewrite could not make one routable and public in the same edit.
    for (const p of [
      `${READ_PATH}/`,
      `${READ_PATH}/anything`,
      `${READ_PATH}/decide/`,
      `${READ_PATH}/decide/anything`,
      `${READ_PATH}/state`,
      `${READ_PATH}-foo`,
      `${READ_PATH}s`,
      "/api/lifecycle-views/recommendation",
      "/api/lifecycle-views/recommendation-holds",
    ]) {
      const res = await guardAppRoute(widgetPost(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
  });

  it("SOURCE PIN: both are LIVE exact entries naming their grant, their refusal and their exactness", () => {
    const exactBlock = guardSource.match(
      /const PUBLIC_EXACT_PATHS = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(exactBlock).toBeDefined();
    const expectations: ReadonlyArray<[string, RegExp]> = [
      [`"${READ_PATH}",`, /lifecycle\.read/],
      [`"${DECIDE_PATH}",`, /lifecycle\.decide/],
    ];
    for (const [needle, grant] of expectations) {
      const line = guardSource.split("\n").find((l) => l.includes(needle));
      expect(line, `${needle} must have an entry`).toBeDefined();
      // A LIVE array entry, not a commented-out corpse.
      expect((line ?? "").trimStart().startsWith('"')).toBe(true);
      expect(line ?? "", `${needle} must name its grant`).toMatch(grant);
      expect(line ?? "", `${needle} must name its refusal`).toMatch(/401/);
      expect(
        (line ?? "").toLowerCase(),
        `${needle} must state it is reachability only`,
      ).toMatch(/reachability only/);
      expect(
        (line ?? "").toLowerCase(),
        `${needle} must state the entry is exact`,
      ).toMatch(/exact path, never a prefix/);
      // The second gate is what stops a run this conversation does not own from
      // being projected into a widget thread; an entry that omitted it would
      // describe a weaker route than the one being admitted.
      expect(line ?? "", `${needle} must name the run-to-session binding`).toMatch(
        /widgetSessionOwnsRun/,
      );
      // Reachability is not authentication, and neither entry may imply it is.
      expect(
        (line ?? "").toLowerCase(),
        `${needle} must state there is no session fallback`,
      ).toMatch(/no session fallback|takes no session/);
    }
    // Exact list only. A move onto the prefix list would silently pick up every
    // descendant, so it must be a visible, failing edit.
    expect(exactBlock ?? "").toMatch(/"\/api\/lifecycle-views\/recommendation-hold"/);
    expect(exactBlock ?? "").toMatch(
      /"\/api\/lifecycle-views\/recommendation-hold\/decide"/,
    );
    const prefixBlock = guardSource.match(
      /const PUBLIC_PATH_PREFIXES = \[([\s\S]*?)\n\];/,
    )?.[1];
    expect(prefixBlock ?? "").not.toMatch(/recommendation-hold/);
  });

  it("SOURCE PIN: the exempted paths are byte-equal to the CLIENT's paths and the TOKEN AUDIENCES", () => {
    // Three sources must agree byte-for-byte or the fix is silently undone by a
    // rename: the guard's literals, the paths the card actually POSTs to, and
    // the audiences the `cwu_` is consumed at. The guard carries literals (it
    // runs in the proxy bundle and cannot import `server-only` modules), so
    // this reads the other two as TEXT, exactly as the capture entry's pin does.
    const runtimeSource = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "agents",
        "src",
        "lifecycle-card-runtime.tsx",
      ),
      "utf-8",
    );
    const clientRead = runtimeSource.match(
      /LIFECYCLE_RECOMMENDATION_HOLD_PATH\s*=\s*"([^"]+)"/,
    )?.[1];
    const clientDecide = runtimeSource.match(
      /LIFECYCLE_RECOMMENDATION_DECIDE_PATH\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(clientRead).toBe(READ_PATH);
    expect(clientDecide).toBe(DECIDE_PATH);

    const scopeSource = fs.readFileSync(
      path.resolve(__dirname, "..", "widget-lifecycle-scope.ts"),
      "utf-8",
    );
    const audienceRead = scopeSource.match(
      /WIDGET_LIFECYCLE_RECOMMENDATION_READ_ROUTE_PATH\s*=\s*"([^"]+)"/,
    )?.[1];
    const audienceDecide = scopeSource.match(
      /WIDGET_LIFECYCLE_RECOMMENDATION_DECIDE_ROUTE_PATH\s*=\s*"([^"]+)"/,
    )?.[1];
    expect(audienceRead).toBe(READ_PATH);
    expect(audienceDecide).toBe(DECIDE_PATH);

    expect(guardSource).toContain(`"${clientRead}",`);
    expect(guardSource).toContain(`"${clientDecide}",`);
  });

  it("CONTROL: an unrelated protected path is unaffected by these two entries", async () => {
    for (const p of ["/dashboards", "/agents", "/api/agents/runs/run-2790"]) {
      const res = await guardAppRoute(widgetPost(p));
      expect(res.status, `${p} must stay guarded`).toBe(307);
      expect(res.headers.get("location")).toContain("/sign-in");
    }
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

  it("/design-fixtures/run-step-rail is public in non-production (step-rail row-geometry harness, cinatra#2840)", async () => {
    const res = await guardAppRoute(fakeRequest("/design-fixtures/run-step-rail"));
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

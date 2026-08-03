/**
 * cinatra#2359 — the app-wide route guard (`src/proxy.ts` / `guardAppRoute`)
 * is the FIRST of the two chokepoints that must preserve the caller's
 * destination across a sign-in redirect:
 *
 *   - a cookie-less request to a protected path must 307 to
 *     `/sign-in?next=<the original path + query, percent-encoded>`.
 *   - a request that already carries a session cookie must forward the
 *     current path to the Server Component tree via `CURRENT_PATH_HEADER`
 *     (the documented Next.js pattern for surfacing the current pathname to
 *     Server Components, which have no direct access to the incoming
 *     request's URL) — this is the belt-and-suspenders path for
 *     `requireAuthSession()` when the cookie is present but the session
 *     itself has expired/is invalid.
 *   - a client cannot smuggle a forged `CURRENT_PATH_HEADER` value: the guard
 *     always overwrites it with the value derived from the ACTUAL request,
 *     even if the incoming request already carried a header of that name.
 *
 * See src/lib/__tests__/auth-route-guard-public-paths.test.ts for the
 * PUBLIC_PATH_PREFIXES pinning tests this file deliberately does not repeat.
 */
import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { guardAppRoute } from "../auth-route-guard";
import { CURRENT_PATH_HEADER } from "../auth-redirect-target";

function fakeRequest(
  pathname: string,
  opts: { search?: string; cookie?: string; extraHeaders?: Record<string, string> } = {},
): NextRequest {
  const { search = "", cookie, extraHeaders } = opts;
  const headers = new Headers(extraHeaders);
  if (cookie) headers.set("cookie", cookie);
  return {
    nextUrl: { pathname, search },
    url: `http://localhost${pathname}${search}`,
    cookies: { get: () => undefined },
    headers,
  } as unknown as NextRequest;
}

const SESSION_COOKIE = "better-auth.session_token=abc123";

describe("guardAppRoute — cookie-less redirect preserves the target (cinatra#2359)", () => {
  it("redirects a protected path to /sign-in?next=<encoded path>", async () => {
    const res = await guardAppRoute(fakeRequest("/connectors/my-connector"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location as string);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("next")).toBe("/connectors/my-connector");
  });

  it("preserves the query string as part of the encoded next value", async () => {
    const res = await guardAppRoute(fakeRequest("/dashboards", { search: "?tab=settings" }));
    const url = new URL(res.headers.get("location") as string);
    expect(url.searchParams.get("next")).toBe("/dashboards?tab=settings");
  });

  it("still redirects to /sign-in for the root path (no open-redirect regression from an always-valid next=/)", async () => {
    const res = await guardAppRoute(fakeRequest("/"));
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get("location") as string);
    expect(url.pathname).toBe("/sign-in");
  });
});

describe("guardAppRoute — session-cookie-present path forwards CURRENT_PATH_HEADER (cinatra#2359 belt-and-suspenders)", () => {
  // NextResponse.next({ request: { headers } }) surfaces the overridden
  // request headers to the eventual Server Component render via
  // `x-middleware-request-<name>` response headers (Next's own documented
  // mechanism) — asserting on that is how this test observes the forward
  // without needing a real Next.js request/render cycle.
  it("forwards the current path + query so requireAuthSession() can recover it", async () => {
    const res = await guardAppRoute(
      fakeRequest("/artifacts/abc-123", { search: "?tab=history", cookie: SESSION_COOKIE }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get(`x-middleware-request-${CURRENT_PATH_HEADER}`)).toBe(
      "/artifacts/abc-123?tab=history",
    );
  });

  it("does NOT let a client-forged CURRENT_PATH_HEADER survive — the guard's own value always wins", async () => {
    const res = await guardAppRoute(
      fakeRequest("/dashboards", {
        cookie: SESSION_COOKIE,
        extraHeaders: { [CURRENT_PATH_HEADER]: "https://evil.com" },
      }),
    );
    expect(res.headers.get(`x-middleware-request-${CURRENT_PATH_HEADER}`)).toBe("/dashboards");
  });
});

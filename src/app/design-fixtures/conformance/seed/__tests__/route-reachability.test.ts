/**
 * The seed route's fence REPLACES nothing about its reachability: the route
 * must stay exempt from the sign-in redirect, or the sessionless CI harness
 * would be answered by a 307 to /sign-in instead of by the fence, and a
 * misconfigured harness would look like an auth problem rather than a missing
 * capability.
 *
 * Kept in its own file (no store mocks) so the guard is exercised against the
 * real module graph.
 */
import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

import { guardAppRoute } from "@/lib/auth-route-guard";

function sessionlessRequest(pathname: string): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost${pathname}`,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}

describe("the seed route stays reachable to the sessionless harness", () => {
  it("is NOT redirected to /sign-in — the fence answers, not the guard", async () => {
    const res = await guardAppRoute(sessionlessRequest("/design-fixtures/conformance/seed"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("PAIRED CONTROL: a sibling protected route IS redirected", async () => {
    const res = await guardAppRoute(sessionlessRequest("/design-fixtures/conformance/seed/other"));
    expect(res.headers.get("location")).toContain("/sign-in");
  });
});

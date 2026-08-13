// cinatra#2577 (epic #2564 S8d) — the §III review-target ISLAND's framing wall.
//
// The defect this pins: S2 fixed the island at `frame-ancestors 'self'` in
// next.config.ts on the ground that it "has no legitimate cross-origin
// embedder". S8d gave the widget the SAME review card, so the island is nested
// inside `/embed/assistant` and the registered site frames that — two ancestors,
// one cross-origin. `frame-ancestors` is checked against EVERY ancestor, so a
// `'self'`-only wall blocks the render outright. Reproduced in a browser, at the
// real ancestor chain, with the live header bytes:
//
//   "Framing 'http://localhost:3599/' violates the following Content Security
//    Policy directive: \"frame-ancestors 'self'\". The request has been blocked."
//
// What is asserted here is the whole contract, in one place:
//   • first-party  → `frame-ancestors 'self'` and NOTHING else (unchanged);
//   • widget       → `'self'` PLUS the ONE registered origin, derived server-side;
//   • an unregistered / unknown / ambiguous frame → the first-party wall, never
//     a widened one — so the negative control is that no origin the records do
//     not vouch for can ever appear in the policy.

import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveVerifiedWidgetFrameOrigin = vi.fn();

vi.mock("@/lib/embed/frame-ancestors.server", () => ({
  FRAME_ANCESTORS_NONE: "'none'",
  frameAncestorsDirectiveFor: () => "'none'",
  resolveVerifiedWidgetFrameOrigin: (input: unknown) =>
    resolveVerifiedWidgetFrameOrigin(input),
}));
// The guard's other collaborators are irrelevant to the framing wall and drag a
// generated-inventory graph into a node test; stubbed to their inert answers.
const getSessionCookie = vi.fn(() => "session" as string | null);
vi.mock("better-auth/cookies", () => ({ getSessionCookie: () => getSessionCookie() }));
vi.mock("@/lib/widget-stream-runtime-slug-snapshot", () => ({
  isRuntimeApprovedWidgetStreamPublicPath: () => false,
}));
vi.mock("@/lib/generated/widget-stream-public-paths", () => ({
  GENERATED_WIDGET_STREAM_PUBLIC_PATHS: [],
  GENERATED_WIDGET_STREAM_TOKEN_PATHS: [],
  GENERATED_WIDGET_STREAM_CAPABILITY_PATHS: [],
}));

import { reviewIslandFramingHeaders } from "@/lib/auth-route-guard";

const REGISTERED = "https://site.example";

/** A NextRequest double carrying only what the wall reads. */
function islandRequest(query: Record<string, string> = {}) {
  const url = new URL("https://app.example/lifecycle/review-island");
  url.searchParams.set("ref", "a-ref");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { nextUrl: url } as unknown as Parameters<typeof reviewIslandFramingHeaders>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVerifiedWidgetFrameOrigin.mockReturnValue(REGISTERED);
});

describe("first party — the wall S2 shipped, unchanged", () => {
  it("names 'self' and nothing else when no widget frame is declared", () => {
    // Nothing declared → the shared resolver answers null.
    resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
    const headers = reviewIslandFramingHeaders(islandRequest());
    expect(headers.contentSecurityPolicy).toBe("frame-ancestors 'self'");
    expect(headers.xFrameOptions).toBe("SAMEORIGIN");
    // The wall asks the shared resolver, which answers null for an undeclared
    // frame — the guard never reads an origin out of the request itself.
    expect(resolveVerifiedWidgetFrameOrigin).toHaveBeenCalledWith({
      assistant: null,
      instanceId: null,
    });
  });

  it("does not widen on a HALF-declared frame (either selector alone)", () => {
    // The shared resolver requires BOTH selectors and answers null otherwise.
    resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
    const halves: Record<string, string>[] = [{ assistant: "wordpress" }, { instanceId: "inst-1" }];
    for (const q of halves) {
      const headers = reviewIslandFramingHeaders(islandRequest(q));
      expect(headers.contentSecurityPolicy).toBe("frame-ancestors 'self'");
      expect(headers.xFrameOptions).toBe("SAMEORIGIN");
    }
  });
});

describe("widget — 'self' plus the ONE registered origin", () => {
  it("admits exactly the verified ancestor chain", () => {
    const headers = reviewIslandFramingHeaders(
      islandRequest({ assistant: "wordpress", instanceId: "inst-1" }),
    );
    expect(headers.contentSecurityPolicy).toBe(`frame-ancestors 'self' ${REGISTERED}`);
  });

  it("derives the origin from the SAME server-side resolver the embed uses — never from the request", () => {
    reviewIslandFramingHeaders(islandRequest({ assistant: "wordpress", instanceId: "inst-1" }));
    expect(resolveVerifiedWidgetFrameOrigin).toHaveBeenCalledWith({
      assistant: "wordpress",
      instanceId: "inst-1",
    });
  });

  it("drops X-Frame-Options on the widened arm — XFO cannot express an allow-list", () => {
    const headers = reviewIslandFramingHeaders(
      islandRequest({ assistant: "wordpress", instanceId: "inst-1" }),
    );
    expect(headers.xFrameOptions).toBeNull();
  });

  it("never emits a wildcard", () => {
    const headers = reviewIslandFramingHeaders(
      islandRequest({ assistant: "wordpress", instanceId: "inst-1" }),
    );
    expect(headers.contentSecurityPolicy).not.toContain("*");
  });
});

describe("negative control — an origin the records do not vouch for never appears", () => {
  it("an UNREGISTERED frame (the resolver refuses) gets the first-party wall, not a widened one", () => {
    resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
    const headers = reviewIslandFramingHeaders(
      islandRequest({ assistant: "wordpress", instanceId: "not-a-real-instance" }),
    );
    expect(headers.contentSecurityPolicy).toBe("frame-ancestors 'self'");
    expect(headers.xFrameOptions).toBe("SAMEORIGIN");
  });

  it("'none' is never echoed into the island's own policy", () => {
    resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
    const headers = reviewIslandFramingHeaders(
      islandRequest({ assistant: "forged", instanceId: "forged" }),
    );
    // `'none'` on the island would refuse the FIRST-PARTY card too.
    expect(headers.contentSecurityPolicy).not.toContain("'none'");
  });

  // The BYTE-LEVEL refusals (a wildcard / path / CRLF / quoted value that the
  // URL parser was willing to call an origin) are pinned on the shared resolver
  // itself — src/lib/embed/__tests__/frame-ancestors.server.test.ts. Here the
  // contract is only: whatever it refuses, the wall stays first-party.
  it("a refusal from the resolver is ALWAYS the first-party wall, never a widened one", () => {
    resolveVerifiedWidgetFrameOrigin.mockReturnValue(null);
    const headers = reviewIslandFramingHeaders(
      islandRequest({ assistant: "wordpress", instanceId: "inst-1" }),
    );
    expect(headers.contentSecurityPolicy).toBe("frame-ancestors 'self'");
    expect(headers.xFrameOptions).toBe("SAMEORIGIN");
    expect(headers.widened).toBe(false);
  });

  it("still admits an ordinary registered origin, with a port and as an IPv6 literal", () => {
    for (const origin of ["https://site.example", "http://localhost:8090", "http://[::1]:8090"]) {
      resolveVerifiedWidgetFrameOrigin.mockReturnValue(origin);
      const headers = reviewIslandFramingHeaders(
        islandRequest({ assistant: "wordpress", instanceId: "inst-1" }),
      );
      expect(headers.contentSecurityPolicy).toBe(`frame-ancestors 'self' ${origin}`);
      expect(headers.widened).toBe(true);
    }
  });

  it("an attacker-supplied origin in the query is not a policy input", () => {
    // The resolver is what decides; the request only names selectors. Whatever a
    // caller writes, the emitted origin is the resolver's.
    const headers = reviewIslandFramingHeaders(
      islandRequest({
        assistant: "wordpress",
        instanceId: "inst-1",
        origin: "https://evil.example",
      }),
    );
    expect(headers.contentSecurityPolicy).toBe(`frame-ancestors 'self' ${REGISTERED}`);
    expect(headers.contentSecurityPolicy).not.toContain("evil.example");
  });
});

describe("a widget frame with no session is answered EMPTY, never sent to sign-in", () => {
  // Codex round 1, finding 4. `frame-ancestors` on a 307 is not inherited by the
  // document the browser fetches next, and /sign-in declares no framing policy —
  // so redirecting put Cinatra's interactive sign-in form inside third-party
  // chrome. The empty island is what every other denial here draws.
  it("returns an empty 200 with the widened wall and no sign-in Location", async () => {
    const { guardAppRoute } = await import("@/lib/auth-route-guard");
    const url = new URL("https://app.example/lifecycle/review-island");
    url.searchParams.set("ref", "a-ref");
    url.searchParams.set("assistant", "wordpress");
    url.searchParams.set("instanceId", "inst-1");
    getSessionCookie.mockReturnValue(null);
    const request = {
      nextUrl: url,
      url: url.toString(),
      headers: new Headers(),
      cookies: { get: () => undefined },
    } as unknown as Parameters<typeof guardAppRoute>[0];

    const res = await guardAppRoute(request);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self' ${REGISTERED}`,
    );
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the config no longer sets a second, contradicting wall", () => {
  it("next.config.ts sets NO Content-Security-Policy / X-Frame-Options for the island", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("next.config.ts", "utf8");
    const block = src.slice(src.indexOf('source: "/lifecycle/review-island"'));
    const end = block.indexOf("},");
    const islandHeaders = block.slice(0, end);
    // Two CSP headers INTERSECT — a static 'self' merged with the per-request
    // wall would re-block the very frame this fix admits.
    expect(islandHeaders).not.toMatch(/Content-Security-Policy/);
    expect(islandHeaders).not.toMatch(/X-Frame-Options/);
    // The reader-scoped cache rule stays where it was.
    expect(islandHeaders).toMatch(/Cache-Control/);
  });
});

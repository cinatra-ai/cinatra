/**
 * The embed framing wall, end to end: what a site origin must be to get IN, and
 * what may come OUT into a browser policy.
 *
 * The wall is built from one operator-supplied string — a registered site
 * address — which is later interpolated into a `frame-ancestors` directive. A
 * host that is a SHAPE rather than a place therefore has two chances to do
 * damage: it can be stored at registration, and it can be emitted as policy. So
 * both ends are pinned here, in one file, against the same table of shapes:
 *
 *   1. REGISTRATION — the shared resolver and the connect-site door refuse the
 *      shape, with a message a person can act on.
 *   2. EMISSION — the directive resolver and the REAL policy writer (the route
 *      guard that sets the response header) fail closed to `'none'`, so no
 *      emitted policy can carry a wildcard token even if such a value were
 *      already sitting in storage from before this wall existed.
 *
 * Rung 2 is the one that must hold unconditionally: registration is an
 * authenticated, admin-shaped action and rung 1 is the earlier guard, but a
 * stored row predates any validator and the policy writer is the last honest
 * place to refuse it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { readConnectorConfigMock } = vi.hoisted(() => ({
  readConnectorConfigMock: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
}));

import {
  isConcreteOrigin,
  normalizeConcreteOrigin,
  resolveConcreteOrigin,
} from "@cinatra-ai/streams/origin-policy";
import { validateWidgetOrigin } from "@/lib/connect-provisioning";
import {
  FRAME_ANCESTORS_NONE,
  frameAncestorsDirectiveFor,
  resolveInstanceFrameAncestor,
} from "@/lib/embed/frame-ancestors.server";
import { guardAppRoute } from "@/lib/auth-route-guard";

/**
 * Host shapes that are not places. Every one of them survives `new URL()` — the
 * parser is not a validator — and each would read as a wildcard in a
 * `frame-ancestors` directive, so each is refused at every rung below.
 */
const NON_CONCRETE_HOSTS = [
  "https://*",
  "https://*.example.com",
  "https://%2A.example.com",
  "https://%2a.example.com",
  "https://exam%2Aple.com",
  // A Unicode look-alike the URL parser folds to a literal asterisk — the
  // written form carries none, so only the parsed host gives it away.
  "https://＊.example",
  "*",
  "https://.example.com",
  "https://example..com",
];

/** Real places, for the positive control that the wall still lets a site through. */
const CONCRETE_ORIGINS: Array<[input: string, origin: string]> = [
  ["https://blog.example", "https://blog.example"],
  ["https://blog.example/wp-admin/", "https://blog.example"],
  ["https://blog.example:8443", "https://blog.example:8443"],
  ["https://blog.example:443", "https://blog.example"],
  ["https://xn--mnchen-3ya.example", "https://xn--mnchen-3ya.example"],
  ["https://münchen.example", "https://xn--mnchen-3ya.example"],
  ["http://localhost:3000", "http://localhost:3000"],
  ["https://[::1]:8443", "https://[::1]:8443"],
  ["https://10.0.0.7", "https://10.0.0.7"],
];

beforeEach(() => {
  readConnectorConfigMock.mockReset();
});

// ---------------------------------------------------------------------------
// 1. Registration — the doors a site origin comes in through.
// ---------------------------------------------------------------------------
describe("registration refuses a host that is a shape, not a place", () => {
  it.each(NON_CONCRETE_HOSTS)("the shared resolver refuses %s", (candidate) => {
    const resolved = resolveConcreteOrigin(candidate);
    expect(resolved.ok).toBe(false);
    // A person has to be able to act on the refusal, so it carries a sentence.
    if (!resolved.ok) expect(resolved.message.length).toBeGreaterThan(0);
    expect(normalizeConcreteOrigin(candidate)).toBe("");
    expect(isConcreteOrigin(candidate)).toBe(false);
  });

  it("names an asterisk-shaped host a wildcard rather than merely malformed", () => {
    for (const candidate of ["*", "https://*", "https://%2A.example.com"]) {
      const resolved = resolveConcreteOrigin(candidate);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.refusal).toBe("wildcard");
    }
  });

  it.each(NON_CONCRETE_HOSTS)("the connect-site door refuses %s", (candidate) => {
    vi.stubEnv("NODE_ENV", "production");
    const verdict = validateWidgetOrigin(candidate);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  it.each(CONCRETE_ORIGINS)("still resolves the real site %s", (input, origin) => {
    expect(normalizeConcreteOrigin(input)).toBe(origin);
  });
});

// ---------------------------------------------------------------------------
// 2. Emission — what may reach a `frame-ancestors` policy.
// ---------------------------------------------------------------------------
describe("the framing wall never emits a wildcard-shaped token", () => {
  const withStoredSiteUrl = (siteUrl: string) => {
    readConnectorConfigMock.mockReturnValue({ instances: [{ id: "inst-1", siteUrl }] });
  };

  it.each(NON_CONCRETE_HOSTS)(
    "a stored siteUrl of %s resolves to no origin at all",
    (siteUrl) => {
      withStoredSiteUrl(siteUrl);
      expect(
        resolveInstanceFrameAncestor({ instancesConfigKey: "wordpress", instanceId: "inst-1" }),
      ).toBeNull();
    },
  );

  it.each(NON_CONCRETE_HOSTS)("the directive for a stored %s is 'none'", (siteUrl) => {
    withStoredSiteUrl(siteUrl);
    const directive = frameAncestorsDirectiveFor({
      assistant: "wordpress",
      instanceId: "inst-1",
    });
    expect(directive).toBe(FRAME_ANCESTORS_NONE);
    expect(directive).not.toContain("*");
  });

  it("still emits the registered origin for a real site", () => {
    withStoredSiteUrl("https://blog.example/wp-admin");
    expect(
      frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: "inst-1" }),
    ).toBe("https://blog.example");
  });

  it("does not over-refuse: a star in a stored PATH is not a wildcard host", () => {
    // The wall judges the site, not the decoration. A stored address whose
    // path or query happens to carry a star still names one exact site, and
    // refusing it would take a working embed down for a cosmetic reason.
    withStoredSiteUrl("https://blog.example/wp-admin/edit.php?filter=*");
    expect(
      frameAncestorsDirectiveFor({ assistant: "wordpress", instanceId: "inst-1" }),
    ).toBe("https://blog.example");
  });
});

// ---------------------------------------------------------------------------
// 3. The policy WRITER — the header that actually reaches the browser.
//
// The directive resolver above is a pure function; this is the route guard that
// puts its answer on the wire. Asserting the emitted header (not just the
// resolver's return) is what makes "no wildcard token can reach a policy" a
// statement about the product rather than about one module.
// ---------------------------------------------------------------------------
describe("the emitted Content-Security-Policy header", () => {
  const embedRequest = (query: Record<string, string>): NextRequest => {
    const url = new URL("http://localhost/embed/assistant");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return {
      nextUrl: { pathname: "/embed/assistant", searchParams: url.searchParams },
      url: url.toString(),
      cookies: { get: () => undefined },
      headers: new Headers(),
    } as unknown as NextRequest;
  };

  const cspFor = async (siteUrl: string): Promise<string | null> => {
    readConnectorConfigMock.mockReturnValue({ instances: [{ id: "inst-1", siteUrl }] });
    const response = await guardAppRoute(
      embedRequest({ assistant: "wordpress", instanceId: "inst-1" }),
    );
    return response.headers.get("Content-Security-Policy");
  };

  it.each(NON_CONCRETE_HOSTS)("is frame-ancestors 'none' for a stored %s", async (siteUrl) => {
    const csp = await cspFor(siteUrl);
    expect(csp).toBe("frame-ancestors 'none'");
    expect(csp).not.toContain("*");
  });

  it("carries the registered origin for a real site", async () => {
    expect(await cspFor("https://blog.example/wp-admin")).toBe(
      "frame-ancestors https://blog.example",
    );
  });

  it("is frame-ancestors 'none' when the instance is unknown", async () => {
    readConnectorConfigMock.mockReturnValue({ instances: [] });
    const response = await guardAppRoute(
      embedRequest({ assistant: "wordpress", instanceId: "nope" }),
    );
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });
});

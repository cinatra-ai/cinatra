// Regression test for the production WordPress-instance-save validation probe.
//
// `validateWordPressInstanceConnection` performs two authenticated GETs:
//   1. `wp/v2/users/me?context=edit` — proves reachable + the app-password
//      authenticates + identity.
//   2. The site-settings probe — proves the app-password has administrator
//      (`manage_options`) capability AND yields the real site title.
//
// The second probe historically targeted `wp/v2/administration`, a route that
// is registered by NEITHER WordPress core NOR the cinatra WordPress plugin (the
// plugin only registers routes under the `cinatra/v1` namespace). It therefore
// 404'd in EVERY environment — production included — so the save path threw
// "Unable to retrieve the WordPress site title" right after `/users/me` already
// succeeded, and no instance row ever persisted. The fix points the second
// probe at the core `wp/v2/settings` route. This test pins that route so the
// 404 regression can never silently return.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  // Logging disabled so `validateWordPressInstanceConnection` writes no files.
  readConnectorConfigFromDatabase: vi.fn(() => ({ instances: [], loggingEnabled: false })),
  writeConnectorConfigToDatabase: vi.fn(),
}));

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { wordpress: "wordpress-config" },
  deleteNangoConnection: vi.fn(),
  getNangoConnection: vi.fn(),
  ensureNangoIntegration: vi.fn(),
  getNangoCredentials: vi.fn(),
  importNangoConnection: vi.fn(),
  isNangoConfigured: vi.fn().mockReturnValue(true),
}));

function restRouteOf(url: string): string | null {
  return new URL(url).searchParams.get("rest_route");
}

describe("validateWordPressInstanceConnection — second probe route", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = restRouteOf(String(url));
        calls.push(route ?? String(url));
        if (route === "/wp/v2/users/me") {
          return new Response(JSON.stringify({ name: "Operator" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (route === "/wp/v2/settings") {
          return new Response(JSON.stringify({ title: "Acme Blog" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        // Any other route (e.g. the dead `wp/v2/administration`) 404s — exactly
        // how a real WordPress instance answers an unregistered route.
        return new Response(JSON.stringify({ code: "rest_no_route", message: "No route was found matching the URL and request method." }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  it("probes wp/v2/settings (NOT the dead wp/v2/administration) and derives the title", async () => {
    const { validateWordPressInstanceConnection } = await import("@/lib/wordpress-api");

    const result = await validateWordPressInstanceConnection({
      siteUrl: "https://blog.example.com",
      username: "operator",
      applicationPassword: "abcd EFGH ijkl MNOP",
    });

    // The site-settings probe must hit the core /wp/v2/settings route.
    expect(calls).toContain("/wp/v2/settings");
    // The dead route must never be requested again.
    expect(calls).not.toContain("/wp/v2/administration");
    // Intent preserved: title + identity flow through to the caller.
    expect(result.detectedSiteTitle).toBe("Acme Blog");
    expect(result.detectedUserName).toBe("Operator");
  });

  it("requests only the title field from settings (no site PII like the admin email)", async () => {
    const { validateWordPressInstanceConnection } = await import("@/lib/wordpress-api");
    const fetchMock = vi.mocked(globalThis.fetch);

    await validateWordPressInstanceConnection({
      siteUrl: "https://blog.example.com",
      username: "operator",
      applicationPassword: "abcd EFGH ijkl MNOP",
    });

    const settingsCall = fetchMock.mock.calls.find(([url]) => restRouteOf(String(url)) === "/wp/v2/settings");
    expect(settingsCall, "the settings probe must have been issued").toBeDefined();
    expect(new URL(String(settingsCall![0])).searchParams.get("_fields")).toBe("title");
  });

  it("surfaces an admin-capability error when settings returns 403 after /users/me succeeds", async () => {
    // An Editor-level app password can pass /users/me?context=edit but lacks
    // manage_options, so /wp/v2/settings answers 403.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = restRouteOf(String(url));
        if (route === "/wp/v2/users/me") {
          return new Response(JSON.stringify({ name: "Editor" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: "rest_forbidden", message: "Sorry, you are not allowed to do that." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const { validateWordPressInstanceConnection } = await import("@/lib/wordpress-api");
    await expect(
      validateWordPressInstanceConnection({
        siteUrl: "https://blog.example.com",
        username: "editor",
        applicationPassword: "abcd EFGH ijkl MNOP",
      }),
    ).rejects.toThrow(/administrator \(manage_options\) capability/);
  });
});

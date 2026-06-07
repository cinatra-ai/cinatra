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

const GUARD_PATH = path.resolve(__dirname, "..", "auth-route-guard.ts");
const guardSource = fs.readFileSync(GUARD_PATH, "utf-8");

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

  it("widget-public agent streams are the two exact CMS slugs, not a broad /api/agents prefix", () => {
    expect(guardSource).toMatch(
      /"\/api\/agents\/wordpress-content-editor\/stream"/,
    );
    expect(guardSource).toMatch(
      /"\/api\/agents\/drupal-content-editor\/stream"/,
    );
    // PUBLIC_AGENT_STREAM_PATHS must remain an exact-match list (.includes),
    // never collapse into a public `/api/agents` prefix.
    expect(guardSource).not.toMatch(/"\/api\/agents"/);
  });
});

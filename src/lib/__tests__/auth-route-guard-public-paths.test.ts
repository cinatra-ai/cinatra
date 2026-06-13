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

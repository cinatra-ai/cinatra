/**
 * cinatra#3215 — THE CONNECTOR ROUTE PUBLISHES ITS OWN NAMES.
 *
 * The ratified components drawing requires the names to reach the crumbs from
 * the owning page's server render, strictly after its access checks, and never
 * from a client fetch after paint. The dispatch route is a server component
 * whose module graph (auth, the canonical package store, the extension host
 * context) cannot be mounted in a unit test, so — as with the other composition
 * contracts on this route (`connector-surface-consumers.test.ts`) — the claim
 * locked here is a SOURCE claim: the publisher exists, it is declared below
 * every gate, and every surviving render path carries it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROUTE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

describe("connector dispatch route — the crumb publisher", () => {
  it("renders the server-published crumb island, not a client name fetch", () => {
    expect(ROUTE).toContain(
      'import { CrumbContributions } from "@/components/crumb-contributions"',
    );
    // A server module start to finish: the names are resolved in this render.
    expect(ROUTE.startsWith('import "server-only"')).toBe(true);
    expect(ROUTE).not.toContain('"use client"');
  });

  it("publishes the vendor and connector crumbs the composer reads", () => {
    expect(ROUTE).toContain("const crumbTrail = (");
    expect(ROUTE).toContain("prefix: `/connectors/${encodeURIComponent(vendor)}`");
    expect(ROUTE).toContain(
      "prefix: `/connectors/${encodeURIComponent(vendor)}/${encodeURIComponent(slug)}`",
    );
  });

  it("declares the publisher STRICTLY AFTER every access check on the route", () => {
    const declaredAt = ROUTE.indexOf("const crumbTrail = (");
    expect(declaredAt).toBeGreaterThan(-1);
    // notFound() / redirect() are the route's gates: the policy decision, the
    // vendor/subroute match, and the runtime trust gate. None may run after the
    // names have been published.
    expect(declaredAt).toBeGreaterThan(ROUTE.lastIndexOf("notFound();"));
    expect(declaredAt).toBeGreaterThan(ROUTE.lastIndexOf("redirect(redirectDecision.target)"));
  });

  it("carries the publisher on EVERY surviving render path", () => {
    // The seven returns that render a surface: schema-config with a status
    // probe, probe-less schema-config, the invalid-schema error, the
    // runtime-only rebuild error, the unloadable-module rebuild error, the
    // wordpress-assistant host-status-card page, and the plain bundled-react
    // page. A branch that forgot the island would draw the raw slugs again.
    const mounted = ROUTE.match(/\{crumbTrail\}/g) ?? [];
    expect(mounted).toHaveLength(7);
  });
});

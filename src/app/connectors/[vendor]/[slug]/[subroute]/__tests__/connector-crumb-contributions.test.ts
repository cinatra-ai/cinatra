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
 *
 * cinatra#3214 collapsed the route's TWO schema-config layouts — one for a
 * connector that DECLARES a status probe, one for a probe-less connector —
 * into a single render through the shared, host-owned
 * `SchemaConfigConnectorSetup` shape, because the drawing names one generic
 * setup page and no per-connector layout (`connector-setup-badge.test.ts`
 * locks that single mount). Those two paths therefore publish through that
 * shape instead of through two branch-level mounts, so this file reads BOTH
 * sources and asserts the publisher on each of the seven surviving paths by
 * its own content. The number of publishing sites is unchanged: seven.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROUTE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
const SHARED_SETUP = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "components",
    "extensions",
    "schema-config-connector-setup.tsx",
  ),
  "utf8",
);

describe("connector dispatch route — the crumb publisher", () => {
  it("renders the server-published crumb island, not a client name fetch", () => {
    expect(ROUTE).toContain(
      'import { CrumbContributions } from "@/components/crumb-contributions"',
    );
    // A server module start to finish: the names are resolved in this render.
    expect(ROUTE.startsWith('import "server-only"')).toBe(true);
    expect(ROUTE).not.toContain('"use client"');
  });

  it("publishes the vendor and connector crumbs the composer reads, by their resolved names", () => {
    expect(ROUTE).toContain("const crumbTrail = (");
    // The vendor crumb carries the connector's DECLARED vendor display name,
    // and is published only when the connector declares one.
    expect(ROUTE).toContain(
      "const vendorDisplayName = catalogEntry?.vendorIdentity?.name ?? null;",
    );
    expect(ROUTE).toContain("prefix: `/connectors/${encodeURIComponent(vendor)}`");
    expect(ROUTE).toContain("label: vendorDisplayName,");
    // The connector crumb carries the SAME string the page header writes on
    // every branch beneath.
    expect(ROUTE).toContain(
      "prefix: `/connectors/${encodeURIComponent(vendor)}/${encodeURIComponent(slug)}`",
    );
    expect(ROUTE).toContain("label: displayName,");
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

  // The five surfaces the route draws inline, each named by a string only its
  // own render carries. `where` picks the occurrence where two branches draw
  // the same treatment (the two "requires a rebuild" states are twins).
  const INLINE_SURFACES: ReadonlyArray<{
    path: string;
    anchor: string;
    where?: "first" | "last";
  }> = [
    {
      path: "the invalid-schema error",
      anchor: "This connector's setup schema is invalid.",
    },
    {
      path: "the runtime-only rebuild error",
      anchor: "This connector requires a rebuild.",
      where: "first",
    },
    {
      path: "the unloadable-module rebuild error",
      anchor: "This connector requires a rebuild.",
      where: "last",
    },
    {
      path: "the wordpress-assistant host-status-card page",
      anchor: "<ConnectorStatusProbeCard",
    },
    { path: "the plain bundled-react page", anchor: "{setupPage}", where: "last" },
  ];

  for (const surface of INLINE_SURFACES) {
    it(`mounts the publisher on ${surface.path}`, () => {
      const at =
        surface.where === "last"
          ? ROUTE.lastIndexOf(surface.anchor)
          : ROUTE.indexOf(surface.anchor);
      expect(at).toBeGreaterThan(-1);
      const openedAt = ROUTE.lastIndexOf("return (", at);
      expect(openedAt).toBeGreaterThan(-1);
      // The island is mounted inside THIS return, ahead of the body it names —
      // a branch that forgot it would draw the raw slugs again.
      expect(ROUTE.lastIndexOf("{crumbTrail}", at)).toBeGreaterThan(openedAt);
    });
  }

  it("mounts the publisher on BOTH schema-config paths through the one shared setup shape", () => {
    const mount = ROUTE.match(/<SchemaConfigConnectorSetup\b[\s\S]*?\/>/);
    expect(mount).not.toBeNull();
    // The route hands the island — resolved in ITS render, after ITS gates — to
    // the shared shape...
    expect(mount![0]).toContain("crumbTrail={crumbTrail}");
    // ...where it is a REQUIRED prop, so no caller of the shared shape can draw
    // a setup page that forgot to publish...
    expect(SHARED_SETUP).toContain("crumbTrail: ReactNode;");
    expect(SHARED_SETUP).not.toContain("crumbTrail?: ReactNode;");
    // ...and the shape mounts it as the page's FIRST child, exactly where each
    // of the two collapsed branches mounted it before. One mount, both paths:
    // the connector that declares a status probe and the probe-less one.
    const opened = SHARED_SETUP.indexOf("<ConnectorSetupPage");
    expect(opened).toBeGreaterThan(-1);
    const publishedAt = SHARED_SETUP.indexOf("{crumbTrail}", opened);
    expect(publishedAt).toBeGreaterThan(-1);
    expect(publishedAt).toBeLessThan(SHARED_SETUP.indexOf("<SearchParamToast", opened));
  });

  it("carries the publisher on EVERY surviving render path", () => {
    // Seven surfaces survive on this route: schema-config with a status probe,
    // probe-less schema-config, the invalid-schema error, the runtime-only
    // rebuild error, the unloadable-module rebuild error, the
    // wordpress-assistant host-status-card page, and the plain bundled-react
    // page. Seven mounts publish for them: the route's six (its five inline
    // surfaces plus the hand-off into the shared shape) and the shared shape's
    // own, which serves the two schema-config paths it draws as one.
    const routeMounts = ROUTE.match(/\{crumbTrail\}/g) ?? [];
    const sharedMounts = SHARED_SETUP.match(/\{crumbTrail\}/g) ?? [];
    expect(routeMounts).toHaveLength(6);
    expect(sharedMounts).toHaveLength(1);
    expect(routeMounts.length + sharedMounts.length).toBe(7);
  });
});

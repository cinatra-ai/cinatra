import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbTrail,
  connectorCanonicalCrumbHref,
  CANONICAL_CONNECTOR_SUBROUTE,
} from "../breadcrumb-trail";

// #422 (follow-up to #421): the connector "[slug]" breadcrumb crumb must be a
// real, navigable link to its canonical subroute — not the dead label #421
// left it as — while remaining a 404-safe label on an invalid subroute.

describe("connectorCanonicalCrumbHref", () => {
  it("links the connector [slug] crumb (i=2) on a valid /…/setup path", () => {
    const segments = ["connectors", "acme", "some-connector", "setup"];
    expect(connectorCanonicalCrumbHref(segments, 2)).toBe(
      "/connectors/acme/some-connector/setup",
    );
  });

  it("returns null for the vendor crumb (i=1)", () => {
    const segments = ["connectors", "acme", "some-connector", "setup"];
    expect(connectorCanonicalCrumbHref(segments, 1)).toBeNull();
  });

  it("returns null for a non-connector path", () => {
    expect(
      connectorCanonicalCrumbHref(["configuration", "network", "x"], 2),
    ).toBeNull();
  });

  it("returns null when the subroute is not the canonical one (404-safe)", () => {
    // An invalid subroute `notFound()`s, but <AppShell> still renders the
    // breadcrumb inside the root layout; the crumb must stay a label, not link
    // to the 404.
    const segments = ["connectors", "acme", "some-connector", "configure"];
    expect(connectorCanonicalCrumbHref(segments, 2)).toBeNull();
  });

  it("returns null for the bare connector path with no subroute", () => {
    expect(
      connectorCanonicalCrumbHref(["connectors", "acme", "some-connector"], 2),
    ).toBeNull();
  });

  it("uses the canonical-subroute constant", () => {
    expect(CANONICAL_CONNECTOR_SUBROUTE).toBe("setup");
  });
});

describe("buildBreadcrumbTrail — connector trail", () => {
  it("renders the connector [slug] crumb as a navigable canonical link", () => {
    const crumbs = buildBreadcrumbTrail("/connectors/acme/some-connector/setup");
    expect(crumbs).toHaveLength(4);

    // Connectors root: a normal link.
    expect(crumbs[0]).toMatchObject({ label: "Connectors", href: "/connectors" });
    expect(crumbs[0].nonNavigable).toBeFalsy();

    // Vendor level: stays a non-navigable label (no index page).
    expect(crumbs[1].nonNavigable).toBe(true);

    // Connector level: the #422 fix — a real link to the canonical subroute.
    expect(crumbs[2].label).toBe("Some Connector");
    expect(crumbs[2].href).toBe("/connectors/acme/some-connector/setup");
    expect(crumbs[2].nonNavigable).toBeFalsy();

    // Leaf (current page).
    expect(crumbs[3]).toMatchObject({
      label: "Setup",
      href: "/connectors/acme/some-connector/setup",
    });
  });

  it("keeps the connector crumb a label on an invalid (non-canonical) subroute", () => {
    const crumbs = buildBreadcrumbTrail(
      "/connectors/acme/some-connector/configure",
    );
    expect(crumbs[2].nonNavigable).toBe(true);
    expect(crumbs[2].href).toBe("/connectors/acme/some-connector");
  });

  it("links the connectors list crumb normally", () => {
    const crumbs = buildBreadcrumbTrail("/connectors");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({ label: "Connectors", href: "/connectors" });
    expect(crumbs[0].nonNavigable).toBeFalsy();
  });
});

describe("buildBreadcrumbTrail — other routes (preserved behavior)", () => {
  it("returns the Personal crumb for the root path", () => {
    expect(buildBreadcrumbTrail("/")).toEqual([
      { label: "Personal", href: "/personal" },
    ]);
  });

  it("marks pageless configuration group crumbs non-navigable", () => {
    const crumbs = buildBreadcrumbTrail("/configuration/network/dns");
    expect(crumbs[1].label).toBe("Network");
    expect(crumbs[1].nonNavigable).toBe(true);
    // A non-grouping configuration leaf stays linkable.
    expect(crumbs[2].nonNavigable).toBeFalsy();
  });

  it("collapses a chat thread to Chat > <title>", () => {
    const uuid = "0123abcd-4567-89ab-cdef-0123456789ab";
    const crumbs = buildBreadcrumbTrail(`/chat/${uuid}`, {
      chatThreadTitle: "My Thread",
    });
    expect(crumbs).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "My Thread", href: `/chat/${uuid}` },
    ]);
  });

  it("collapses an agent instance to Agents > <instance name>", () => {
    const crumbs = buildBreadcrumbTrail("/agents/vendor/pkg/inst-1", {
      agentInstanceName: "Sales Bot",
    });
    expect(crumbs).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "Sales Bot", href: "/agents/vendor/pkg/inst-1" },
    ]);
  });

  it("prefers the broadcast page title for the leaf crumb when it matches", () => {
    const crumbs = buildBreadcrumbTrail("/extensions/upload", {
      pageTitle: { title: "Upload Extension", pathname: "/extensions/upload" },
    });
    expect(crumbs[crumbs.length - 1].label).toBe("Upload Extension");
  });

  it("truncates a long trail to four crumbs with a middle ellipsis", () => {
    const crumbs = buildBreadcrumbTrail("/a/b/c/d/e");
    expect(crumbs).toHaveLength(4);
    expect(crumbs[1].ellipsis).toBe(true);
    expect(crumbs[0].label).toBe("A");
    expect(crumbs[3].label).toBe("E");
  });
});

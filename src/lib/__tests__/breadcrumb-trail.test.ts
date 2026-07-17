import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbTrail,
  breadcrumbCrumbKey,
  connectorCanonicalCrumbHref,
  idSegmentPlaceholder,
  isIdLikeSegment,
  isPagelessContainerCrumb,
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

describe("breadcrumbCrumbKey — unique React keys (#499)", () => {
  it("gives distinct keys to two crumbs that legitimately share an href", () => {
    // On a valid connector page the [slug] crumb canonical-links to its subroute
    // (#422), which is the leaf page itself — so crumbs[2] and crumbs[3] share an
    // href. Keying by href alone collided ("two children with the same key").
    const crumbs = buildBreadcrumbTrail(
      "/connectors/cinatra-ai/openai-connector/setup",
    );
    expect(crumbs).toHaveLength(4);
    // Confirm the collision the warning came from is real and intentional.
    expect(crumbs[2].href).toBe(crumbs[3].href);

    const keys = crumbs.map((c, i) => breadcrumbCrumbKey(c, i));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys an ellipsis crumb by index, others by index + href", () => {
    const ellipsis = { label: "…", href: "/x", ellipsis: true };
    expect(breadcrumbCrumbKey(ellipsis, 1)).toBe("ellipsis-1");
    const leaf = { label: "Setup", href: "/a/b" };
    expect(breadcrumbCrumbKey(leaf, 3)).toBe("3-/a/b");
  });

  it("produces all-unique keys for a truncated (ellipsis) trail too", () => {
    const crumbs = buildBreadcrumbTrail("/a/b/c/d/e");
    const keys = crumbs.map((c, i) => breadcrumbCrumbKey(c, i));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildBreadcrumbTrail — marketplace [scope] crumb (#797)", () => {
  it("renders the vendor/scope crumb as a non-navigable label on a detail page", () => {
    const crumbs = buildBreadcrumbTrail(
      "/configuration/marketplace/cinatra-ai/openai-connector",
    );
    expect(crumbs).toHaveLength(4);

    // Configuration and Marketplace ancestors stay navigable links.
    expect(crumbs[0]).toMatchObject({
      label: "Configuration",
      href: "/configuration",
    });
    expect(crumbs[0].nonNavigable).toBeFalsy();
    expect(crumbs[1]).toMatchObject({
      label: "Marketplace",
      href: "/configuration/marketplace",
    });
    expect(crumbs[1].nonNavigable).toBeFalsy();

    // The [scope] level has no page.tsx — must be a plain label, not a link
    // to a 404.
    expect(crumbs[2].label).toBe("Cinatra Ai");
    expect(crumbs[2].nonNavigable).toBe(true);

    // Leaf (current page).
    expect(crumbs[3]).toMatchObject({
      label: "Openai Connector",
      href: "/configuration/marketplace/cinatra-ai/openai-connector",
    });
  });

  it("keeps the static marketplace sibling routes navigable", () => {
    for (const staticSeg of ["submissions", "vendor-applications"]) {
      const crumbs = buildBreadcrumbTrail(
        `/configuration/marketplace/${staticSeg}/x`,
      );
      expect(crumbs[2].nonNavigable).toBeFalsy();
      expect(crumbs[2].href).toBe(`/configuration/marketplace/${staticSeg}`);
    }
  });

  it("keeps the submissions crumb navigable on the admin sub-page", () => {
    const crumbs = buildBreadcrumbTrail(
      "/configuration/marketplace/submissions/admin",
    );
    expect(crumbs[2]).toMatchObject({
      label: "Submissions",
      href: "/configuration/marketplace/submissions",
    });
    expect(crumbs[2].nonNavigable).toBeFalsy();
  });

  it("does not mark depth-3 crumbs pageless outside /configuration/marketplace", () => {
    expect(isPagelessContainerCrumb(["configuration", "extensions", "x"], 2)).toBe(
      false,
    );
    expect(isPagelessContainerCrumb(["marketplace", "foo", "bar"], 2)).toBe(false);
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

  it("collapses an agent instance to Agents > <instance name> (rename-equivalence: the contribution channel renders exactly what the retired agentInstanceName opt did)", () => {
    const crumbs = buildBreadcrumbTrail("/agents/vendor/pkg/inst-1", {
      contributions: [
        { prefix: "/agents/vendor/pkg/inst-1", label: "Sales Bot" },
      ],
    });
    expect(crumbs).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "Sales Bot", href: "/agents/vendor/pkg/inst-1" },
    ]);
  });

  it("keeps the general trail for a 3-segment /agents/vendor/package (404) path", () => {
    const crumbs = buildBreadcrumbTrail("/agents/vendor/pkg");
    expect(crumbs.map((c) => c.label)).toEqual(["Agents", "Vendor", "Pkg"]);
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

// cinatra#1737 — crumb contributions: server-authorized labels for EVERY
// crumb (leaf and intermediate), the short-id placeholder floor, ancestry
// insertions (#1738's hook), and the precedence rules.
describe("buildBreadcrumbTrail — crumb contributions (#1737)", () => {
  const TEAM_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
  const ORG_ID = "faada9fe-8b14-4a4c-9cc5-4ccc757a2f7c";
  const DASH_ID = "c9b24648-f3cd-44cc-b021-820a592466f9";

  it("resolves an INTERMEDIATE id crumb (impossible pre-#1737): Teams > Best Team Ever > Settings", () => {
    const crumbs = buildBreadcrumbTrail(`/teams/${TEAM_ID}/settings`, {
      contributions: [
        { prefix: `/teams/${TEAM_ID}`, label: "Best Team Ever" },
        { prefix: `/teams/${TEAM_ID}/settings`, label: "Settings" },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Teams",
      "Best Team Ever",
      "Settings",
    ]);
    expect(crumbs[1].href).toBe(`/teams/${TEAM_ID}`);
  });

  it("resolves a LEAF id crumb (dashboards)", () => {
    const crumbs = buildBreadcrumbTrail(`/dashboards/${DASH_ID}`, {
      contributions: [
        { prefix: `/dashboards/${DASH_ID}`, label: "Team Agent Operations" },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Dashboards",
      "Team Agent Operations",
    ]);
  });

  it("resolves organizations and projects the same way (no per-route branches)", () => {
    expect(
      buildBreadcrumbTrail(`/organizations/${ORG_ID}`, {
        contributions: [{ prefix: `/organizations/${ORG_ID}`, label: "Acme Inc" }],
      }).map((c) => c.label),
    ).toEqual(["Organizations", "Acme Inc"]);
    expect(
      buildBreadcrumbTrail(`/projects/${TEAM_ID}/permissions`, {
        contributions: [{ prefix: `/projects/${TEAM_ID}`, label: "Apollo" }],
      }).map((c) => c.label),
    ).toEqual(["Projects", "Apollo", "Permissions"]);
  });

  it("renders the short-id placeholder for an unresolved id — leaf and intermediate — never title-cased hex", () => {
    const leaf = buildBreadcrumbTrail(`/dashboards/${DASH_ID}`);
    expect(leaf[1].label).toBe("c9b24648…");
    const mid = buildBreadcrumbTrail(`/teams/${TEAM_ID}/settings`);
    expect(mid[1].label).toBe("9c0dfce6…");
    expect(mid[1].label).not.toMatch(/ /);
    // users + artifacts id routes get the same floor (generic mechanism).
    expect(buildBreadcrumbTrail(`/users/${ORG_ID}`)[1].label).toBe("faada9fe…");
    expect(buildBreadcrumbTrail("/artifacts/abcdef0123456789ab")[1].label).toBe(
      "abcdef01…",
    );
  });

  it("a leaf CONTRIBUTION beats the broadcast page title; the page title still wins when no contribution matches", () => {
    const withBoth = buildBreadcrumbTrail(`/teams/${TEAM_ID}/settings`, {
      pageTitle: {
        title: "Team settings — Best Team Ever",
        pathname: `/teams/${TEAM_ID}/settings`,
      },
      contributions: [
        { prefix: `/teams/${TEAM_ID}/settings`, label: "Settings" },
      ],
    });
    expect(withBoth[withBoth.length - 1].label).toBe("Settings");

    const titleOnly = buildBreadcrumbTrail("/extensions/upload", {
      pageTitle: { title: "Upload Extension", pathname: "/extensions/upload" },
    });
    expect(titleOnly[titleOnly.length - 1].label).toBe("Upload Extension");
  });

  it("a contribution can override href and nonNavigable", () => {
    const crumbs = buildBreadcrumbTrail(`/teams/${TEAM_ID}`, {
      contributions: [
        {
          prefix: `/teams/${TEAM_ID}`,
          label: "Best Team Ever",
          href: `/teams/${TEAM_ID}?tab=overview`,
          nonNavigable: true,
        },
      ],
    });
    expect(crumbs[1]).toMatchObject({
      label: "Best Team Ever",
      href: `/teams/${TEAM_ID}?tab=overview`,
      nonNavigable: true,
    });
  });

  it("the LAST replacement for a prefix wins", () => {
    const crumbs = buildBreadcrumbTrail(`/teams/${TEAM_ID}`, {
      contributions: [
        { prefix: `/teams/${TEAM_ID}`, label: "Old Name" },
        { prefix: `/teams/${TEAM_ID}`, label: "New Name" },
      ],
    });
    expect(crumbs[1].label).toBe("New Name");
  });

  it("insertBefore INSERTS an ancestry crumb (#1738's hook); an absent target skips", () => {
    const crumbs = buildBreadcrumbTrail(`/dashboards/${DASH_ID}`, {
      contributions: [
        { prefix: `/dashboards/${DASH_ID}`, label: "Team Agent Operations" },
        {
          prefix: `/teams/${TEAM_ID}`,
          label: "Best Team Ever",
          insertBefore: `/dashboards/${DASH_ID}`,
        },
        { prefix: "/nowhere", label: "Ghost", insertBefore: "/no/such/crumb" },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Dashboards",
      "Best Team Ever",
      "Team Agent Operations",
    ]);
    expect(crumbs[1].href).toBe(`/teams/${TEAM_ID}`);
  });

  it("contributions (incl. insertions) apply BEFORE the 4-crumb truncation", () => {
    const crumbs = buildBreadcrumbTrail("/a/b/c/d/e", {
      contributions: [
        { prefix: "/a/b/c/d/e", label: "Leaf Resolved" },
        { prefix: "/a/x", label: "Inserted", insertBefore: "/a/b" },
      ],
    });
    expect(crumbs).toHaveLength(4);
    expect(crumbs[1].ellipsis).toBe(true);
    expect(crumbs[3].label).toBe("Leaf Resolved");
  });
});

describe("isIdLikeSegment / idSegmentPlaceholder (#1737)", () => {
  it("matches UUIDs and long bare hex; not wordy or short segments", () => {
    expect(isIdLikeSegment("9c0dfce6-b2cb-4dab-8a01-661ca3288b9a")).toBe(true);
    expect(isIdLikeSegment("abcdef0123456789")).toBe(true);
    expect(isIdLikeSegment("settings")).toBe(false);
    expect(isIdLikeSegment("openai-connector")).toBe(false);
    expect(isIdLikeSegment("deadbeef")).toBe(false); // short hex = plausible word
  });

  it("builds the obvious short-id placeholder", () => {
    expect(idSegmentPlaceholder("9c0dfce6-b2cb-4dab-8a01-661ca3288b9a")).toBe(
      "9c0dfce6…",
    );
  });
});

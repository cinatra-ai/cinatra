import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbTrail,
  breadcrumbCrumbKey,
  connectorCanonicalCrumbHref,
  documentTitleLabelFromTrail,
  documentTitleLabelForAgentInstance,
  idSegmentPlaceholder,
  isIdLikeSegment,
  isPagelessContainerCrumb,
  CANONICAL_CONNECTOR_SUBROUTE,
  type BreadcrumbCrumb,
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
  // RE-PINNED for cinatra#3215. This block used to assert a four-crumb trail
  // ending in "Setup", over a connector crumb reading "Some Connector" — the
  // humanized slug. Both were the defect the issue names, not a floor: the
  // trail is three crumbs now, the connector crumb is its leaf, and an
  // unresolved slug reads verbatim. The #422 canonical link this block was
  // written for is unchanged and still asserted.
  it("renders the connector [slug] crumb as a navigable canonical link", () => {
    const crumbs = buildBreadcrumbTrail("/connectors/acme/some-connector/setup");
    expect(crumbs).toHaveLength(3);

    // Connectors root: a normal link.
    expect(crumbs[0]).toMatchObject({ label: "Connectors", href: "/connectors" });
    expect(crumbs[0].nonNavigable).toBeFalsy();

    // Vendor level: stays a non-navigable label (no index page), and with no
    // published display name it reads the slug verbatim (cinatra#3215).
    expect(crumbs[1].label).toBe("acme");
    expect(crumbs[1].nonNavigable).toBe(true);

    // Connector level: the #422 fix — a real link to the canonical subroute —
    // and now the trail's leaf, since the page's own tab is not a crumb.
    expect(crumbs[2].label).toBe("some-connector");
    expect(crumbs[2].href).toBe("/connectors/acme/some-connector/setup");
    expect(crumbs[2].nonNavigable).toBeFalsy();
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
    // RE-PINNED for cinatra#3215. The collision that first raised #499 was the
    // connector setup page: the [slug] crumb canonical-links to its subroute
    // (#422), which was the very page the "Setup" leaf stood for. That leaf is
    // gone — the page's own tab is no longer a crumb — so the pair is built
    // here instead. The claim under test is unchanged: keying by href alone
    // collides ("two children with the same key"), and the positional key does
    // not.
    const crumbs = buildBreadcrumbTrail(
      "/connectors/cinatra-ai/openai-connector/setup",
      {
        contributions: [
          {
            prefix: "/connectors/cinatra-ai",
            label: "Cinatra AI",
            href: "/connectors/cinatra-ai/openai-connector/setup",
          },
        ],
      },
    );
    expect(crumbs).toHaveLength(3);
    // Confirm the collision the warning came from is real.
    expect(crumbs[1].href).toBe(crumbs[2].href);

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

  it("collapses a chat thread to Chat > <title> (cinatra#1878 W3 grammar)", () => {
    const path = "/chat/cinatra-ai/cinatra-assistant/my-thread";
    const crumbs = buildBreadcrumbTrail(path, { chatThreadTitle: "My Thread" });
    expect(crumbs).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "My Thread", href: path },
    ]);
  });

  it("collapses a REMOTE (instance-scoped) chat thread the same way", () => {
    const path = "/chat/cinatra-ai/wordpress-assistant/site-9/launch-plan";
    const crumbs = buildBreadcrumbTrail(path, { chatThreadTitle: "Launch Plan" });
    expect(crumbs).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "Launch Plan", href: path },
    ]);
  });

  it("a new/empty chat (no thread title) is just Chat", () => {
    // A new chat carries no bus title → the crumb is the bare "Chat".
    expect(buildBreadcrumbTrail("/chat/cinatra-ai/cinatra-assistant")).toEqual([
      { label: "Chat", href: "/chat" },
    ]);
    expect(buildBreadcrumbTrail("/chat")).toEqual([{ label: "Chat", href: "/chat" }]);
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

  // RE-PINNED (cinatra#2934, fix leg 10). A page that is NOT FOUND has no
  // hierarchy, so it has no trail to draw: "Its breadcrumb reads 'Page not
  // found' and nothing else: one crumb, current, with no parent above it." The
  // ancestors of the URL the reader typed name a place they never reached.
  it("a 3-segment /agents/vendor/package path that was NOT FOUND reads Page not found, and nothing else", () => {
    expect(
      buildBreadcrumbTrail("/agents/vendor/pkg", { notFound: true }).map((c) => c.label),
    ).toEqual(["Page not found"]);
  });

  it("the same 3-segment path, reached as a real page, still draws its general trail", () => {
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
    // Org settings publishes the same dual contribution as teams (#1734).
    const orgSettings = buildBreadcrumbTrail(`/organizations/${ORG_ID}/settings`, {
      contributions: [
        { prefix: `/organizations/${ORG_ID}`, label: "Acme Inc" },
        { prefix: `/organizations/${ORG_ID}/settings`, label: "Settings" },
      ],
    });
    expect(orgSettings.map((c) => c.label)).toEqual([
      "Organizations",
      "Acme Inc",
      "Settings",
    ]);
    // Projects settings publishes the same dual contribution as teams (#1733).
    const projectSettings = buildBreadcrumbTrail(`/projects/${TEAM_ID}/settings`, {
      contributions: [
        { prefix: `/projects/${TEAM_ID}`, label: "Apollo" },
        { prefix: `/projects/${TEAM_ID}/settings`, label: "Settings" },
      ],
    });
    expect(projectSettings.map((c) => c.label)).toEqual([
      "Projects",
      "Apollo",
      "Settings",
    ]);
    // The old permissions address survives as a navigable redirect segment
    // (#1733; the /teams/[teamId]/dashboards precedent — never a 404 crumb).
    const legacyPermissions = buildBreadcrumbTrail(
      `/projects/${TEAM_ID}/permissions`,
      { contributions: [{ prefix: `/projects/${TEAM_ID}`, label: "Apollo" }] },
    );
    expect(legacyPermissions.map((c) => c.label)).toEqual([
      "Projects",
      "Apollo",
      "Permissions",
    ]);
    expect(legacyPermissions[2].nonNavigable).toBeFalsy();
  });

  it("renders the short-id placeholder for an unresolved id — leaf and intermediate — never title-cased hex", () => {
    const leaf = buildBreadcrumbTrail(`/dashboards/${DASH_ID}`);
    expect(leaf[1].label).toBe("c9b24648…");
    const mid = buildBreadcrumbTrail(`/teams/${TEAM_ID}/settings`);
    expect(mid[1].label).toBe("9c0dfce6…");
    expect(mid[1].label).not.toMatch(/ /);
    // A legacy 32-char better-auth org id gets the same floor on
    // /organizations/[id] (#1907 acceptance: never a raw 32-char id).
    const legacyOrg = buildBreadcrumbTrail(
      "/organizations/Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs",
    );
    expect(legacyOrg[1].label).toBe("Ul5Hrhxi…");
    expect(legacyOrg[1].label).not.toContain("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs");
    // users + artifacts id routes get the same floor (generic mechanism).
    expect(buildBreadcrumbTrail(`/users/${ORG_ID}`)[1].label).toBe("faada9fe…");
    expect(buildBreadcrumbTrail("/artifacts/abcdef0123456789ab")[1].label).toBe(
      "abcdef01…",
    );
  });

  it("a nested canonical dashboard URL (#1738) yields real ancestry with NO special case", () => {
    // With contributions (the team page + dashboard screen publish post-gate):
    const resolved = buildBreadcrumbTrail(
      `/teams/${TEAM_ID}/dashboards/${DASH_ID}`,
      {
        contributions: [
          { prefix: `/teams/${TEAM_ID}`, label: "Best Team Ever" },
          {
            prefix: `/teams/${TEAM_ID}/dashboards/${DASH_ID}`,
            label: "Team Agent Operations",
          },
        ],
      },
    );
    expect(resolved.map((c) => c.label)).toEqual([
      "Teams",
      "Best Team Ever",
      "Dashboards",
      "Team Agent Operations",
    ]);
    // The Dashboards segment is a PLAIN LABEL, not a link. cinatra#2474 PR2
    // folded the scope-collection page onto the entity landing and deleted the
    // `/teams/[teamId]/dashboards` route outright (no redirect, no shim), so
    // only the `[dashboardId]` canonical-home child remains under that segment —
    // linking the crumb would 404. It is not relinked at the team landing
    // either: that landing is already the crumb immediately before it.
    expect(resolved[2].nonNavigable).toBe(true);

    // Without contributions the id floor still holds at both id positions.
    const unresolved = buildBreadcrumbTrail(
      `/teams/${TEAM_ID}/dashboards/${DASH_ID}`,
    );
    expect(unresolved[1].label).toBe("9c0dfce6…");
    expect(unresolved[3].label).toBe("c9b24648…");
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

  it("matches 32-char legacy better-auth ids (#1907); not near-misses", () => {
    expect(isIdLikeSegment("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs")).toBe(true);
    expect(isIdLikeSegment("bgEWkNFcoODy5NtsIxvPaM1F0lww7GSR")).toBe(true);
    expect(isIdLikeSegment("Ul5HrhxiVFOBJmghOIUWjptssxRMaRX")).toBe(false); // 31 chars
    expect(isIdLikeSegment("legacy-id-looking-segment-with-dash1")).toBe(false);
  });

  it("builds the obvious short-id placeholder", () => {
    expect(idSegmentPlaceholder("9c0dfce6-b2cb-4dab-8a01-661ca3288b9a")).toBe(
      "9c0dfce6…",
    );
    expect(idSegmentPlaceholder("Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs")).toBe(
      "Ul5Hrhxi…",
    );
  });
});

// cinatra#3215 — THE CONNECTOR ROUTE'S CRUMBS ARE NAMES, AND THE TAB IS NOT A
// CRUMB. From the ratified components drawing, Breadcrumb section:
//   "A breadcrumb always reflects the navigation hierarchy — the route the page
//    sits on, not the thing the page happens to be about."
//   "A crumb that stands for an entity id shows that entity's display name — at
//    every position, not only the last."
//   "…never a title-cased raw id."
//   "Never combine with tabs."
describe("buildBreadcrumbTrail — the connector trail names its levels (cinatra#3215)", () => {
  const SETUP_PATH =
    "/connectors/cinatra-ai/google-appointment-schedules-connector/setup";
  const VENDOR_PREFIX = "/connectors/cinatra-ai";
  const CONNECTOR_PREFIX =
    "/connectors/cinatra-ai/google-appointment-schedules-connector";

  // What the owning route publishes from its server render, after its access
  // checks — the same two display names the page header and the connector card
  // write.
  const publishedNames = [
    { prefix: VENDOR_PREFIX, label: "Cinatra AI" },
    { prefix: CONNECTOR_PREFIX, label: "Google Appointment Schedules" },
  ];

  it("(1) shows the connector's display name — the string the page header writes — not the slug", () => {
    const crumbs = buildBreadcrumbTrail(SETUP_PATH, {
      contributions: publishedNames,
    });
    expect(crumbs[2].label).toBe("Google Appointment Schedules");
    // The humanized slug — the string this crumb used to read.
    expect(crumbs[2].label).not.toBe("Google Appointment Schedules Connector");
    // Still the #422 canonical link.
    expect(crumbs[2].href).toBe(SETUP_PATH);
  });

  it("(2) shows the vendor's display name exactly as published — never re-humanized", () => {
    const crumbs = buildBreadcrumbTrail(SETUP_PATH, {
      contributions: publishedNames,
    });
    expect(crumbs[1].label).toBe("Cinatra AI");
    expect(crumbs[1].label).not.toBe("Cinatra Ai");
  });

  it("(2) THE DECLARED FALLBACK: with no display name resolvable the vendor crumb is the slug VERBATIM", () => {
    // The drawing's eight-characters-plus-ellipsis fallback is written for an
    // entity id; a vendor slug is not one. The fix renders the slug verbatim —
    // not humanized, not truncated, not dropped.
    const crumbs = buildBreadcrumbTrail(SETUP_PATH);
    expect(crumbs[1].label).toBe("cinatra-ai");
  });

  it("(2) the connector crumb takes the same verbatim fallback", () => {
    const crumbs = buildBreadcrumbTrail(SETUP_PATH);
    expect(crumbs[2].label).toBe("google-appointment-schedules-connector");
  });

  it("(4) spends NO crumb on the page's own selected tab", () => {
    const crumbs = buildBreadcrumbTrail(SETUP_PATH, {
      contributions: publishedNames,
    });
    expect(crumbs).toHaveLength(3);
    expect(crumbs.map((c) => c.label)).toEqual([
      "Connectors",
      "Cinatra AI",
      "Google Appointment Schedules",
    ]);
    expect(crumbs.some((c) => c.label === "Setup")).toBe(false);
  });

  it("(4) drops the tab crumb on the route SHAPE — not on whether the surface draws a tab strip", () => {
    expect(buildBreadcrumbTrail(SETUP_PATH)).toHaveLength(3);
    expect(
      buildBreadcrumbTrail("/connectors/acme/some-connector/setup"),
    ).toHaveLength(3);
  });

  it("(4) the connector crumb becomes the leaf and still points at the page it names", () => {
    const crumbs = buildBreadcrumbTrail(SETUP_PATH, {
      contributions: publishedNames,
    });
    expect(crumbs[crumbs.length - 1].href).toBe(SETUP_PATH);
  });

  it("(6) NO crumb on the dispatch route is a title-cased slug — at the COMPOSER, nothing published", () => {
    // Each row pairs a path with the two title-cased strings the crumbs used to
    // read at the vendor and connector positions.
    const rows = [
      [SETUP_PATH, "Cinatra Ai", "Google Appointment Schedules Connector"],
      ["/connectors/acme/some-connector/setup", "Acme", "Some Connector"],
      ["/connectors/acme/some-connector", "Acme", "Some Connector"],
      ["/connectors/acme/some-connector/configure", "Acme", "Some Connector"],
    ] as const;
    for (const [pathname, titleCasedVendor, titleCasedConnector] of rows) {
      const segments = pathname.split("/").filter(Boolean);
      const crumbs = buildBreadcrumbTrail(pathname);
      expect(crumbs[1].label).not.toBe(titleCasedVendor);
      expect(crumbs[2].label).not.toBe(titleCasedConnector);
      expect(crumbs[1].label).toBe(segments[1]);
      expect(crumbs[2].label).toBe(segments[2]);
    }
  });

  it("(state axis) a connector whose display name MATCHES its slug reads that name once", () => {
    const crumbs = buildBreadcrumbTrail("/connectors/acme/mailer/setup", {
      contributions: [{ prefix: "/connectors/acme/mailer", label: "mailer" }],
    });
    expect(crumbs).toHaveLength(3);
    expect(crumbs[2].label).toBe("mailer");
  });

  it("(7) the #1737 id floor rule still wins over the verbatim fallback", () => {
    const id = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
    const crumbs = buildBreadcrumbTrail(`/connectors/cinatra-ai/${id}/setup`);
    expect(crumbs[2].label).toBe(idSegmentPlaceholder(id));
  });

  it("(8) the static connector pages keep the trail they draw today", () => {
    // These paths carry no vendor/connector pair, so the connector-route
    // fallback never reads them: the humanized label stands.
    for (const [slug, label] of [
      ["email", "Email"],
      ["drupal", "Drupal"],
      ["resend", "Resend"],
      ["wordpress", "Wordpress"],
    ] as const) {
      const crumbs = buildBreadcrumbTrail(`/connectors/${slug}`);
      expect(crumbs).toHaveLength(2);
      expect(crumbs[1].label).toBe(label);
    }
  });

  it("(8) a non-connector route of the same depth is untouched", () => {
    const crumbs = buildBreadcrumbTrail(
      "/configuration/network/proxy-settings/setup",
    );
    expect(crumbs.map((c) => c.label)).toEqual([
      "Configuration",
      "Network",
      "Proxy Settings",
      "Setup",
    ]);
  });
});

// ---------------------------------------------------------------------------
// READING 3 of cinatra#3004's live-proof round — THE SUB-ROUTE IS NAMED FOR
// WHAT IT SHOWS.
//
// The run's schedule surface lives at `/agents/<vendor>/<pkg>/<run>/trigger`,
// and the crumb was the path segment title-cased: "Trigger". The surface is the
// schedule form, the tab above it says Schedule, and "trigger" is not a word
// this surface uses any more. The ROUTE keeps its path — a bookmark still opens
// the same page — so the label is the only thing that moves.
// ---------------------------------------------------------------------------
describe("buildBreadcrumbTrail — the agent instance's sub-route labels (cinatra#3004)", () => {
  it("names the schedule surface Schedule, on a path that is unchanged", () => {
    const crumbs = buildBreadcrumbTrail("/agents/vendor/pkg/run-1/trigger", {
      contributions: [{ prefix: "/agents/vendor/pkg/run-1", label: "Sales Bot" }],
    });
    expect(crumbs).toEqual([
      { label: "Agents", href: "/agents" },
      { label: "Sales Bot", href: "/agents/vendor/pkg/run-1" },
      { label: "Schedule", href: "/agents/vendor/pkg/run-1/trigger" },
    ]);
  });

  // RE-PINNED (cinatra#2934, fix leg 11). These two read the SUB-ROUTE word,
  // and they still do. What moved is the crumb beside it: the instance position
  // used to title-case its raw path segment when nothing named the run
  // ("run-1" -> "Run 1"), and a typed address therefore drew itself as if it
  // were a name. Every real run id is a UUID, so a segment that is not one names
  // no run at all; the position now has one unresolved reading, the run's KIND.
  it("leaves every other sub-route exactly as it was", () => {
    expect(
      buildBreadcrumbTrail("/agents/vendor/pkg/run-1/permissions").map((c) => c.label),
    ).toEqual(["Agents", "Agent run", "Permissions"]);
    expect(
      buildBreadcrumbTrail("/agents/vendor/pkg/run-1/setup").map((c) => c.label),
    ).toEqual(["Agents", "Agent run", "Setup"]);
  });

  it("renames the sub-route crumb only — a run whose own id is `trigger` is not a schedule", () => {
    // The map is read at the SUB-ROUTE position (segment 5) and nowhere else,
    // so an instance segment that happens to read "trigger" is NOT the schedule
    // surface: it is a run this trail cannot name, and it says so.
    expect(
      buildBreadcrumbTrail("/agents/vendor/pkg/trigger").map((c) => c.label),
    ).toEqual(["Agents", "Agent run"]);
  });
});

// ---------------------------------------------------------------------------
// THE TRAIL NAMES THE RUN, IT NEVER IDENTIFIES IT (cinatra#2934, the sixth
// graded proof set).
//
// The refusal panel and the not-found page both CLEAR the crumb contributions —
// a label published by an authorized visit must not survive into a refused one
// — but clearing them dropped the instance crumb through onto the id-derived
// placeholder underneath, so the trail above a refusal read
// "Agents > <the run id's first eight characters> > Schedule". A truncated
// identifier is still an identifier. The reader typed the address, but the
// trail is chrome the refusal itself draws, and the refusal draws nothing of
// the run.
//
// THE SHAPE IS UNCHANGED, ONLY THE IDENTIFYING HALF IS GONE. An authorized
// reader sees "Agents > <the run> > <the step>"; a refused reader now sees the
// same three-crumb shape with the run crumb saying what the panel's own header
// already says above it — "Agent run" — instead of eight characters of hex.
// A contribution still wins wherever a route published one, so the authorized
// reading is untouched, and the GENERAL branch's placeholder rule (#1737, which
// the conformance driver binds) is untouched too: this is the agent-instance
// crumb and nothing else.
// ---------------------------------------------------------------------------
describe("buildBreadcrumbTrail — the refused reading names no run id (cinatra#2934)", () => {
  const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";

  /** Every run-id substring of three characters or more that `text` contains. */
  function runIdPartsIn(text: string): string[] {
    const hits: string[] = [];
    for (let start = 0; start < RUN_ID.length; start++) {
      for (let end = start + 3; end <= RUN_ID.length; end++) {
        const part = RUN_ID.slice(start, end);
        if (text.includes(part)) hits.push(part);
      }
    }
    return hits;
  }

  it("the run page reading a refused reader gets carries no substring of the run id", () => {
    const labels = buildBreadcrumbTrail(`/agents/vendor/pkg/${RUN_ID}`).map(
      (c) => c.label,
    );
    expect(labels).toEqual(["Agents", "Agent run"]);
    expect(runIdPartsIn(labels.join(" "))).toEqual([]);
  });

  it("the schedule URL reading a refused reader gets carries no substring of the run id", () => {
    const labels = buildBreadcrumbTrail(
      `/agents/vendor/pkg/${RUN_ID}/trigger`,
    ).map((c) => c.label);
    expect(labels).toEqual(["Agents", "Agent run", "Schedule"]);
    expect(runIdPartsIn(labels.join(" "))).toEqual([]);
  });

  /** What the chrome actually puts in the document: every crumb's label, plus
   *  the address of each crumb it draws as an ANCHOR — which is neither the
   *  leaf (drawn as the current page) nor a non-navigable crumb. */
  function drawnTextOf(crumbs: BreadcrumbCrumb[]): string {
    return crumbs
      .flatMap((c, i) => [
        c.label,
        i === crumbs.length - 1 || c.nonNavigable ? "" : c.href,
      ])
      .join(" ");
  }

  it("the schedule URL refusal links nowhere either — the crumb is not an anchor", () => {
    // An intermediate crumb is drawn as a link, and the link's address is the
    // WHOLE id — a longer disclosure than the eight characters the sixth proof
    // set measured. The unresolved crumb is non-navigable, so the chrome draws
    // plain text and the address never reaches the document.
    const crumbs = buildBreadcrumbTrail(`/agents/vendor/pkg/${RUN_ID}/trigger`);
    const instance = crumbs[1];
    expect(instance.label).toBe("Agent run");
    expect(instance.nonNavigable).toBe(true);
    // Every part the reader would SEE — labels, and the addresses of the crumbs
    // the chrome still draws as anchors — carries no piece of the run id.
    const drawn = drawnTextOf(crumbs);
    expect(runIdPartsIn(drawn)).toEqual([]);
  });

  it("the run page refusal draws no anchor to the run either", () => {
    const crumbs = buildBreadcrumbTrail(`/agents/vendor/pkg/${RUN_ID}`);
    expect(crumbs[1].nonNavigable).toBe(true);
    const drawn = drawnTextOf(crumbs);
    expect(runIdPartsIn(drawn)).toEqual([]);
  });

  it("an authorized reading keeps its navigable run crumb", () => {
    const crumbs = buildBreadcrumbTrail(`/agents/vendor/pkg/${RUN_ID}/trigger`, {
      contributions: [
        { prefix: `/agents/vendor/pkg/${RUN_ID}`, label: "Sales Bot" },
      ],
    });
    expect(crumbs[1]).toEqual({
      label: "Sales Bot",
      href: `/agents/vendor/pkg/${RUN_ID}`,
    });
  });

  it("the authorized reader's own trail is untouched — a published contribution still wins", () => {
    const labels = buildBreadcrumbTrail(
      `/agents/vendor/pkg/${RUN_ID}/trigger`,
      {
        contributions: [
          { prefix: `/agents/vendor/pkg/${RUN_ID}`, label: "Sales Bot" },
        ],
      },
    ).map((c) => c.label);
    expect(labels).toEqual(["Agents", "Sales Bot", "Schedule"]);
  });

  it("the general branch's short-id placeholder rule (#1737) is untouched", () => {
    expect(buildBreadcrumbTrail(`/teams/${RUN_ID}`).map((c) => c.label)).toEqual([
      "Teams",
      idSegmentPlaceholder(RUN_ID),
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE TAB MIRRORS THE TRAIL (cinatra#2934, the SEVENTH graded proof set).
//
// The trail above a refused reading was made honest in the previous leg — it
// reads "Agents > Agent run > Schedule" and carries no part of the run id. The
// browser tab did not follow it. It kept the route file's own static literal,
// because a refusal short-circuits BEFORE the screen's dynamic metadata ever
// runs, so nothing downstream was left to write a truthful tab title.
//
// The ratified drawing binds the two together in one sentence: the browser-tab
// title mirrors the resolved trail under the same rules, and an id-bearing
// route never shows a raw id in the tab. So the tab is derived from the trail
// that is already resolved, and from nothing else — one reading, one source,
// and no second rule that can drift away from the first.
//
// It answers NULL rather than guessing whenever the trail's own leaf is still
// unresolved (the short-id placeholder, an id-like label, an empty trail). A
// null means "do not write" — the route's own server-rendered title stands —
// which is strictly safer than putting an identifier in the tab.
// ---------------------------------------------------------------------------
describe("documentTitleLabelFromTrail — the tab mirrors the resolved trail", () => {
  const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
  const RUN_PAGE = `/agents/vendor/pkg/${RUN_ID}`;
  const SCHEDULE = `${RUN_PAGE}/trigger`;
  /** The refused reading: the path the reader typed, contributions cleared. */
  const refused = (pathname: string) =>
    buildBreadcrumbTrail(pathname, { contributions: [] });

  it("takes the schedule refusal's trail leaf — the same word the trail ends on", () => {
    expect(refused(SCHEDULE).map((c) => c.label)).toEqual([
      "Agents",
      "Agent run",
      "Schedule",
    ]);
    expect(documentTitleLabelFromTrail(refused(SCHEDULE))).toBe("Schedule");
  });

  it("takes the run page refusal's trail leaf — the kind, never the run", () => {
    expect(refused(RUN_PAGE).map((c) => c.label)).toEqual(["Agents", "Agent run"]);
    expect(documentTitleLabelFromTrail(refused(RUN_PAGE))).toBe("Agent run");
  });

  it("carries no substring of the run id, on either refused reading", () => {
    for (const pathname of [RUN_PAGE, SCHEDULE]) {
      const label = documentTitleLabelFromTrail(refused(pathname)) ?? "";
      for (let start = 0; start < RUN_ID.length; start++) {
        for (let end = start + 3; end <= RUN_ID.length; end++) {
          expect(label).not.toContain(RUN_ID.slice(start, end));
        }
      }
    }
  });

  it("refuses to write when the trail's leaf is the short-id placeholder", () => {
    const trail: BreadcrumbCrumb[] = [
      { label: "Agents", href: "/agents" },
      { label: idSegmentPlaceholder(RUN_ID), href: "/agents/x" },
    ];
    expect(documentTitleLabelFromTrail(trail)).toBeNull();
  });

  it("refuses to write when the trail's leaf is an id-like label", () => {
    const trail: BreadcrumbCrumb[] = [
      { label: "Agents", href: "/agents" },
      { label: RUN_ID, href: "/agents/x" },
    ];
    expect(documentTitleLabelFromTrail(trail)).toBeNull();
  });

  it("steps over an ellipsis crumb and over an empty label", () => {
    expect(
      documentTitleLabelFromTrail([
        { label: "Agents", href: "/agents" },
        { label: "…", href: "/agents", ellipsis: true },
      ]),
    ).toBe("Agents");
    expect(
      documentTitleLabelFromTrail([
        { label: "Agents", href: "/agents" },
        { label: "   ", href: "/agents/x" },
      ]),
    ).toBe("Agents");
  });

  it("answers null on an empty trail, so nothing is written", () => {
    expect(documentTitleLabelFromTrail([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE DECISION, NOT HALF OF IT (cinatra#2934, convergence of fix leg 8).
//
// The tab title of an agent-instance route is decided from TWO inputs: the
// label the owning page published for the instance crumb, and — when there is
// none — the resolved trail. The published label is not automatically safe:
// the page publishes the id's first eight characters plus an ellipsis whenever
// neither a run name nor a template name is available, and that placeholder is
// still an identifier. The drawing's rule is unqualified — an id-bearing route
// never shows a raw id in the tab — so the SAME guard has to stand in front of
// both inputs. This is the function the shell calls, so the guard cannot be
// bypassed by reaching around it.
//
// The trail's own leaf is not automatically safe either: an agent-instance
// sub-route the trail has no name for is humanized, and a humanized id
// ("9c0dfce6 B2cb 4dab 8a01 661ca3288b9a") no longer looks like an id to a
// raw-form test while still carrying the id. A humanized id is an id.
// ---------------------------------------------------------------------------
describe("documentTitleLabelForAgentInstance — one guard in front of both inputs", () => {
  const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
  const RUN_PAGE = `/agents/vendor/pkg/${RUN_ID}`;
  const SCHEDULE = `${RUN_PAGE}/trigger`;
  const UNNAMED_SUB = `${RUN_PAGE}/${RUN_ID}`;
  const trailFor = (pathname: string) =>
    buildBreadcrumbTrail(pathname, { contributions: [] });
  /** Every substring of the run id three characters and longer. */
  const idPartsIn = (text: string): string[] => {
    const hits: string[] = [];
    for (let start = 0; start < RUN_ID.length; start++)
      for (let end = start + 3; end <= RUN_ID.length; end++)
        if (text.includes(RUN_ID.slice(start, end)))
          hits.push(RUN_ID.slice(start, end));
    return hits;
  };

  it("takes a real published name — the run's own title still wins", () => {
    expect(
      documentTitleLabelForAgentInstance("Weekly digest", trailFor(RUN_PAGE)),
    ).toBe("Weekly digest");
  });

  it("REFUSES the published short-id placeholder and falls back to the trail", () => {
    const published = idSegmentPlaceholder(RUN_ID);
    expect(published).toBe("9c0dfce6…");
    const label = documentTitleLabelForAgentInstance(published, trailFor(RUN_PAGE));
    expect(label).toBe("Agent run");
    expect(idPartsIn(label ?? "")).toEqual([]);
  });

  it("REFUSES a published raw id and falls back to the trail", () => {
    const label = documentTitleLabelForAgentInstance(RUN_ID, trailFor(SCHEDULE));
    expect(label).toBe("Schedule");
    expect(idPartsIn(label ?? "")).toEqual([]);
  });

  it("answers null on a sub-route the trail can only humanize into an id", () => {
    // The trail has no name for this segment, so it title-cases the id.
    const leaf = trailFor(UNNAMED_SUB).at(-1)?.label ?? "";
    expect(idPartsIn(leaf).length).toBeGreaterThan(0);
    // The title must NOT take it: no write, the server title stands.
    expect(documentTitleLabelForAgentInstance(undefined, trailFor(UNNAMED_SUB))).toBeNull();
  });

  it("carries no substring of the run id on any of these readings", () => {
    for (const [published, pathname] of [
      [undefined, RUN_PAGE],
      [undefined, SCHEDULE],
      [undefined, UNNAMED_SUB],
      [idSegmentPlaceholder(RUN_ID), RUN_PAGE],
      [RUN_ID, SCHEDULE],
    ] as const) {
      const label = documentTitleLabelForAgentInstance(published, trailFor(pathname)) ?? "";
      expect(idPartsIn(label)).toEqual([]);
    }
  });
});

describe("documentTitleLabelFromTrail — a humanized id is still an id", () => {
  it("refuses a title-cased id label", () => {
    expect(
      documentTitleLabelFromTrail([
        { label: "Agents", href: "/agents" },
        { label: "9C0dfce6 B2cb 4dab 8a01 661ca3288b9a", href: "/agents/x" },
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE TRAIL IS THE NAVIGATION HIERARCHY (cinatra#2934, fix leg 10).
//
// The ratified components drawing states it in one sentence: a breadcrumb
// "always reflects the navigation hierarchy — the route the page sits on, not
// the thing the page happens to be about", every trail under the agents area
// starts with "Agents", an agent instance is named by the agent's own display
// name, the page that starts a run reads "Agents > Agent run", and a review has
// no trail of its own — "there is no review page view outside the route of the
// agent's run, so 'Agents > Agent run > Review' is not a possible breadcrumb".
// ---------------------------------------------------------------------------
describe("the trail is the navigation hierarchy (fix leg 10)", () => {
  const RUN_ID = "aced3514-1f8e-4a44-9c1e-2b6f0f5a77d1";
  const RUN_PATH = `/agents/vendor/pkg/${RUN_ID}`;
  const REVIEW_PATH = `${RUN_PATH}/review/8f2b1c7d-53aa-4d02-9d31-70b6c4f0a1e2`;
  const RUN_NAME = "Blog Draft Writer Agent (1)";

  it("the review page draws its run's own trail — Agents > <the run> — and no Review leaf", () => {
    const labels = buildBreadcrumbTrail(REVIEW_PATH, {
      contributions: [{ prefix: RUN_PATH, label: RUN_NAME }],
    }).map((c) => c.label);
    expect(labels).toEqual(["Agents", RUN_NAME]);
  });

  it("neither an id nor the Agent run placeholder stands where the run's name is resolvable", () => {
    const labels = buildBreadcrumbTrail(REVIEW_PATH, {
      contributions: [{ prefix: RUN_PATH, label: RUN_NAME }],
    }).map((c) => c.label);
    expect(labels).not.toContain("Agent run");
    expect(labels.join(" ")).not.toContain("aced3514");
  });

  it("keeps the drawing's fixed label only while the run's name is genuinely unavailable", () => {
    expect(buildBreadcrumbTrail(REVIEW_PATH).map((c) => c.label)).toEqual([
      "Agents",
      "Agent run",
    ]);
  });

  it("the schedule sub-route still draws its own crumb — only the review has none", () => {
    expect(
      buildBreadcrumbTrail(`${RUN_PATH}/trigger`, {
        contributions: [{ prefix: RUN_PATH, label: RUN_NAME }],
      }).map((c) => c.label),
    ).toEqual(["Agents", RUN_NAME, "Schedule"]);
  });

  it("the page that starts a run reads Agents > Agent run — the area crumb stays", () => {
    const crumbs = buildBreadcrumbTrail("/agents", {
      pageTitle: { title: "Agent run", pathname: "/agents" },
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Agents", "Agent run"]);
    expect(crumbs[0].href).toBe("/agents");
  });

  it("a deeper page's broadcast title still replaces its own leaf, and nothing above it", () => {
    expect(
      buildBreadcrumbTrail("/extensions/upload", {
        pageTitle: { title: "Upload Extension", pathname: "/extensions/upload" },
      }).map((c) => c.label),
    ).toEqual(["Extensions", "Upload Extension"]);
  });

  it("a page that was not found reads exactly Page not found", () => {
    expect(
      buildBreadcrumbTrail(REVIEW_PATH, { notFound: true }).map((c) => c.label),
    ).toEqual(["Page not found"]);
  });
});

import { describe, it, expect } from "vitest";
import { checkIsActive } from "@/components/nav-group";
import type { NavCollapsible, NavLink } from "@/components/layout-types";

const agents: NavLink = { title: "Agents", url: "/agents" };

describe("checkIsActive — top-level leaf links (cinatra#581)", () => {
  it("is active on the exact section url", () => {
    expect(checkIsActive("/agents", agents)).toBe(true);
  });

  it("is active on a nested sub-route of the section", () => {
    expect(
      checkIsActive(
        "/agents/cinatra-ai/blog-idea-generator-agent/d221630a/permissions",
        agents,
      ),
    ).toBe(true);
  });

  it("is active on a one-level-deep sub-route", () => {
    expect(checkIsActive("/agents/new", agents)).toBe(true);
  });

  it("ignores a trailing query string when matching", () => {
    expect(checkIsActive("/agents?tab=mine", agents)).toBe(true);
    expect(checkIsActive("/agents/new?draft=1", agents)).toBe(true);
  });

  it("does not match a sibling section that shares a string prefix", () => {
    // boundary guard: "/agents" must not light up for "/agent" or "/agents-x"
    expect(checkIsActive("/agent", agents)).toBe(false);
    expect(checkIsActive("/agents-archive", agents)).toBe(false);
  });

  it("does not match an unrelated section", () => {
    expect(checkIsActive("/workflows/123", agents)).toBe(false);
  });

  it("a root ('/') item does not match every route (root guard)", () => {
    const home: NavLink = { title: "Home", url: "/" };
    expect(checkIsActive("/agents/anything", home)).toBe(false);
    expect(checkIsActive("/", home)).toBe(true);
  });

  it("works without mainNav (the SidebarMenuLink leaf call path)", () => {
    // SidebarMenuLink calls checkIsActive(href, item) with mainNav defaulting
    // to false — the regression in cinatra#581 was that this path only matched
    // exact urls.
    expect(checkIsActive("/connectors/google/gmail/setup", {
      title: "Connectors",
      url: "/connectors",
    })).toBe(true);
  });
});

describe("checkIsActive — collapsible groups and sub-items", () => {
  const group: NavCollapsible = {
    title: "Settings",
    items: [
      { title: "Teams", url: "/settings/teams" },
      { title: "Org", url: "/settings/org" },
    ],
  };

  it("highlights the group when a child url is active", () => {
    expect(checkIsActive("/settings/teams", group)).toBe(true);
  });

  it("highlights the group on a route nested under a child", () => {
    expect(checkIsActive("/settings/teams/42/members", group)).toBe(true);
  });

  it("highlights a sub-item on its nested routes (prefix clause)", () => {
    const sub: NavLink = { title: "Teams", url: "/settings/teams" };
    expect(checkIsActive("/settings/teams/42/members", sub)).toBe(true);
  });

  it("does not highlight the group for an unrelated route", () => {
    expect(checkIsActive("/agents", group)).toBe(false);
  });
});

describe("checkIsActive — overlapping links resolve to the most specific (cinatra#581)", () => {
  // Admin group: two leaf links where one url is a prefix of the other.
  const adminLeafUrls = ["/configuration/approvals", "/configuration"];
  const approvals: NavLink = {
    title: "Approvals",
    url: "/configuration/approvals",
  };
  const configuration: NavLink = { title: "Configuration", url: "/configuration" };

  it("on /configuration/approvals only the deeper sibling is active", () => {
    expect(
      checkIsActive("/configuration/approvals", approvals, false, adminLeafUrls),
    ).toBe(true);
    expect(
      checkIsActive("/configuration/approvals", configuration, false, adminLeafUrls),
    ).toBe(false);
  });

  it("on a /configuration sub-route with no deeper sibling, the parent is active", () => {
    expect(
      checkIsActive("/configuration/general", configuration, false, adminLeafUrls),
    ).toBe(true);
    expect(
      checkIsActive("/configuration/general", approvals, false, adminLeafUrls),
    ).toBe(false);
  });

  it("on exactly /configuration only Configuration is active", () => {
    expect(checkIsActive("/configuration", configuration, false, adminLeafUrls)).toBe(true);
    expect(checkIsActive("/configuration", approvals, false, adminLeafUrls)).toBe(false);
  });

  // Data collapsible group: sub-items "/data" and "/data/types" overlap.
  const dataSubUrls = ["/data", "/data/types", "/data-safety/change-sets"];
  const allData: NavLink = { title: "All data", url: "/data" };
  const dataTypes: NavLink = { title: "Data types", url: "/data/types" };

  it("on /data/types only Data types is active, not All data", () => {
    expect(checkIsActive("/data/types", dataTypes, false, dataSubUrls)).toBe(true);
    expect(checkIsActive("/data/types", allData, false, dataSubUrls)).toBe(false);
  });

  it("on a deeper /data/types route only Data types is active", () => {
    expect(checkIsActive("/data/types/contacts", dataTypes, false, dataSubUrls)).toBe(true);
    expect(checkIsActive("/data/types/contacts", allData, false, dataSubUrls)).toBe(false);
  });

  it("on a /data route owned by no deeper sibling, All data is active", () => {
    expect(checkIsActive("/data/records/42", allData, false, dataSubUrls)).toBe(true);
    expect(checkIsActive("/data/records/42", dataTypes, false, dataSubUrls)).toBe(false);
  });

  it("an item's own url in siblingUrls does not suppress itself", () => {
    // siblingUrls includes the item's own url (equal length, not strictly
    // longer), so it must never suppress the item's own prefix match.
    expect(checkIsActive("/agents/new", allData, false, ["/agents"])).toBe(false);
    const agents: NavLink = { title: "Agents", url: "/agents" };
    expect(checkIsActive("/agents/new", agents, false, ["/agents"])).toBe(true);
  });
});

describe("checkIsActive — activePaths claims sibling routes (cinatra#617)", () => {
  // The Analytics → LLM category: one sidebar entry (url /analytics/llm) that
  // owns all of its tabs' routes, including ones outside the /analytics/llm/
  // url-prefix boundary (/analytics/llm-usage, /analytics/api).
  const llm: NavLink = {
    title: "LLM",
    url: "/analytics/llm",
    activePaths: ["/analytics/llm", "/analytics/llm-usage", "/analytics/api"],
  };

  it("is active on its own url (Costs tab)", () => {
    expect(checkIsActive("/analytics/llm", llm)).toBe(true);
  });

  it("is active on a nested sub-route of its url (/analytics/llm/pricing)", () => {
    expect(checkIsActive("/analytics/llm/pricing", llm)).toBe(true);
  });

  it("is active on the Usage tab (sibling route via activePaths)", () => {
    // /analytics/llm-usage is NOT under the /analytics/llm/ boundary, so only
    // activePaths can light it up — the #581 caveat for /analytics/llm*.
    expect(checkIsActive("/analytics/llm-usage", llm)).toBe(true);
  });

  it("is active on the API Requests tab (sibling route via activePaths)", () => {
    expect(checkIsActive("/analytics/api", llm)).toBe(true);
    expect(checkIsActive("/analytics/api?runId=abc", llm)).toBe(true);
  });

  it("does not over-match an unrelated analytics-adjacent route", () => {
    expect(checkIsActive("/analytics/websites", llm)).toBe(false);
    expect(checkIsActive("/analytics/llm-usage-archive", llm)).toBe(false);
  });

  // The Analytics group is a COLLAPSIBLE whose single child (LLM) owns the tab
  // routes via activePaths. The parent must open + highlight on those sibling
  // routes too — otherwise a direct load of /analytics/llm-usage leaves the
  // group collapsed and the LLM entry hidden.
  const analyticsGroup: NavCollapsible = {
    title: "Analytics",
    items: [
      {
        title: "LLM",
        url: "/analytics/llm",
        activePaths: ["/analytics/llm", "/analytics/llm-usage", "/analytics/api"],
      },
    ],
  };

  it("the parent collapsible is active on a child's own url", () => {
    expect(checkIsActive("/analytics/llm", analyticsGroup, true)).toBe(true);
  });

  it("the parent collapsible is active on a child's activePaths sibling routes", () => {
    expect(checkIsActive("/analytics/llm-usage", analyticsGroup, true)).toBe(true);
    expect(checkIsActive("/analytics/api", analyticsGroup, true)).toBe(true);
  });

  it("the parent collapsible is active on a nested child sub-route", () => {
    expect(checkIsActive("/analytics/llm/pricing", analyticsGroup, true)).toBe(true);
  });

  it("the parent collapsible is not active on an unrelated analytics route", () => {
    expect(checkIsActive("/analytics/websites", analyticsGroup, false)).toBe(false);
  });
});

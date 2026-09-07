// THE SCOPE CRUMB (cinatra#2809, per-scope surfaces S3).
//
// The issue's sentences: "the first crumb on every scoped page is the scope's
// NAME (a resolved label via the contribution channel, never the raw id)
// linking to the scope landing; on a persisted instance it is the instance's
// HOME scope, never the path wandered in through; make both collapse branches
// scope-base-aware; adjust truncation so the scope crumb survives; add the
// vendor-level container to the pageless list."

import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbTrail,
  isPagelessContainerCrumb,
  scopeBaseFromSegments,
} from "@/lib/breadcrumb-trail";

const ORG = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";

describe("scopeBaseFromSegments", () => {
  it("recognizes the five scope bases and nothing else", () => {
    expect(scopeBaseFromSegments(["workspace", "agents"])).toBe("/workspace");
    expect(scopeBaseFromSegments(["personal", "agents"])).toBe("/personal");
    expect(scopeBaseFromSegments(["organizations", ORG, "agents"])).toBe(`/organizations/${ORG}`);
    expect(scopeBaseFromSegments(["teams", "t1", "agents"])).toBe("/teams/t1");
    expect(scopeBaseFromSegments(["projects", "p1", "agents"])).toBe("/projects/p1");
    expect(scopeBaseFromSegments(["agents", "acme", "writer", "r1"])).toBeNull();
    expect(scopeBaseFromSegments(["organizations"])).toBeNull();
    expect(scopeBaseFromSegments(["chat", "acme", "helper"])).toBeNull();
  });
});

describe("the agent-instance collapse is scope-base aware", () => {
  it("keeps the BARE trail exactly as it was", () => {
    expect(buildBreadcrumbTrail("/agents/acme/writer/r1").map((c) => c.label)).toEqual([
      "Agents",
      "R1",
    ]);
  });

  it("opens a scoped instance with the scope's NAME, linked to the scope landing", () => {
    const crumbs = buildBreadcrumbTrail(`/organizations/${ORG}/agents/acme/writer/r1`, {
      contributions: [{ prefix: `/organizations/${ORG}`, label: "Northwind Analytics" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Northwind Analytics", "Agents", "R1"]);
    expect(crumbs[0].href).toBe(`/organizations/${ORG}`);
    expect(crumbs[0].nonNavigable).toBeFalsy();
    expect(crumbs[1].href).toBe(`/organizations/${ORG}/agents`);
  });

  it("never title-cases the raw id while the name is unavailable", () => {
    const crumbs = buildBreadcrumbTrail(`/organizations/${ORG}/agents/acme/writer/r1`);
    expect(crumbs[0].label).toBe(`${ORG.slice(0, 8)}…`);
    expect(crumbs[0].label).not.toContain("-4d2e");
  });

  it("names the workspace and the personal scope by their own word", () => {
    expect(buildBreadcrumbTrail("/workspace/agents/acme/writer/r1").map((c) => c.label)).toEqual([
      "Workspace",
      "Agents",
      "R1",
    ]);
    expect(buildBreadcrumbTrail("/personal/agents/acme/writer/r1").map((c) => c.label)).toEqual([
      "Personal",
      "Agents",
      "R1",
    ]);
  });

  it("survives on the DEEPEST scoped route — four crumbs, the scope crumb first", () => {
    const crumbs = buildBreadcrumbTrail(`/teams/t1/agents/acme/writer/r1/settings`, {
      contributions: [{ prefix: "/teams/t1", label: "Growth" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Growth", "Agents", "R1", "Settings"]);
    expect(crumbs.some((c) => c.ellipsis)).toBe(false);
  });

  // BOTH DRAWINGS AT ONCE (forward leg 2). A STEP of the run contributes no
  // crumb (cinatra#3223) — and the scope crumb still heads the trail, so the
  // step suppression reads at the SCOPE-RELATIVE sub-route position, not at a
  // fixed depth that a scope base would shift.
  it("drops the step crumb under a scope base and keeps the scope crumb first", () => {
    const crumbs = buildBreadcrumbTrail(`/teams/t1/agents/acme/writer/r1/trigger`, {
      contributions: [{ prefix: "/teams/t1", label: "Growth" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Growth", "Agents", "R1"]);
    expect(crumbs[0].href).toBe("/teams/t1");
  });

  it("shows the instance's HOME scope, never the path wandered in through", () => {
    const crumbs = buildBreadcrumbTrail(`/organizations/${ORG}/agents/acme/writer/r1`, {
      homeScopeBase: "/teams/t1",
      contributions: [{ prefix: "/teams/t1", label: "Growth" }],
    });
    expect(crumbs[0].label).toBe("Growth");
    expect(crumbs[0].href).toBe("/teams/t1");
  });
});

describe("the chat collapse is scope-base aware", () => {
  it("keeps the BARE trail exactly as it was", () => {
    expect(
      buildBreadcrumbTrail("/chat/acme/helper/my-thread", { chatThreadTitle: "Q3 plan" }).map(
        (c) => c.label,
      ),
    ).toEqual(["Chat", "Q3 plan"]);
    expect(buildBreadcrumbTrail("/chat").map((c) => c.label)).toEqual(["Chat"]);
  });

  it("opens a scoped conversation with the scope's name and its Assistants tab", () => {
    const crumbs = buildBreadcrumbTrail("/teams/t1/assistants/acme/helper/my-thread", {
      chatThreadTitle: "Q3 plan",
      contributions: [{ prefix: "/teams/t1", label: "Growth" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Growth", "Assistants", "Q3 plan"]);
    expect(crumbs[1].href).toBe("/teams/t1/assistants");
  });

  it("leaves the Assistants TAB itself on the ordinary trail", () => {
    expect(
      buildBreadcrumbTrail("/teams/t1/assistants", {
        contributions: [
          { prefix: "/teams/t1", label: "Growth" },
          { prefix: "/teams/t1/assistants", label: "Assistants" },
        ],
      }).map((c) => c.label),
    ).toEqual(["Teams", "Growth", "Assistants"]);
  });
});

describe("truncation keeps the scope crumb", () => {
  it("makes the scope's name the head of a truncated scoped trail", () => {
    const crumbs = buildBreadcrumbTrail(`/organizations/${ORG}/settings/members/roles/editor`, {
      contributions: [{ prefix: `/organizations/${ORG}`, label: "Northwind Analytics" }],
    });
    expect(crumbs).toHaveLength(4);
    expect(crumbs[0].label).toBe("Northwind Analytics");
    expect(crumbs[0].href).toBe(`/organizations/${ORG}`);
    expect(crumbs[1].ellipsis).toBe(true);
    expect(crumbs.map((c) => c.label)).toEqual([
      "Northwind Analytics",
      "…",
      "Roles",
      "Editor",
    ]);
  });

  it("leaves an unscoped truncated trail on its old head", () => {
    const crumbs = buildBreadcrumbTrail("/configuration/instance/branding/logo/upload");
    expect(crumbs[0].label).toBe("Configuration");
    expect(crumbs[1].ellipsis).toBe(true);
  });
});

describe("the vendor level is a pageless container", () => {
  it("marks `<scope-base>/agents/<vendor>` unlinkable", () => {
    const segs = ["teams", "t1", "agents", "acme", "writer"];
    expect(isPagelessContainerCrumb(segs, 3)).toBe(true);
    expect(isPagelessContainerCrumb(segs, 4)).toBe(false);
  });

  it("marks the bare `/agents/<vendor>` unlinkable too", () => {
    expect(isPagelessContainerCrumb(["agents", "acme", "writer"], 1)).toBe(true);
  });

  it("renders the vendor crumb as a label, not a link", () => {
    const crumbs = buildBreadcrumbTrail("/teams/t1/agents/acme/writer", {
      contributions: [{ prefix: "/teams/t1", label: "Growth" }],
    });
    const vendor = crumbs.find((c) => c.label === "Acme");
    expect(vendor?.nonNavigable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A SECOND CUT AT THE HOME SCOPE. The override was wired on
// the agent-instance branch only. A persisted conversation read at the BARE
// chat address -- what a stale bookmark holds, and what the reader is at for
// the instant before the canonical-home redirect -- collapsed to a scopeless
// "Chat" head that led back to nothing.
// ---------------------------------------------------------------------------
describe("the chat branch takes the HOME scope too (convergence)", () => {
  it("heads a bare chat trail with the home scope and its Assistants tab", () => {
    const crumbs = buildBreadcrumbTrail("/chat/acme/helper/my-thread", {
      chatThreadTitle: "My thread",
      homeScopeBase: "/teams/t1",
      contributions: [{ prefix: "/teams/t1", label: "Northwind Ops", href: "/teams/t1" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual(["Northwind Ops", "Assistants", "My thread"]);
    expect(crumbs[0].href).toBe("/teams/t1");
    expect(crumbs[1].href).toBe("/teams/t1/assistants");
  });

  it("the home scope beats the scope the reader wandered in through", () => {
    const crumbs = buildBreadcrumbTrail(`/organizations/${ORG}/assistants/acme/helper/my-thread`, {
      chatThreadTitle: "My thread",
      homeScopeBase: "/teams/t1",
    });
    expect(crumbs[1].href).toBe("/teams/t1/assistants");
    expect(crumbs[0].href).toBe("/teams/t1");
  });

  it("with no home scope the bare trail is unchanged", () => {
    expect(buildBreadcrumbTrail("/chat/acme/helper", {}).map((c) => c.label)).toEqual(["Chat"]);
  });
});

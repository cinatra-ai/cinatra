// cinatra#2807 fix leg 3 — the breadcrumb trail on every scope route.
//
// The ratified Breadcrumb pattern: "A crumb that stands for an entity id shows
// that entity's display name — at every position, not only the last. Names come
// from the owning page's server render, strictly after its access checks; the
// shell never fetches a name from the client after paint. While a name is
// genuinely unavailable, the crumb shows the id's first eight characters plus an
// ellipsis ("9c0dfce6…") — never a title-cased raw id."
//
// The third proof round measured two failures against that sentence on the
// routes this pull request adds: an organization tab read
// "Organizations > 88c63f08… > Northwind Analytics" (the raw id MID-trail while
// the name was already resolved two crumbs right), and the workspace tabs read
// "Workspace > Workspace" (the shell's leaf-crumb rule taking the page heading,
// which on an entity page is the entity, over the tab's own name).
//
// Both are fixed at the seam that owns the names: the scope surface publishes
// what it resolved — the entity crumb AND the tab's leaf crumb — so the trail is
// built from the owning page's own reading, not re-derived from the path.
import { describe, expect, it } from "vitest";

import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import { scopeSurfaceCrumbEntries, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";

/** The trail as the shell builds it: the page's published crumbs, plus the
 *  PageHeader title broadcast the shell applies to the leaf. */
function trail(
  pathname: string,
  scope: ScopeSurfaceRef,
  tab: Parameters<typeof scopeSurfaceCrumbEntries>[1],
  title?: string,
) {
  return buildBreadcrumbTrail(pathname, {
    // The entity page's heading IS the entity — that is what made the leaf
    // crumb repeat it before this fix.
    pageTitle: { title: title ?? "Workspace", pathname },
    contributions: scopeSurfaceCrumbEntries(scope, tab, title),
  }).map((c) => c.label);
}

describe("a workspace tab route", () => {
  it("never reads 'Workspace > Workspace' — the leaf names the TAB", () => {
    expect(trail("/workspace/assistants", { kind: "workspace" }, "assistants")).toEqual([
      "Workspace",
      "Assistants",
    ]);
  });

  it("names the entity alone on the landing", () => {
    expect(trail("/workspace", { kind: "workspace" }, "dashboards")).toEqual(["Workspace"]);
  });
});

describe("an organization tab route", () => {
  const scope = { kind: "organization", id: ORG_ID } as const;

  it("shows the display name at the MIDDLE position, never a raw id", () => {
    const labels = trail(
      `/organizations/${ORG_ID}/assistants`,
      scope,
      "assistants",
      "Northwind Analytics",
    );
    expect(labels).toEqual(["Organizations", "Northwind Analytics", "Assistants"]);
    expect(labels.join(" ")).not.toContain(ORG_ID.slice(0, 8));
  });

  it("falls back to the id's first eight characters plus an ellipsis while the name is unavailable", () => {
    const labels = trail(`/organizations/${ORG_ID}/agents`, scope, "agents");
    expect(labels).toEqual(["Organizations", `${ORG_ID.slice(0, 8)}…`, "Agents"]);
  });
});

describe("a team tab route", () => {
  it("shows the team's name mid-trail and the tab at the leaf", () => {
    expect(
      trail("/teams/t-1234-5678-9abc/agents", { kind: "team", id: "t-1234-5678-9abc" }, "agents", "Growth"),
    ).toEqual(["Teams", "Growth", "Agents"]);
  });
});

describe("a project tab route", () => {
  it("shows the project's name mid-trail and the tab at the leaf", () => {
    expect(
      trail(
        "/projects/p-1234-5678-9abc/artifacts",
        { kind: "project", id: "p-1234-5678-9abc" },
        "artifacts",
        "Q3 Outbound",
      ),
    ).toEqual(["Projects", "Q3 Outbound", "Artifacts"]);
  });
});

describe("a personal tab route", () => {
  it("reads Personal then the tab", () => {
    expect(trail("/personal/skills", { kind: "personal" }, "skills", "Personal")).toEqual([
      "Personal",
      "Skills",
    ]);
  });
});

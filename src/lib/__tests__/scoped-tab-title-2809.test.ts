import { describe, expect, it } from "vitest";

import { agentInstanceTabLabel, buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import type { CrumbContribution } from "@/lib/breadcrumb-contributions";

// ---------------------------------------------------------------------------
// THE TAB TITLE MIRRORS THE RESOLVED TRAIL (cinatra#2809, per-scope surfaces
// S3 — the ratified drawing, Components/Breadcrumb: "The browser-tab title
// mirrors the resolved trail under the same rules: an id-bearing route never
// shows a raw id in the tab.").
//
// The shell used to recognise an agent instance by `segments[0] === "agents"`
// alone, which is the BARE tree, and to read ONE crumb contribution rather
// than the trail. S3 mounts the same surface under five scope bases: on a
// scoped address the recogniser missed and the tab kept the route's own
// metadata while the trail beside it read the resolved names. Reading the
// TRAIL itself also keeps the two agreeing in the windows where the trail
// resolves its leaf some other way — the broadcast page title (the window
// right after the launch redirect), or the id abbreviation.
// ---------------------------------------------------------------------------

const crumb = (prefix: string, label: string): CrumbContribution => ({ prefix, label });

/** The trail as the shell builds it, so the test measures the real pair. */
const titleFor = (pathname: string, contributions: CrumbContribution[] = []) =>
  agentInstanceTabLabel(pathname, buildBreadcrumbTrail(pathname, { contributions }));

describe("cinatra#2809 — the agent tab title under a scope base", () => {
  it("reads the instance crumb on the bare tree, as it always did", () => {
    expect(
      titleFor("/agents/acme/writer/r1", [crumb("/agents/acme/writer/r1", "Author Agent (6)")]),
    ).toBe("Author Agent (6)");
  });

  it("reads the SAME crumb on an organization scope base", () => {
    expect(
      titleFor("/organizations/org1/agents/acme/writer/r1", [
          crumb("/organizations/org1", "Northwind Labs"),
          crumb("/organizations/org1/agents/acme/writer/r1", "Author Agent (6)"),
        ]),
    ).toBe("Author Agent (6)");
  });

  it("reads the launcher under a scope base — `new` is the instance segment there", () => {
    expect(
      titleFor("/organizations/org1/agents/acme/writer/new", [crumb("/organizations/org1/agents/acme/writer/new", "Author Agent")]),
    ).toBe("Author Agent");
  });

  it("reads a team base and the singleton bases alike", () => {
    expect(
      titleFor("/teams/t1/agents/acme/writer/r1", [crumb("/teams/t1/agents/acme/writer/r1", "Growth run")]),
    ).toBe("Growth run");
    expect(
      titleFor("/workspace/agents/acme/writer/r1", [crumb("/workspace/agents/acme/writer/r1", "Workspace run")]),
    ).toBe("Workspace run");
    expect(
      titleFor("/personal/agents/acme/writer/r1", [crumb("/personal/agents/acme/writer/r1", "Personal run")]),
    ).toBe("Personal run");
  });

  it("never shows a raw id: an unresolved instance mirrors the trail's abbreviation", () => {
    const label = titleFor("/organizations/org1/agents/acme/writer/9c0dfce6-1111-2222-3333-444444444444");
    expect(label).toBe("9c0dfce6…");
    expect(label).not.toContain("444444");
  });

  it("returns null off an agent-instance address, so no caller invents a title", () => {
    expect(
      titleFor("/organizations/org1/dashboards/d1", [crumb("/organizations/org1/dashboards/d1", "Q3")]),
    ).toBeNull();
    expect(titleFor("/organizations/org1/agents")).toBeNull();
  });
});

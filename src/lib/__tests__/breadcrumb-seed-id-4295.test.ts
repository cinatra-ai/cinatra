import { describe, expect, it } from "vitest";

import {
  buildBreadcrumbTrail,
  documentTitleLabelFromTrail,
  humanizePathSegment,
  isIdLikeSegment,
} from "../breadcrumb-trail";
import type { CrumbContribution } from "../breadcrumb-contributions";

// cinatra#4295 — the seed namespace is an id namespace. From the ratified
// components drawing, Breadcrumb section: "While a name is genuinely
// unavailable, the crumb shows the id's first eight characters plus an
// ellipsis." src/lib/id-policy.ts lists `org-*`, `team-*` and `proj-*` (the ids
// scripts/seed.mjs writes) as ids that keep validating, so the trail must
// treat them as ids, never title-case them into words ("Org Acme Group").

describe("isIdLikeSegment — the seed namespace (cinatra#4295)", () => {
  it("matches the org-, team- and proj- seed ids", () => {
    expect(isIdLikeSegment("org-acme-group")).toBe(true);
    expect(isIdLikeSegment("team-rob-hardware")).toBe(true);
    expect(isIdLikeSegment("proj-rob-q3-launch")).toBe(true);
  });

  it("does not match route words that only share a stem", () => {
    expect(isIdLikeSegment("organizations")).toBe(false);
    expect(isIdLikeSegment("teams")).toBe(false);
    expect(isIdLikeSegment("projects")).toBe(false);
    expect(isIdLikeSegment("org")).toBe(false);
    expect(isIdLikeSegment("org-")).toBe(false);
    expect(isIdLikeSegment("teams-connector")).toBe(false);
    expect(isIdLikeSegment("project-plan")).toBe(false);
    expect(isIdLikeSegment("Org Acme Group")).toBe(false);
  });
});

// The crumb that stands for the scope itself: the one linking to its base.
function scopeCrumbLabel(
  pathname: string,
  base: string,
  contributions: readonly CrumbContribution[] = [],
) {
  const crumb = buildBreadcrumbTrail(pathname, { contributions }).find(
    (c) => c.href === base,
  );
  return crumb?.label;
}

describe("buildBreadcrumbTrail — a seed-id scope route (cinatra#4295)", () => {
  it("the scope crumb shows the first eight characters plus an ellipsis", () => {
    expect(
      scopeCrumbLabel(
        "/organizations/org-acme-group/agents",
        "/organizations/org-acme-group",
      ),
    ).toBe("org-acme…");
    const crumbs = buildBreadcrumbTrail("/organizations/org-acme-group/agents");
    expect(crumbs.map((c) => c.label)).not.toContain("Org Acme Group");
  });

  it("a team and a project scope crumb follow the same rule", () => {
    expect(
      scopeCrumbLabel("/teams/team-rob-hardware", "/teams/team-rob-hardware"),
    ).toBe("team-rob…");
    expect(
      scopeCrumbLabel("/projects/proj-rob-q3-launch", "/projects/proj-rob-q3-launch"),
    ).toBe("proj-rob…");
  });

  it("a resolved name still wins over the placeholder", () => {
    expect(
      scopeCrumbLabel("/teams/team-rob-hardware", "/teams/team-rob-hardware", [
        { prefix: "/teams/team-rob-hardware", label: "Hardware Engineering" },
      ]),
    ).toBe("Hardware Engineering");
  });

  it("the document title never carries the seed id", () => {
    for (const path of [
      "/teams/team-rob-hardware",
      "/organizations/org-acme-group",
      "/projects/proj-rob-q3-launch",
    ]) {
      const title = documentTitleLabelFromTrail(buildBreadcrumbTrail(path));
      expect(title).toBeNull();
    }
    // A named leaf below the seed scope keeps its own title.
    expect(
      documentTitleLabelFromTrail(
        buildBreadcrumbTrail("/organizations/org-acme-group/agents"),
      ),
    ).toBe("Agents");
  });
});

describe("humanizePathSegment — a malformed percent sign (cinatra#4295)", () => {
  it("does not throw and falls back to the raw segment", () => {
    expect(() => humanizePathSegment("100%")).not.toThrow();
    expect(humanizePathSegment("100%")).toBe("100%");
    expect(() => humanizePathSegment("%E0%A4%A")).not.toThrow();
  });

  it("does not crash the trail", () => {
    expect(() => buildBreadcrumbTrail("/artifacts/100%")).not.toThrow();
    expect(() => buildBreadcrumbTrail("/teams/team-rob-hardware/%E0%A4%A")).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { agentInstanceTabTitle } from "../agent-instance-tab-title";
import {
  agentInstanceTabLabel,
  buildBreadcrumbTrail,
  documentTitleLabelForAgentInstance,
  documentTitleLabelFromTrail,
  humanizePathSegment,
  isIdLikeSegment,
  isIdLikeSegmentAt,
  scopeBaseFromSegments,
} from "../breadcrumb-trail";
import type { CrumbContribution } from "../breadcrumb-contributions";

// cinatra#4295 — the seed namespace is an id namespace. From the ratified
// components drawing, Breadcrumb section: "While a name is genuinely
// unavailable, the crumb shows the id's first eight characters plus an
// ellipsis." src/lib/id-policy.ts lists `org-*`, `team-*` and `proj-*` (the ids
// scripts/seed.mjs writes) as ids that keep validating, so the trail must
// treat them as ids, never title-case them into words ("Org Acme Group").

const segs = (pathname: string) => pathname.split("/").filter(Boolean);

describe("isIdLikeSegmentAt — the seed namespace (cinatra#4295)", () => {
  it("matches the org-, team- and proj- seed ids at the scope id position", () => {
    expect(isIdLikeSegmentAt(segs("/organizations/org-acme-group"), 1)).toBe(true);
    expect(isIdLikeSegmentAt(segs("/teams/team-rob-hardware"), 1)).toBe(true);
    expect(isIdLikeSegmentAt(segs("/projects/proj-rob-q3-launch/agents"), 1)).toBe(true);
  });

  it("matches only the prefix of that scope container", () => {
    expect(isIdLikeSegmentAt(segs("/teams/org-acme-group"), 1)).toBe(false);
    expect(isIdLikeSegmentAt(segs("/organizations/proj-rob-q3-launch"), 1)).toBe(false);
    expect(isIdLikeSegmentAt(segs("/projects/team-rob-hardware"), 1)).toBe(false);
  });

  it("matches a seed-shaped segment at no other position", () => {
    // Position 1 under a container that is not a scope.
    expect(isIdLikeSegmentAt(segs("/connectors/team-acme/x/setup"), 1)).toBe(false);
    // The connector slug position.
    expect(isIdLikeSegmentAt(segs("/connectors/acme/team-connector/setup"), 2)).toBe(false);
    // Below a scope id, and the container word itself.
    expect(isIdLikeSegmentAt(segs("/teams/team-rob-hardware/team-lead"), 2)).toBe(false);
    expect(isIdLikeSegmentAt(segs("/teams/team-rob-hardware"), 0)).toBe(false);
    // An object-prototype word in the container position is not a container.
    expect(isIdLikeSegmentAt(["constructor", "proj-plan"], 1)).toBe(false);
    expect(isIdLikeSegmentAt(["__proto__", "proj-plan"], 1)).toBe(false);
    // Out of range.
    expect(isIdLikeSegmentAt(segs("/teams"), 1)).toBe(false);
  });

  it("refuses malformed seed shapes at the scope id position", () => {
    for (const seg of ["team-", "team", "Team-Rob", "team-rob-", "team--rob", "team-rob_qa", "%E0%A4%A"]) {
      expect(isIdLikeSegmentAt(["teams", seg], 1)).toBe(false);
    }
  });

  it("keeps the UUID, long-hex and legacy-id reading at every position", () => {
    expect(
      isIdLikeSegmentAt(segs("/connectors/acme/9c0dfce6-b2cb-4dab-8a01-661ca3288b9a"), 2),
    ).toBe(true);
    expect(isIdLikeSegmentAt(segs("/artifacts/abcdef0123456789"), 1)).toBe(true);
    expect(isIdLikeSegmentAt(segs("/teams/Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs"), 1)).toBe(true);
  });
});

describe("isIdLikeSegment — no seed reading without a position (cinatra#4295)", () => {
  it("does not match a seed-shaped word on its own", () => {
    // It also judges resolved labels (the tab-title guards), where a seed shape
    // is a name: a connector slug, a marketplace name, a run name.
    expect(isIdLikeSegment("team-connector")).toBe(false);
    expect(isIdLikeSegment("proj-plan")).toBe(false);
    expect(isIdLikeSegment("team-lead")).toBe(false);
    expect(isIdLikeSegment("org-acme-group")).toBe(false);
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

describe("a seed-shaped name outside the scope id position (cinatra#4295)", () => {
  it("a connector slug team-connector stays verbatim", () => {
    expect(
      buildBreadcrumbTrail("/connectors/acme/team-connector/setup").map((c) => c.label),
    ).toEqual(["Connectors", "acme", "team-connector"]);
    expect(
      buildBreadcrumbTrail("/connectors/team-acme/team-connector").map((c) => c.label),
    ).toEqual(["Connectors", "team-acme", "team-connector"]);
  });

  it("proj-plan as a named, non-scope segment keeps its word", () => {
    const path = "/configuration/marketplace/acme/proj-plan";
    const named = buildBreadcrumbTrail(path, {
      contributions: [{ prefix: path, label: "proj-plan" }],
    });
    expect(named.at(-1)?.label).toBe("proj-plan");
    expect(documentTitleLabelFromTrail(named)).toBe("proj-plan");
    // Unnamed, it reads like every other marketplace name, not as an id.
    expect(buildBreadcrumbTrail(path).at(-1)?.label).toBe("Proj Plan");
    // At the connector slug position it is verbatim.
    expect(buildBreadcrumbTrail("/connectors/acme/proj-plan/setup").at(-1)?.label).toBe(
      "proj-plan",
    );
  });

  it("an agent run named team-lead keeps its crumb and its tab title", () => {
    const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
    const path = `/agents/acme/planner/${RUN_ID}`;
    const trail = buildBreadcrumbTrail(path, {
      contributions: [{ prefix: path, label: "team-lead" }],
    });
    expect(trail.at(-1)?.label).toBe("team-lead");
    expect(agentInstanceTabLabel(path, trail)).toBe("team-lead");
    expect(documentTitleLabelForAgentInstance("team-lead", trail)).toBe("team-lead");
    expect(documentTitleLabelFromTrail(trail)).toBe("team-lead");
    expect(
      agentInstanceTabTitle({
        vendor: "acme",
        packageName: "planner",
        instanceId: RUN_ID,
        resolvedInstanceLabel: "team-lead",
      }),
    ).toBe("team-lead");
  });

  it("under a seed scope, the scope is the placeholder and the run keeps its name", () => {
    const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
    const path = `/teams/team-rob-hardware/agents/acme/planner/${RUN_ID}`;
    const trail = buildBreadcrumbTrail(path, {
      contributions: [{ prefix: path, label: "team-lead" }],
    });
    expect(trail.map((c) => c.label)).toEqual(["team-rob…", "Agents", "team-lead"]);
    expect(documentTitleLabelForAgentInstance("team-lead", trail)).toBe("team-lead");
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

// The router reads a percent-encoded container as
// the container itself, so `/%74eams/<id>` is `/teams/<id>` and its seed id is
// still an id. A malformed escape matches no container (fail closed).
describe("an encoded scope container (cinatra#4295)", () => {
  const labels = (pathname: string) => buildBreadcrumbTrail(pathname).map((c) => c.label);
  const titleOf = (pathname: string) =>
    documentTitleLabelFromTrail(buildBreadcrumbTrail(pathname));

  const encoded: Array<[string, string, string]> = [
    // [encoded path, canonical path, placeholder]
    ["/%74eams/team-rob-hardware", "/teams/team-rob-hardware", "team-rob…"],
    ["/%6Frganizations/org-acme-group", "/organizations/org-acme-group", "org-acme…"],
    ["/%6frganizations/org-acme-group", "/organizations/org-acme-group", "org-acme…"],
    ["/pr%6Fjects/proj-rob-q3-launch", "/projects/proj-rob-q3-launch", "proj-rob…"],
    ["/%70%72%6F%6a%65%63%74%73/proj-rob-q3-launch", "/projects/proj-rob-q3-launch", "proj-rob…"],
  ];

  it.each(encoded)("%s reads its seed id as an id", (path, canonical, placeholder) => {
    expect(isIdLikeSegmentAt(segs(path), 1)).toBe(true);
    expect(scopeBaseFromSegments(segs(path))).toBe(path);
    expect(labels(path)).toEqual(labels(canonical));
    expect(labels(path)).toContain(placeholder);
    expect(labels(path).join(" ")).not.toMatch(/Team Rob|Org Acme|Proj Rob/);
    expect(titleOf(path)).toBeNull();
  });

  it("an encoded container keeps its own prefix", () => {
    expect(isIdLikeSegmentAt(segs("/%74eams/org-acme-group"), 1)).toBe(false);
    expect(isIdLikeSegmentAt(segs("/pr%6Fjects/team-rob-hardware"), 1)).toBe(false);
  });

  it("an encoded prototype name is not a container", () => {
    for (const container of ["%63onstructor", "%5F%5Fproto%5F%5F", "__proto__", "constructor"]) {
      expect(isIdLikeSegmentAt([container, "proj-plan"], 1)).toBe(false);
      expect(scopeBaseFromSegments([container, "proj-plan"])).toBeNull();
    }
  });

  it("a malformed escape does not throw and fails closed", () => {
    for (const container of ["%E0%A4%A", "%E0%A4%Ateams", "%74eams%"]) {
      expect(() => isIdLikeSegmentAt([container, "team-rob-hardware"], 1)).not.toThrow();
      expect(isIdLikeSegmentAt([container, "team-rob-hardware"], 1)).toBe(false);
      expect(scopeBaseFromSegments([container, "team-rob-hardware"])).toBeNull();
      expect(() => buildBreadcrumbTrail(`/${container}/team-rob-hardware`)).not.toThrow();
      // The malformed segment itself is never decoded into a word.
      expect(labels(`/${container}/team-rob-hardware`)[0]).toBe(container);
    }
    // A malformed id under an encoded container is no id, and does not throw.
    expect(isIdLikeSegmentAt(["%74eams", "%E0%A4%A"], 1)).toBe(false);
    expect(() => buildBreadcrumbTrail("/%74eams/%E0%A4%A")).not.toThrow();
    expect(titleOf("/%74eams/%E0%A4%A") ?? "").not.toMatch(/^Team/);
  });
});

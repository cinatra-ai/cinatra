import { afterEach, describe, expect, it } from "vitest";

import {
  agentInstanceTabLabel,
  buildBreadcrumbTrail,
  connectorRouteTabLabel,
  documentTitleLabelForAgentInstance,
  documentTitleLabelFromTrail,
  isPagelessContainerCrumb,
} from "../breadcrumb-trail";
import {
  canonicalCrumbPath,
  clearCrumbContributions,
  clearPageNotFound,
  getCrumbSnapshot,
  isPageNotFound,
  markPageNotFound,
  publishCrumbContributions,
  sameCrumbPath,
  selectCrumbContributions,
  type CrumbContribution,
} from "../breadcrumb-contributions";

// cinatra#4295 — the router reads a path segment decoded, so `/%74eams/<id>`
// is `/teams/<id>`. The routes publish their crumb names for the canonical path
// (`encodeURIComponent` of each param). "A resolved name still wins" must hold
// on the encoded address too: every place that compares a published path with
// the current pathname compares the two canonically.

const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
const DASHBOARD_ID = "4f1c2a9e-7b3d-4e8f-9a01-2b3c4d5e6f70";
const TEAM = "/teams/team-rob-hardware";
const TEAM_NAME = "Hardware Engineering";
const ENCODED_TEAM = "/%74eams/team-rob-hardware";
const ENCODED_SCOPE_PATHS = [
  ENCODED_TEAM,
  "/teams/%74eam-rob-hardware",
  "/%74%65%61%6D%73/team%2Drob%2Dhardware",
];
const EPOCH = "u1:o1";

const segs = (pathname: string) => pathname.split("/").filter(Boolean);
const labels = (pathname: string, contributions: readonly CrumbContribution[] = []) =>
  buildBreadcrumbTrail(pathname, { contributions }).map((c) => c.label);

afterEach(() => {
  clearCrumbContributions();
  clearPageNotFound();
});

describe("canonicalCrumbPath — one form for every crumb path comparison", () => {
  it("decodes each segment and encodes it again", () => {
    expect(canonicalCrumbPath(ENCODED_TEAM)).toBe(TEAM);
    expect(canonicalCrumbPath("/%74%65%61%6d%73/team%2drob%2Dhardware")).toBe(TEAM);
    expect(canonicalCrumbPath("/connectors/@acme/x/setup")).toBe(
      `/connectors/${encodeURIComponent("@acme")}/x/setup`,
    );
    expect(canonicalCrumbPath("//teams//team-rob-hardware/")).toBe(TEAM);
  });

  it("keeps an encoded slash inside a segment apart from a segment boundary", () => {
    expect(sameCrumbPath("/teams/a%2Fb", "/teams/a/b")).toBe(false);
    expect(sameCrumbPath("/teams/a%2Fb", "/teams/a%2fb")).toBe(true);
  });

  it("keeps a malformed escape raw, so it matches only itself", () => {
    expect(() => canonicalCrumbPath("/teams/%E0%A4%A")).not.toThrow();
    expect(canonicalCrumbPath("/teams/%E0%A4%A")).toBe("/teams/%E0%A4%A");
    expect(sameCrumbPath("/teams/%E0%A4%A", "/teams/%E0%A4%A")).toBe(true);
    expect(sameCrumbPath("/teams/%E0%A4%A", "/teams/%25E0%25A4%25A")).toBe(false);
    expect(sameCrumbPath("/%74eams%/x", "/teams/x")).toBe(false);
  });

  it("does not join different paths", () => {
    expect(sameCrumbPath(ENCODED_TEAM, "/teams/team-rob-hardwar")).toBe(false);
    expect(sameCrumbPath(ENCODED_TEAM, "/teams/team-rob-hardware/x")).toBe(false);
    expect(sameCrumbPath("/%54eams/team-rob-hardware", TEAM)).toBe(false);
  });
});

describe("buildBreadcrumbTrail — the bare encoded scope route", () => {
  it.each(ENCODED_SCOPE_PATHS)("%s shows the name published for the canonical path", (path) => {
    const contributions = [{ prefix: TEAM, label: TEAM_NAME }];
    expect(labels(path, contributions)).toEqual(["Teams", TEAM_NAME]);
    expect(labels(path, contributions)).toEqual(labels(TEAM, contributions));
    expect(documentTitleLabelFromTrail(buildBreadcrumbTrail(path, { contributions }))).toBe(
      TEAM_NAME,
    );
  });

  it("an encoded publisher prefix matches the raw address too", () => {
    const vendor = encodeURIComponent("@acme");
    const contributions = [
      { prefix: `/connectors/${vendor}`, label: "Acme" },
      { prefix: `/connectors/${vendor}/team-connector`, label: "Team Connector Pro" },
    ];
    expect(labels("/connectors/@acme/team-connector/setup", contributions)).toEqual([
      "Connectors",
      "Acme",
      "Team Connector Pro",
    ]);
  });

  it("without a published name the encoded seed id is still the placeholder", () => {
    expect(labels(ENCODED_TEAM)).toEqual(["Teams", "team-rob…"]);
    expect(labels(ENCODED_TEAM, [{ prefix: "/teams/team-rob-hardwar", label: "X" }])).toEqual([
      "Teams",
      "team-rob…",
    ]);
  });

  it("a scoped page leaf keeps the page title published for the canonical path", () => {
    const pageTitle = { title: "Team settings", pathname: `${TEAM}/settings` };
    expect(
      buildBreadcrumbTrail(`${ENCODED_TEAM}/settings`, { pageTitle }).at(-1)?.label,
    ).toBe("Team settings");
  });

  it("an ancestry insertion targets the canonical crumb path", () => {
    const path = `${ENCODED_TEAM}/dashboards/${DASHBOARD_ID}`;
    const trail = buildBreadcrumbTrail(path, {
      contributions: [
        { prefix: TEAM, label: TEAM_NAME },
        { prefix: `${TEAM}/dashboards/${DASHBOARD_ID}`, label: "Q3 board" },
        {
          prefix: `${TEAM}/folders/f1`,
          label: "Planning",
          insertBefore: `${TEAM}/dashboards/${DASHBOARD_ID}`,
        },
      ],
    });
    // Five crumbs truncate to four, with the named scope crumb as the head.
    expect(trail.map((c) => c.label)).toEqual([TEAM_NAME, "…", "Planning", "Q3 board"]);
  });

  it("an append targets the canonical crumb path", () => {
    const trail = buildBreadcrumbTrail(`${ENCODED_TEAM}/settings`, {
      contributions: [
        { prefix: TEAM, label: TEAM_NAME },
        { prefix: `${TEAM}/settings#members`, label: "Members", appendAfter: `${TEAM}/settings` },
      ],
    });
    expect(trail.map((c) => c.label)).toEqual([
      "Teams",
      TEAM_NAME,
      "Settings",
      "Members",
    ]);
  });

  it("the encoded run-starting page appends its own page", () => {
    expect(labels("/%61gents")).toEqual(labels("/agents"));
    expect(labels("/%61gents")).toEqual(["Agents", "Agent run"]);
    expect(
      buildBreadcrumbTrail("/%61gents", {
        pageTitle: { title: "Start a run", pathname: "/agents" },
      }).map((c) => c.label),
    ).toEqual(["Agents", "Start a run"]);
  });

  it("the Dashboards container under an encoded team is a plain label", () => {
    const path = `${ENCODED_TEAM}/dashboards/${DASHBOARD_ID}`;
    expect(isPagelessContainerCrumb(segs(path), 2)).toBe(true);
    expect(buildBreadcrumbTrail(path)[2]).toMatchObject({
      label: "Dashboards",
      nonNavigable: true,
    });
    expect(buildBreadcrumbTrail(path).map((c) => c.nonNavigable)).toEqual(
      buildBreadcrumbTrail(`${TEAM}/dashboards/${DASHBOARD_ID}`).map((c) => c.nonNavigable),
    );
  });

  it("the connector page's tab crumb is still dropped on an encoded address", () => {
    expect(labels("/connectors/%61cme/team-connector/setup")).toEqual([
      "Connectors",
      "acme",
      "team-connector",
    ]);
  });
});

describe("buildBreadcrumbTrail — the collapsed encoded scope route", () => {
  const RUN = `${TEAM}/agents/acme/planner/${RUN_ID}`;
  const ENCODED_RUN = `${ENCODED_TEAM}/agents/acme/planner/${RUN_ID}`;
  const named = [
    { prefix: TEAM, label: TEAM_NAME },
    { prefix: RUN, label: "Weekly plan" },
  ];

  it("an agent instance shows the scope and run names published for the canonical paths", () => {
    const trail = buildBreadcrumbTrail(ENCODED_RUN, { contributions: named });
    expect(trail.map((c) => c.label)).toEqual([TEAM_NAME, "Agents", "Weekly plan"]);
    expect(trail[2]?.nonNavigable).toBeUndefined();
    expect(trail.map((c) => c.label)).toEqual(
      buildBreadcrumbTrail(RUN, { contributions: named }).map((c) => c.label),
    );
  });

  it("the agent-instance tab label reads the published run name", () => {
    const trail = buildBreadcrumbTrail(ENCODED_RUN, { contributions: named });
    expect(agentInstanceTabLabel(ENCODED_RUN, trail)).toBe("Weekly plan");
    expect(documentTitleLabelForAgentInstance("Weekly plan", trail)).toBe("Weekly plan");
    // Without a published name the unresolved run is the kind, never the id.
    const bare = buildBreadcrumbTrail(ENCODED_RUN);
    expect(bare.map((c) => c.label)).toEqual(["team-rob…", "Agents", "Agent run"]);
    expect(agentInstanceTabLabel(ENCODED_RUN, bare)).toBe("Agent run");
  });

  it("a step append after the run targets the canonical run path", () => {
    const trail = buildBreadcrumbTrail(ENCODED_RUN, {
      contributions: [...named, { prefix: `${RUN}#first`, label: "Collect", appendAfter: RUN }],
    });
    expect(trail.map((c) => c.label)).toEqual([TEAM_NAME, "Agents", "Weekly plan", "Collect"]);
  });

  it("a scoped chat shows the scope name published for the canonical path", () => {
    expect(labels(`${ENCODED_TEAM}/assistants/acme/helper`, named)).toEqual([
      TEAM_NAME,
      "Assistants",
    ]);
  });
});

describe("buildBreadcrumbTrail — deep encoded scope routes", () => {
  it("a five-segment route keeps the named scope crumb as its head", () => {
    const path = `${ENCODED_TEAM}/agents/acme/planner`;
    const trail = buildBreadcrumbTrail(path, { contributions: [{ prefix: TEAM, label: TEAM_NAME }] });
    expect(trail.map((c) => c.label)).toEqual([TEAM_NAME, "…", "Acme", "Planner"]);
    expect(trail[0]?.href).toBe(ENCODED_TEAM);
  });

  it("the agent vendor level under an encoded scope is a plain label", () => {
    const path = `${ENCODED_TEAM}/agents/acme/planner`;
    expect(isPagelessContainerCrumb(segs(path), 3)).toBe(true);
    expect(buildBreadcrumbTrail(path).at(-2)).toMatchObject({ label: "Acme", nonNavigable: true });
  });

  it("a deeper route reads the same trail as its canonical path", () => {
    const tail = "/settings/members/invites";
    const contributions = [{ prefix: TEAM, label: TEAM_NAME }];
    expect(labels(`${ENCODED_TEAM}${tail}`, contributions)).toEqual(
      labels(`${TEAM}${tail}`, contributions),
    );
    expect(labels(`${ENCODED_TEAM}${tail}`, contributions)[0]).toBe(TEAM_NAME);
  });
});

describe("connectorRouteTabLabel — an encoded connector address", () => {
  it("reads the label published for the canonical route path", () => {
    const vendor = encodeURIComponent("@acme");
    expect(
      connectorRouteTabLabel("/connectors/@acme/team-connector/setup", [
        { prefix: `/connectors/${vendor}/team-connector/setup`, label: "Team Connector Pro" },
      ]),
    ).toBe("Team Connector Pro");
    expect(
      connectorRouteTabLabel("/connectors/%61cme/team-connector/setup", [
        { prefix: "/connectors/acme/team-connector/setup", label: "Team Connector Pro" },
      ]),
    ).toBe("Team Connector Pro");
    expect(
      connectorRouteTabLabel("/connectors/%61cme/team-connector/setup", [
        { prefix: "/connectors/acme/other/setup", label: "Other" },
      ]),
    ).toBeNull();
  });
});

describe("the crumb bus — encoded and canonical paths are one path", () => {
  it("selects the canonical replacements on the encoded address", () => {
    publishCrumbContributions(ENCODED_TEAM, EPOCH, [{ prefix: TEAM, label: TEAM_NAME }]);
    expect(selectCrumbContributions(ENCODED_TEAM, EPOCH)).toEqual([
      { prefix: TEAM, label: TEAM_NAME },
    ]);
    // Soft navigation below the scope still seeds the name.
    expect(selectCrumbContributions(`${ENCODED_TEAM}/settings`, EPOCH)).toEqual([
      { prefix: TEAM, label: TEAM_NAME },
    ]);
    // A path that only shares the text is not below it.
    expect(selectCrumbContributions("/%74eams/team-rob-hardwarex", EPOCH)).toEqual([]);
    expect(selectCrumbContributions(ENCODED_TEAM, "u2:o1")).toEqual([]);
  });

  it("keeps an encoded slash inside a segment apart when selecting", () => {
    publishCrumbContributions("/teams/a%2Fb", EPOCH, [{ prefix: "/teams/a%2Fb", label: "AB" }]);
    expect(selectCrumbContributions("/teams/a/b", EPOCH)).toEqual([]);
    expect(selectCrumbContributions("/teams/a%2fb", EPOCH)).toHaveLength(1);
  });

  it("position entries apply while the snapshot's own path is current, read canonically", () => {
    const insertion = {
      prefix: `${TEAM}/folders/f1`,
      label: "Planning",
      insertBefore: `${TEAM}/settings`,
    };
    publishCrumbContributions(`${TEAM}/settings`, EPOCH, [insertion]);
    expect(selectCrumbContributions(`${ENCODED_TEAM}/settings`, EPOCH)).toEqual([insertion]);
    expect(selectCrumbContributions(ENCODED_TEAM, EPOCH)).toEqual([]);
  });

  it("the dedupe treats an encoded and a canonical prefix as one crumb", () => {
    publishCrumbContributions(TEAM, EPOCH, [
      { prefix: TEAM, label: "Old name" },
      { prefix: ENCODED_TEAM, label: TEAM_NAME },
    ]);
    expect(getCrumbSnapshot()?.entries).toEqual([{ prefix: ENCODED_TEAM, label: TEAM_NAME }]);
  });

  it("the not-found mark reads the encoded and the canonical path as one", () => {
    markPageNotFound(ENCODED_TEAM);
    expect(isPageNotFound(TEAM)).toBe(true);
    expect(isPageNotFound(`${TEAM}/settings`)).toBe(false);
    clearPageNotFound("/teams/other");
    expect(isPageNotFound(ENCODED_TEAM)).toBe(true);
    clearPageNotFound(TEAM);
    expect(isPageNotFound(ENCODED_TEAM)).toBe(false);
  });
});

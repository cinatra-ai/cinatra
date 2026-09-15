/**
 * PER-SCOPE ARTIFACT OWNERSHIP FIXTURES (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance items this file proves, verbatim:
 *
 *   "Per-scope ownership fixtures (each scope lists only its owned rows;
 *    workspace = the `WorkspaceVantage` union incl. workspace-tier rows;
 *    malformed missing-owner rows excluded everywhere) — including MIXED-AXIS
 *    fixtures (a row carrying both `projectId` and a non-project owner locus
 *    appears exactly once, on the project tab)."
 *
 *   "Net-new **ownership-subset readers** for artifacts and skills, keyed on
 *    the row's DURABLE ownership tuple (owner level + owner id; project via
 *    `projectId`)."
 *
 *   "**Artifact project classification (bound BEFORE implementation):** for
 *    artifact ownership tabs, a non-null `projectId` is the row's EXCLUSIVE
 *    displayed locus and takes precedence over `ownerLevel`; only rows with
 *    `projectId IS NULL` are classified by `ownerLevel`/`ownerId`. Empty,
 *    unresolved, cross-org, or unauthorized project ids fail closed."
 *
 *   "ownership is read from the durable tuple; … Not the `?scope=` filter — a
 *    source-level read."
 *
 * Every case drives the PURE reader over `listArtifacts`-shaped rows, so a
 * fixture states exactly the ownership tuple under test.
 *
 * The workspace arm builds its vantage through #2808's OWN exported builder
 * (`buildWorkspaceVantage`), consumed here exactly as that slice ships it — the
 * epic's normative value is never re-composed in this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceVantage,
  type WorkspaceVantage,
} from "../scope-surface-eligibility";
import {
  resolveArtifactDisplayedLocus,
  selectScopeOwnedArtifacts,
  type ArtifactOwnershipLocus,
} from "../scope-surface-artifact-rows";

const ACTOR = "user-1";
const OTHER_USER = "user-2";
const ORG_A = "org-a";
const ORG_B = "org-b";
const ORG_OUTSIDE = "org-outside";
const TEAM_A = "team-a";
const TEAM_B = "team-b";
const TEAM_OUTSIDE = "team-outside";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_OUTSIDE = "project-outside";

/** As much of an `ArtifactSummary` as the ownership rules read. */
type Row = {
  artifactId: string;
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string | null;
  organizationId: string | null;
  projectId: string | null;
};

function row(artifactId: string, fields: Omit<Row, "artifactId">): Row {
  return { artifactId, ...fields };
}

// ── THE FIXTURE SET ────────────────────────────────────────────────────────
// One row per locus the five tabs must place, plus the shapes that must be
// placed NOWHERE.

/** Personal: the actor's own artifact, no project. */
const PERSONAL_ROW = row("art-personal", {
  ownerLevel: "user",
  ownerId: ACTOR,
  organizationId: ORG_A,
  projectId: null,
});

/** Another user's personal artifact — never on THIS actor's personal tab. */
const OTHER_PERSONAL_ROW = row("art-personal-other", {
  ownerLevel: "user",
  ownerId: OTHER_USER,
  organizationId: ORG_A,
  projectId: null,
});

/** Organization A's own artifact. */
const ORG_A_ROW = row("art-org-a", {
  ownerLevel: "organization",
  ownerId: ORG_A,
  organizationId: ORG_A,
  projectId: null,
});

/** Organization B's own artifact — the second member organization. */
const ORG_B_ROW = row("art-org-b", {
  ownerLevel: "organization",
  ownerId: ORG_B,
  organizationId: ORG_B,
  projectId: null,
});

/** Team A's artifact. */
const TEAM_A_ROW = row("art-team-a", {
  ownerLevel: "team",
  ownerId: TEAM_A,
  organizationId: ORG_A,
  projectId: null,
});

/** Project A's artifact — a pure project locus. */
const PROJECT_A_ROW = row("art-project-a", {
  ownerLevel: "user",
  ownerId: ACTOR,
  organizationId: ORG_A,
  projectId: PROJECT_A,
});

/**
 * THE MIXED-AXIS ROW: it carries BOTH a project id and a non-project owner
 * locus (`ownerLevel: "organization"`, owned by organization A).
 */
const MIXED_AXIS_ROW = row("art-mixed-axis", {
  ownerLevel: "organization",
  ownerId: ORG_A,
  organizationId: ORG_A,
  projectId: PROJECT_B,
});

/** The workspace tier: above every organization, no project. */
const WORKSPACE_TIER_ROW = row("art-workspace-tier", {
  ownerLevel: "workspace",
  ownerId: null,
  organizationId: null,
  projectId: null,
});

/** MALFORMED: a non-workspace level with a missing owner id. */
const MALFORMED_TEAM_ROW = row("art-malformed-team", {
  ownerLevel: "team",
  ownerId: null,
  organizationId: ORG_A,
  projectId: null,
});

/** MALFORMED: a non-workspace level whose owner id is blank rather than absent. */
const MALFORMED_BLANK_OWNER_ROW = row("art-malformed-blank", {
  ownerLevel: "organization",
  ownerId: "   ",
  organizationId: ORG_A,
  projectId: null,
});

/** FAIL CLOSED: a project locus that names no project. */
const EMPTY_PROJECT_ROW = row("art-empty-project", {
  ownerLevel: "organization",
  ownerId: ORG_A,
  organizationId: ORG_A,
  projectId: "",
});

/** FAIL CLOSED in the union: a project the vantage does not carry. */
const CROSS_ORG_PROJECT_ROW = row("art-cross-org-project", {
  ownerLevel: "organization",
  ownerId: ORG_OUTSIDE,
  organizationId: ORG_OUTSIDE,
  projectId: PROJECT_OUTSIDE,
});

/** FAIL CLOSED in the union: a team of an organization the vantage does not carry. */
const OUTSIDE_TEAM_ROW = row("art-outside-team", {
  ownerLevel: "team",
  ownerId: TEAM_OUTSIDE,
  organizationId: ORG_OUTSIDE,
  projectId: null,
});

const ALL_ROWS: readonly Row[] = [
  PERSONAL_ROW,
  OTHER_PERSONAL_ROW,
  ORG_A_ROW,
  ORG_B_ROW,
  TEAM_A_ROW,
  PROJECT_A_ROW,
  MIXED_AXIS_ROW,
  WORKSPACE_TIER_ROW,
  MALFORMED_TEAM_ROW,
  MALFORMED_BLANK_OWNER_ROW,
  EMPTY_PROJECT_ROW,
  CROSS_ORG_PROJECT_ROW,
  OUTSIDE_TEAM_ROW,
];

/**
 * The workspace vantage, built by #2808's exported builder. Two member
 * organizations; `ORG_OUTSIDE` is deliberately absent, so every locus inside it
 * is unauthorized here.
 */
async function vantage(): Promise<WorkspaceVantage> {
  return buildWorkspaceVantage(
    {
      readMemberOrganizations: async () => [{ orgId: ORG_A }, { orgId: ORG_B }],
      readVisibleTeams: async (_userId, orgId) =>
        orgId === ORG_A ? [TEAM_A] : [TEAM_B],
      readVisibleProjects: async (_userId, orgId) =>
        orgId === ORG_A ? [PROJECT_A, PROJECT_B] : [],
    },
    { userId: ACTOR },
  );
}

function idsFor(scope: ArtifactOwnershipLocus): string[] {
  return selectScopeOwnedArtifacts(ALL_ROWS, scope).map((r) => r.artifactId);
}

const PERSONAL: ArtifactOwnershipLocus = { kind: "personal", userId: ACTOR };
const ORGANIZATION: ArtifactOwnershipLocus = { kind: "organization", orgId: ORG_A };
const TEAM: ArtifactOwnershipLocus = { kind: "team", teamId: TEAM_A };
const PROJECT_B_TAB: ArtifactOwnershipLocus = { kind: "project", projectId: PROJECT_B };

describe("the five scopes each list exactly the rows they own", () => {
  it("the personal tab lists only the actor's own project-less artifacts", () => {
    expect(idsFor(PERSONAL)).toEqual([PERSONAL_ROW.artifactId]);
  });

  it("the organization tab lists only that organization's own artifacts", () => {
    expect(idsFor(ORGANIZATION)).toEqual([ORG_A_ROW.artifactId]);
  });

  it("the team tab lists only that team's artifacts, never another team's", () => {
    expect(idsFor(TEAM)).toEqual([TEAM_A_ROW.artifactId]);
  });

  it("the project tab lists only that project's artifacts", () => {
    expect(idsFor({ kind: "project", projectId: PROJECT_A })).toEqual([
      PROJECT_A_ROW.artifactId,
    ]);
  });

  it("the workspace tab lists the WorkspaceVantage union, workspace-tier row included", async () => {
    const ids = idsFor({ kind: "workspace", vantage: await vantage() });
    expect(ids).toEqual([
      PERSONAL_ROW.artifactId,
      ORG_A_ROW.artifactId,
      ORG_B_ROW.artifactId,
      TEAM_A_ROW.artifactId,
      PROJECT_A_ROW.artifactId,
      MIXED_AXIS_ROW.artifactId,
      WORKSPACE_TIER_ROW.artifactId,
    ]);
  });
});

describe("the workspace-tier row belongs to the workspace and to no narrower scope", () => {
  it("appears in the workspace union", async () => {
    expect(idsFor({ kind: "workspace", vantage: await vantage() })).toContain(
      WORKSPACE_TIER_ROW.artifactId,
    );
  });

  it("appears on none of the four concrete scope tabs", () => {
    for (const scope of [PERSONAL, ORGANIZATION, TEAM, PROJECT_B_TAB]) {
      expect(idsFor(scope)).not.toContain(WORKSPACE_TIER_ROW.artifactId);
    }
  });
});

describe("the artifact project classification rule: projectId is the EXCLUSIVE locus", () => {
  it("classifies a project-bearing row at its project, whatever its ownerLevel says", () => {
    expect(resolveArtifactDisplayedLocus(MIXED_AXIS_ROW)).toEqual({
      kind: "project",
      projectId: PROJECT_B,
    });
  });

  it("the MIXED-AXIS row appears exactly once, on the project tab", () => {
    expect(idsFor(PROJECT_B_TAB)).toEqual([MIXED_AXIS_ROW.artifactId]);
  });

  it("the MIXED-AXIS row is absent from the organization tab its ownerLevel names", () => {
    // Its `ownerLevel`/`ownerId` say organization A, and organization A's own
    // tab still does not list it: the project took precedence.
    expect(idsFor(ORGANIZATION)).not.toContain(MIXED_AXIS_ROW.artifactId);
  });

  it("the MIXED-AXIS row is absent from every other concrete scope tab", () => {
    for (const scope of [PERSONAL, ORGANIZATION, TEAM]) {
      expect(idsFor(scope)).not.toContain(MIXED_AXIS_ROW.artifactId);
    }
  });

  it("counts the MIXED-AXIS row exactly once across the four concrete tabs", () => {
    const appearances = [PERSONAL, ORGANIZATION, TEAM, PROJECT_B_TAB].flatMap((scope) =>
      idsFor(scope).filter((id) => id === MIXED_AXIS_ROW.artifactId),
    );
    expect(appearances).toHaveLength(1);
  });

  it("counts the MIXED-AXIS row exactly once inside the workspace union", async () => {
    // The union is the workspace's own single list, so the row is in it once —
    // reached through the project locus the rule bound it to.
    const ids = idsFor({ kind: "workspace", vantage: await vantage() });
    expect(ids.filter((id) => id === MIXED_AXIS_ROW.artifactId)).toHaveLength(1);
  });

  it("classifies a project-less row by its ownerLevel/ownerId", () => {
    expect(resolveArtifactDisplayedLocus(ORG_A_ROW)).toEqual({
      kind: "organization",
      ownerId: ORG_A,
    });
  });
});

describe("fail closed", () => {
  const everyScope = async (): Promise<ArtifactOwnershipLocus[]> => [
    PERSONAL,
    ORGANIZATION,
    TEAM,
    PROJECT_B_TAB,
    { kind: "project", projectId: PROJECT_A },
    { kind: "workspace", vantage: await vantage() },
  ];

  it("excludes a MALFORMED row (a non-workspace level with a missing owner id) from every reader, the union included", async () => {
    for (const scope of await everyScope()) {
      expect(idsFor(scope)).not.toContain(MALFORMED_TEAM_ROW.artifactId);
    }
    expect(resolveArtifactDisplayedLocus(MALFORMED_TEAM_ROW)).toBeNull();
  });

  it("excludes a non-workspace row whose owner id is blank rather than absent", async () => {
    for (const scope of await everyScope()) {
      expect(idsFor(scope)).not.toContain(MALFORMED_BLANK_OWNER_ROW.artifactId);
    }
  });

  it("excludes an EMPTY project id rather than falling back to the ownerLevel axis", async () => {
    for (const scope of await everyScope()) {
      expect(idsFor(scope)).not.toContain(EMPTY_PROJECT_ROW.artifactId);
    }
    // The fallback is what fail-closed forbids: its ownerLevel/ownerId name
    // organization A, and organization A's tab must still not list it.
    expect(idsFor(ORGANIZATION)).not.toContain(EMPTY_PROJECT_ROW.artifactId);
    expect(resolveArtifactDisplayedLocus(EMPTY_PROJECT_ROW)).toBeNull();
  });

  it("excludes a CROSS-ORG / unauthorized project id from the workspace union", async () => {
    expect(idsFor({ kind: "workspace", vantage: await vantage() })).not.toContain(
      CROSS_ORG_PROJECT_ROW.artifactId,
    );
  });

  it("excludes a team of an organization the vantage does not carry", async () => {
    expect(idsFor({ kind: "workspace", vantage: await vantage() })).not.toContain(
      OUTSIDE_TEAM_ROW.artifactId,
    );
  });

  it("lists nothing for a workspace read whose vantage carries no organization", async () => {
    const empty = await buildWorkspaceVantage(
      {
        readMemberOrganizations: async () => [],
        readVisibleTeams: async () => [],
        readVisibleProjects: async () => [],
      },
      { userId: ACTOR },
    );
    // The actor's own personal rows and the workspace tier still belong to the
    // workspace; every organization-bound locus is gone with the membership.
    expect(idsFor({ kind: "workspace", vantage: empty })).toEqual([
      PERSONAL_ROW.artifactId,
      WORKSPACE_TIER_ROW.artifactId,
    ]);
  });
});

describe("ownership is a source-level read, not the ?scope= filter", () => {
  it("the reader never imports @/lib/scope-filter as a value", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "scope-surface-artifact-rows.ts"),
      "utf8",
    );
    // A type-only import would be permissible; a VALUE import of the filter is
    // the thing the acceptance sentence forbids.
    const valueImport = /import\s+(?!type\b)[^;]*from\s+["']@\/lib\/scope-filter["']/;
    expect(valueImport.test(source)).toBe(false);
    expect(source).not.toContain("parseScopeFilterParam");
    expect(source).not.toContain("scopeSelectionMatchesAny");
  });
});

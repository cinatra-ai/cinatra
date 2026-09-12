/**
 * PER-SCOPE SKILL OWNERSHIP FIXTURES (cinatra#2810, per-scope surfaces S4).
 *
 * The acceptance items this file proves, verbatim:
 *
 *   "Per-scope ownership fixtures (each scope lists only its owned rows;
 *    workspace = the `WorkspaceVantage` union incl. workspace-tier rows;
 *    malformed missing-owner rows excluded everywhere)"
 *
 *   "Skills continue to use their native ownership tuple."
 *
 *   "a schema-valid workspace-tier row (`owner_scope='workspace'`, owner id
 *    NULL by CHECK) belongs to the workspace and appears in the workspace
 *    union; a MALFORMED row (a non-workspace level with a missing owner id) is
 *    fail-closed and excluded from every reader, the union included."
 *
 *   "ownership is read from the durable tuple; … Not the `?scope=` filter — a
 *    source-level read."
 *
 * The fixtures are catalog-shaped rows whose `(level, scope, ownerUserId)`
 * projection is exactly what the store writes for each `(owner_scope,
 * owner_id)` pair, so the DB CHECK's own vocabulary is what is under test:
 * `owner_id IS NULL` exactly when `owner_scope = 'workspace'`.
 *
 * The workspace arm builds its vantage through #2808's OWN exported builder
 * (`buildWorkspaceVantage`), consumed here exactly as that slice ships it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceVantage,
  type WorkspaceVantage,
} from "../scope-surface-eligibility";
import {
  resolveSkillOwnershipTuple,
  selectScopeOwnedSkills,
  type SkillOwnershipLocus,
} from "../scope-surface-skill-rows";

const ACTOR = "user-1";
const OTHER_USER = "user-2";
const ORG_A = "org-a";
const ORG_B = "org-b";
const ORG_OUTSIDE = "org-outside";
const TEAM_A = "team-a";
const TEAM_B = "team-b";
const TEAM_OUTSIDE = "team-outside";
const PROJECT_A = "project-a";
const PROJECT_OUTSIDE = "project-outside";

/** As much of an installed-skill manifest row as the ownership rules read. */
type Row = {
  id: string;
  level?: string | null;
  scope?: string | null;
  ownerUserId?: string | null;
};

/** ('personal', the actor) — the durable owner, which sharing never moves. */
const PERSONAL_ROW: Row = { id: "skill-personal", level: "personal", scope: "personal", ownerUserId: ACTOR };

/** ('personal', another user). */
const OTHER_PERSONAL_ROW: Row = {
  id: "skill-personal-other",
  level: "personal",
  scope: "personal",
  ownerUserId: OTHER_USER,
};

/**
 * A SHARED personal skill: `scope` has moved to an organization locus with the
 * access policy, and the durable owner has not moved with it.
 */
const SHARED_PERSONAL_ROW: Row = {
  id: "skill-personal-shared",
  level: "personal",
  scope: ORG_A,
  ownerUserId: ACTOR,
};

/** ('team', team A). */
const TEAM_A_ROW: Row = { id: "skill-team-a", level: "team", scope: TEAM_A };

/** ('organization', organization A). */
const ORG_A_ROW: Row = { id: "skill-org-a", level: "organization", scope: ORG_A };

/** ('organization', organization B) — the second member organization. */
const ORG_B_ROW: Row = { id: "skill-org-b", level: "organization", scope: ORG_B };

/** ('project', project A) — the NATIVE project locus, never a team proxy. */
const PROJECT_A_ROW: Row = { id: "skill-project-a", level: "project", scope: PROJECT_A };

/** ('workspace', NULL) — schema-valid workspace tier. */
const WORKSPACE_TIER_ROW: Row = { id: "skill-workspace", level: "workspace", scope: "workspace" };

/** An agent-bundled skill: the store writes it ('workspace', NULL) too. */
const AGENT_ROW: Row = { id: "skill-agent", level: "agent", scope: "workspace" };

/** MALFORMED: a non-workspace level with a missing owner id. */
const MALFORMED_TEAM_ROW: Row = { id: "skill-malformed-team", level: "team", scope: null };

/** MALFORMED: the level's own word on `scope` is not an owner id. */
const MALFORMED_LEVEL_WORD_ROW: Row = { id: "skill-malformed-word", level: "team", scope: "team" };

/** MALFORMED: the generic `"org"` locus carries no id. */
const MALFORMED_GENERIC_ORG_ROW: Row = { id: "skill-malformed-org", level: "organization", scope: "org" };

/** MALFORMED: a personal row with no durable owner. */
const MALFORMED_PERSONAL_ROW: Row = { id: "skill-malformed-personal", level: "personal", scope: "personal" };

/**
 * MALFORMED, the CHECK's other direction: a workspace-tier row that
 * nonetheless names a concrete owner locus.
 */
const MALFORMED_WORKSPACE_WITH_OWNER_ROW: Row = {
  id: "skill-malformed-workspace",
  level: "workspace",
  scope: ORG_A,
};

/** FAIL CLOSED in the union: loci of an organization the vantage does not carry. */
const OUTSIDE_ORG_ROW: Row = { id: "skill-outside-org", level: "organization", scope: ORG_OUTSIDE };
const OUTSIDE_TEAM_ROW: Row = { id: "skill-outside-team", level: "team", scope: TEAM_OUTSIDE };
const OUTSIDE_PROJECT_ROW: Row = {
  id: "skill-outside-project",
  level: "project",
  scope: PROJECT_OUTSIDE,
};

const ALL_ROWS: readonly Row[] = [
  PERSONAL_ROW,
  OTHER_PERSONAL_ROW,
  SHARED_PERSONAL_ROW,
  TEAM_A_ROW,
  ORG_A_ROW,
  ORG_B_ROW,
  PROJECT_A_ROW,
  WORKSPACE_TIER_ROW,
  AGENT_ROW,
  MALFORMED_TEAM_ROW,
  MALFORMED_LEVEL_WORD_ROW,
  MALFORMED_GENERIC_ORG_ROW,
  MALFORMED_PERSONAL_ROW,
  MALFORMED_WORKSPACE_WITH_OWNER_ROW,
  OUTSIDE_ORG_ROW,
  OUTSIDE_TEAM_ROW,
  OUTSIDE_PROJECT_ROW,
];

async function vantage(): Promise<WorkspaceVantage> {
  return buildWorkspaceVantage(
    {
      readMemberOrganizations: async () => [{ orgId: ORG_A }, { orgId: ORG_B }],
      readVisibleTeams: async (_userId, orgId) => (orgId === ORG_A ? [TEAM_A] : [TEAM_B]),
      readVisibleProjects: async (_userId, orgId) => (orgId === ORG_A ? [PROJECT_A] : []),
    },
    { userId: ACTOR },
  );
}

function idsFor(scope: SkillOwnershipLocus): string[] {
  return selectScopeOwnedSkills(ALL_ROWS, scope).map((r) => r.id);
}

const PERSONAL: SkillOwnershipLocus = { kind: "personal", userId: ACTOR };
const ORGANIZATION: SkillOwnershipLocus = { kind: "organization", orgId: ORG_A };
const TEAM: SkillOwnershipLocus = { kind: "team", teamId: TEAM_A };
const PROJECT: SkillOwnershipLocus = { kind: "project", projectId: PROJECT_A };

describe("the five scopes each list exactly the skills they own", () => {
  it("the personal tab lists the actor's own skills, a shared one included", () => {
    // The shared row's projected `scope` names an organization; its DURABLE
    // owner is still the actor, so it stays on the actor's own tab.
    expect(idsFor(PERSONAL)).toEqual([PERSONAL_ROW.id, SHARED_PERSONAL_ROW.id]);
  });

  it("the organization tab lists only that organization's own skills", () => {
    // The shared PERSONAL row projects onto organization A and is still NOT
    // organization A's skill: the durable tuple decides, not the projection.
    expect(idsFor(ORGANIZATION)).toEqual([ORG_A_ROW.id]);
  });

  it("the team tab lists only that team's skills", () => {
    expect(idsFor(TEAM)).toEqual([TEAM_A_ROW.id]);
  });

  it("the project tab lists the project's own skills through the NATIVE project locus", () => {
    expect(idsFor(PROJECT)).toEqual([PROJECT_A_ROW.id]);
  });

  it("a project-level skill never surfaces on a team tab as a legacy proxy", () => {
    for (const teamId of [TEAM_A, TEAM_B]) {
      expect(idsFor({ kind: "team", teamId })).not.toContain(PROJECT_A_ROW.id);
    }
  });

  it("the workspace tab lists the WorkspaceVantage union, workspace-tier rows included", async () => {
    expect(idsFor({ kind: "workspace", vantage: await vantage() })).toEqual([
      PERSONAL_ROW.id,
      SHARED_PERSONAL_ROW.id,
      TEAM_A_ROW.id,
      ORG_A_ROW.id,
      ORG_B_ROW.id,
      PROJECT_A_ROW.id,
      WORKSPACE_TIER_ROW.id,
      AGENT_ROW.id,
    ]);
  });
});

describe("the native tuple is derived exactly as the store wrote it", () => {
  it("reads a personal row's DURABLE owner, not its projected scope", () => {
    expect(resolveSkillOwnershipTuple(SHARED_PERSONAL_ROW)).toEqual({
      ownerScope: "personal",
      ownerId: ACTOR,
    });
  });

  it("reads a project row at the project locus", () => {
    expect(resolveSkillOwnershipTuple(PROJECT_A_ROW)).toEqual({
      ownerScope: "project",
      ownerId: PROJECT_A,
    });
  });

  it("reads a workspace-tier row as ('workspace', NULL)", () => {
    expect(resolveSkillOwnershipTuple(WORKSPACE_TIER_ROW)).toEqual({
      ownerScope: "workspace",
      ownerId: null,
    });
  });

  it("reads an agent-bundled row as the workspace tier the store writes", () => {
    expect(resolveSkillOwnershipTuple(AGENT_ROW)).toEqual({
      ownerScope: "workspace",
      ownerId: null,
    });
  });
});

describe("the workspace-tier rows belong to the workspace and to no narrower scope", () => {
  it("appear in the workspace union", async () => {
    const ids = idsFor({ kind: "workspace", vantage: await vantage() });
    expect(ids).toContain(WORKSPACE_TIER_ROW.id);
    expect(ids).toContain(AGENT_ROW.id);
  });

  it("appear on none of the four concrete scope tabs", () => {
    for (const scope of [PERSONAL, ORGANIZATION, TEAM, PROJECT]) {
      expect(idsFor(scope)).not.toContain(WORKSPACE_TIER_ROW.id);
      expect(idsFor(scope)).not.toContain(AGENT_ROW.id);
    }
  });
});

describe("fail closed", () => {
  const everyScope = async (): Promise<SkillOwnershipLocus[]> => [
    PERSONAL,
    ORGANIZATION,
    TEAM,
    PROJECT,
    { kind: "workspace", vantage: await vantage() },
  ];

  const refused: readonly Row[] = [
    MALFORMED_TEAM_ROW,
    MALFORMED_LEVEL_WORD_ROW,
    MALFORMED_GENERIC_ORG_ROW,
    MALFORMED_PERSONAL_ROW,
    MALFORMED_WORKSPACE_WITH_OWNER_ROW,
  ];

  it("resolves no tuple at all for a malformed row", () => {
    for (const row of refused) {
      expect(resolveSkillOwnershipTuple(row)).toBeNull();
    }
  });

  it("excludes every malformed row from every reader, the union included", async () => {
    for (const scope of await everyScope()) {
      const ids = idsFor(scope);
      for (const row of refused) {
        expect(ids).not.toContain(row.id);
      }
    }
  });

  it("excludes loci of an organization the vantage does not carry", async () => {
    const ids = idsFor({ kind: "workspace", vantage: await vantage() });
    for (const row of [OUTSIDE_ORG_ROW, OUTSIDE_TEAM_ROW, OUTSIDE_PROJECT_ROW]) {
      expect(ids).not.toContain(row.id);
    }
  });

  it("keeps the actor's own skills and the workspace tier when the vantage carries no organization", async () => {
    const empty = await buildWorkspaceVantage(
      {
        readMemberOrganizations: async () => [],
        readVisibleTeams: async () => [],
        readVisibleProjects: async () => [],
      },
      { userId: ACTOR },
    );
    expect(idsFor({ kind: "workspace", vantage: empty })).toEqual([
      PERSONAL_ROW.id,
      SHARED_PERSONAL_ROW.id,
      WORKSPACE_TIER_ROW.id,
      AGENT_ROW.id,
    ]);
  });
});

describe("ownership is a source-level read, not the ?scope= filter", () => {
  it("the reader never imports @/lib/scope-filter as a value", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "scope-surface-skill-rows.ts"),
      "utf8",
    );
    const valueImport = /import\s+(?!type\b)[^;]*from\s+["']@\/lib\/scope-filter["']/;
    expect(valueImport.test(source)).toBe(false);
    expect(source).not.toContain("parseScopeFilterParam");
    expect(source).not.toContain("scopeSelectionMatchesAny");
  });
});

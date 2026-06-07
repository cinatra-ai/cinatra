/**
 * Parity test: buildInstallTargets's per-row disabled decision MUST match
 * the assertCanInstallAtTarget rule grid that lives in
 * packages/agents/src/actions.ts.
 *
 * Rules (mirrored from actions.ts:assertCanInstallAtTarget):
 *  - org:           platform_admin OR org_admin OR org_owner => enabled
 *  - team:<id>:     platform_admin OR actor.teamRoles[id] === "team_admin" => enabled
 *  - project:<id>:  platform_admin OR actor in ownerUserIds OR
 *                   actor.teamRoles[owningTeamId] === "team_admin" => enabled
 *
 * Each test row is a triple (actor, target, expectedEnabled).
 *
 * NOTE: Production today does NOT load `actor.teamRoles` (Better Auth's
 * teamMember table has no role column). The picker MUST default to org-target
 * only, and team/project-target rows MUST be disabled for users without
 * platform_admin. The team_admin grants exercised here come from the matrix
 * tests' mocked actor. Production actors arrive with `teamRoles === undefined`,
 * so production team rows will be DISABLED until role loading is implemented.
 */
import { describe, it, expect } from "vitest";
import { buildInstallTargets } from "../install-targets";

const ACTIVE_ORG = "org-1";
const ORG_NAME = "Acme";

const ALICE = "user-alice";
const BOB = "user-bob";

const TEAM_ENG = { id: "team-eng", name: "Engineering" };
const TEAM_OPS = { id: "team-ops", name: "Operations" };

const PROJ_Q1 = {
  id: "proj-q1",
  name: "Q1 Launch",
  ownerUserIds: [ALICE],
  owningTeamId: null,
};

const PROJ_TEAM = {
  id: "proj-team",
  name: "Team Project",
  ownerUserIds: [],
  owningTeamId: TEAM_ENG.id,
};

describe("buildInstallTargets parity with assertCanInstallAtTarget", () => {
  it("M1 (platform_admin): all 4 rows enabled", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        platformRole: "platform_admin",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG, TEAM_OPS],
      projects: [PROJ_Q1, PROJ_TEAM],
    });
    expect(targets.find((t) => t.value === "org")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "team:team-eng")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "team:team-ops")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "project:proj-q1")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "project:proj-team")?.disabled).toBe(false);
  });

  it("M2 (org_admin without team_admin): org enabled, all team/project rows disabled (parity with M5)", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        orgRole: "org_admin",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG],
      projects: [PROJ_TEAM],
    });
    expect(targets.find((t) => t.value === "org")?.disabled).toBe(false);
    // M5 contract: org_admin x team-target => DENY unless also team_admin of THAT team
    expect(targets.find((t) => t.value === "team:team-eng")?.disabled).toBe(true);
    // PROJ_TEAM is team-owned (Eng), and alice is NOT team_admin of Eng.
    expect(targets.find((t) => t.value === "project:proj-team")?.disabled).toBe(true);
  });

  it("M3 (org_owner): org enabled, team/project rows disabled (no team_admin)", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        orgRole: "org_owner",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG],
      projects: [],
    });
    expect(targets.find((t) => t.value === "org")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "team:team-eng")?.disabled).toBe(true);
  });

  it("M4 (member): org disabled, team/project rows disabled", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        orgRole: "member",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG],
      projects: [],
    });
    expect(targets.find((t) => t.value === "org")?.disabled).toBe(true);
    expect(targets.find((t) => t.value === "team:team-eng")?.disabled).toBe(true);
  });

  it("M5 (team_admin only): org disabled, target team enabled, OTHER team disabled", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        orgRole: "member",
        teamRoles: { [TEAM_ENG.id]: "team_admin" },
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG, TEAM_OPS],
      projects: [PROJ_TEAM],
    });
    expect(targets.find((t) => t.value === "org")?.disabled).toBe(true);
    expect(targets.find((t) => t.value === "team:team-eng")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "team:team-ops")?.disabled).toBe(true);
    // PROJ_TEAM is team-owned (Eng), and alice is team_admin of Eng, so it is enabled.
    expect(targets.find((t) => t.value === "project:proj-team")?.disabled).toBe(false);
  });

  it("M6 (project owner): org disabled, project enabled, team disabled", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE, // owner of PROJ_Q1
        organizationId: ACTIVE_ORG,
        orgRole: "member",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG],
      projects: [PROJ_Q1],
    });
    expect(targets.find((t) => t.value === "project:proj-q1")?.disabled).toBe(false);
    expect(targets.find((t) => t.value === "team:team-eng")?.disabled).toBe(true);
    expect(targets.find((t) => t.value === "org")?.disabled).toBe(true);
  });

  it("M7 (non-owner non-team-admin): project disabled", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: BOB,
        organizationId: ACTIVE_ORG,
        orgRole: "member",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [],
      projects: [PROJ_Q1],
    });
    expect(targets.find((t) => t.value === "project:proj-q1")?.disabled).toBe(true);
  });

  it("disabled rows carry a non-empty reason string", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        orgRole: "member",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG],
      projects: [PROJ_TEAM],
    });
    for (const t of targets) {
      if (t.disabled) {
        expect(typeof t.reason).toBe("string");
        expect((t.reason ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("each row carries label, level, id consistent with value", () => {
    const targets = buildInstallTargets({
      actor: {
        principalId: ALICE,
        organizationId: ACTIVE_ORG,
        platformRole: "platform_admin",
      },
      activeOrgId: ACTIVE_ORG,
      orgName: ORG_NAME,
      teams: [TEAM_ENG],
      projects: [PROJ_Q1],
    });
    const orgRow = targets.find((t) => t.value === "org");
    expect(orgRow?.level).toBe("organization");
    expect(orgRow?.id).toBe(ACTIVE_ORG);
    const teamRow = targets.find((t) => t.value === "team:team-eng");
    expect(teamRow?.level).toBe("team");
    expect(teamRow?.id).toBe("team-eng");
    const projRow = targets.find((t) => t.value === "project:proj-q1");
    expect(projRow?.level).toBe("project");
    expect(projRow?.id).toBe("proj-q1");
  });
});

describe("pickDefaultPickerValue", () => {
  it("returns null when no enabled targets exist", async () => {
    const { pickDefaultPickerValue } = await import("../install-targets");
    expect(pickDefaultPickerValue([], undefined)).toBeNull();
    expect(
      pickDefaultPickerValue(
        [
          {
            value: "org",
            label: "Acme",
            level: "organization",
            id: ACTIVE_ORG,
            disabled: true,
            reason: "no",
          },
        ],
        undefined,
      ),
    ).toBeNull();
  });

  it("prefers the project row when currentProjectId matches and is enabled", async () => {
    const { pickDefaultPickerValue } = await import("../install-targets");
    const targets = [
      { value: "org", label: "Acme", level: "organization" as const, id: ACTIVE_ORG, disabled: false },
      { value: "team:team-eng", label: "Engineering", level: "team" as const, id: "team-eng", disabled: false },
      { value: "project:proj-q1", label: "Q1 Launch", level: "project" as const, id: "proj-q1", disabled: false },
    ];
    expect(pickDefaultPickerValue(targets, "proj-q1")).toBe("project:proj-q1");
  });

  it("falls back to first enabled team when project row is disabled or absent", async () => {
    const { pickDefaultPickerValue } = await import("../install-targets");
    const targets = [
      { value: "org", label: "Acme", level: "organization" as const, id: ACTIVE_ORG, disabled: false },
      { value: "team:team-eng", label: "Engineering", level: "team" as const, id: "team-eng", disabled: false },
    ];
    expect(pickDefaultPickerValue(targets, undefined)).toBe("team:team-eng");
  });

  it("falls back to org when no team is enabled", async () => {
    const { pickDefaultPickerValue } = await import("../install-targets");
    const targets = [
      { value: "org", label: "Acme", level: "organization" as const, id: ACTIVE_ORG, disabled: false },
      { value: "team:team-eng", label: "Engineering", level: "team" as const, id: "team-eng", disabled: true, reason: "x" },
    ];
    expect(pickDefaultPickerValue(targets, undefined)).toBe("org");
  });
});

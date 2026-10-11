// The EFFECTIVE-5 CHAIN fixtures (cinatra#2815 S3, epic #2812).
//
// Acceptance item: "Effective-5 chain proof. Scope-chain selection uses a valid
// V1 snapshot EXCLUSIVELY; for an absent, malformed, or unknown-version
// snapshot the sole legacy fallback is workspace + the instance's durable
// organization — project, user, and team layers are forbidden in fallback."
import { describe, it, expect } from "vitest";

import {
  EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP,
  EFFECTIVE_ASSIGNMENT_SCOPE_CHAIN,
  resolveEffectiveAssignedSkills,
  selectEffectiveAssignedSkills,
  type AssignedSkillScopeRow,
} from "../effective-assigned-skills";
import {
  buildAssignmentScopeSnapshot,
  serializeAssignmentScopeSnapshot,
} from "../assignment-scope-snapshot";

const ORG = "org_1";
const PROJECT = "proj_1";
const USER = "user_1";
const TEAM_A = "team_aaa";
const TEAM_B = "team_bbb";

function row(
  skillId: string,
  scopeKind: string,
  scopeId: string,
  position = 0,
): AssignedSkillScopeRow {
  return { skillId, scopeKind, scopeId, position };
}

const FULL_SNAPSHOT = buildAssignmentScopeSnapshot({
  orgId: ORG,
  projectId: PROJECT,
  teamIds: [TEAM_B, TEAM_A],
  originatingHumanUserId: USER,
});

describe("the chain order IS the priority", () => {
  it("walks project -> user -> team(s) -> organization -> workspace", () => {
    const out = selectEffectiveAssignedSkills(
      [
        row("s-workspace", "workspace", "__workspace__"),
        row("s-org", "organization", ORG),
        row("s-team-b", "team", TEAM_B),
        row("s-team-a", "team", TEAM_A),
        row("s-user", "user", USER),
        row("s-project", "project", PROJECT),
      ],
      FULL_SNAPSHOT,
    );
    expect(out.skillIds).toEqual([
      "s-project",
      "s-user",
      "s-team-a",
      "s-team-b",
      "s-org",
    ]);
    expect(out.picks.map((p) => p.layer)).toEqual([
      "project",
      "user",
      "team",
      "team",
      "organization",
    ]);
    // The workspace row is the SIXTH distinct id — the per-run cap refuses it.
    expect(out.droppedOverCap).toEqual(["s-workspace"]);
    expect(EFFECTIVE_ASSIGNMENT_SCOPE_CHAIN).toEqual([
      "project",
      "user",
      "team",
      "organization",
      "workspace",
    ]);
  });

  it("caps the run at five DISTINCT skills", () => {
    expect(EFFECTIVE_ASSIGNED_SKILLS_PER_RUN_CAP).toBe(5);
    const out = selectEffectiveAssignedSkills(
      [1, 2, 3, 4, 5, 6, 7].map((n) => row(`s${n}`, "project", PROJECT, n)),
      FULL_SNAPSHOT,
    );
    expect(out.skillIds).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(out.droppedOverCap).toEqual(["s6", "s7"]);
  });

  it("first-seen wins: one skill assigned at two scopes takes ONE slot, at its narrowest", () => {
    const out = selectEffectiveAssignedSkills(
      [row("shared", "workspace", "__workspace__"), row("shared", "project", PROJECT)],
      FULL_SNAPSHOT,
    );
    expect(out.skillIds).toEqual(["shared"]);
    expect(out.picks).toEqual([{ skillId: "shared", layer: "project", scopeId: PROJECT }]);
  });

  it("two teams are ordered by ASCENDING team id — a total, reproducible tie-break", () => {
    const out = selectEffectiveAssignedSkills(
      [row("from-b", "team", TEAM_B), row("from-a", "team", TEAM_A)],
      buildAssignmentScopeSnapshot({ orgId: ORG, teamIds: [TEAM_B, TEAM_A] }),
    );
    expect(out.skillIds).toEqual(["from-a", "from-b"]);
  });

  it("within one exact scope the stored position decides", () => {
    const out = selectEffectiveAssignedSkills(
      [row("second", "project", PROJECT, 2), row("first", "project", PROJECT, 1)],
      FULL_SNAPSHOT,
    );
    expect(out.skillIds).toEqual(["first", "second"]);
  });
});

describe("scope comes from the snapshot, exclusively", () => {
  it("a row at a project the snapshot does not name is NOT delivered", () => {
    const out = selectEffectiveAssignedSkills(
      [row("other-project", "project", "proj_other"), row("mine", "project", PROJECT)],
      FULL_SNAPSHOT,
    );
    expect(out.skillIds).toEqual(["mine"]);
  });

  it("a headless run (no originating human) receives NO user layer", () => {
    const headless = buildAssignmentScopeSnapshot({ orgId: ORG, projectId: PROJECT });
    const out = selectEffectiveAssignedSkills(
      [row("personal", "user", USER), row("org", "organization", ORG)],
      headless,
    );
    expect(out.skillIds).toEqual(["org"]);
  });

  it("a row with no scope tuple is a WORKSPACE row (package-global == workspace)", () => {
    const out = selectEffectiveAssignedSkills(
      [{ skillId: "legacy" }],
      buildAssignmentScopeSnapshot({ orgId: ORG }),
    );
    expect(out.picks).toEqual([{ skillId: "legacy", layer: "workspace", scopeId: "" }]);
  });

  it("a scope kind this build cannot place is DROPPED, never widened", () => {
    const out = selectEffectiveAssignedSkills(
      [{ skillId: "weird", scopeKind: "galaxy", scopeId: "g1" }],
      FULL_SNAPSHOT,
    );
    expect(out.skillIds).toEqual([]);
    expect(out.unplaceableScopeKinds).toEqual(["galaxy"]);
  });
});

describe("the SOLE legacy fallback: workspace + the durable organization", () => {
  const ROWS: AssignedSkillScopeRow[] = [
    row("s-project", "project", PROJECT),
    row("s-user", "user", USER),
    row("s-team", "team", TEAM_A),
    row("s-org", "organization", ORG),
    row("s-workspace", "workspace", "__workspace__"),
  ];

  const unusable: Array<[string, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["malformed text", "{not json"],
    ["a shape that is not a snapshot", { hello: "world" }],
    ["an unknown version", { v: 99, orgId: ORG, teamIds: [] }],
    ["a present-but-wrong optional layer", { v: 1, orgId: ORG, teamIds: [], projectId: {} }],
  ];

  for (const [label, payload] of unusable) {
    it(`${label} => workspace + organization ONLY, and project/user/team NEVER appear`, () => {
      const out = resolveEffectiveAssignedSkills(ROWS, {
        snapshot: payload,
        durableOrgId: ORG,
      });
      expect(out.usedFallback).toBe(true);
      expect(out.fallbackDegraded).toBeNull();
      expect(out.skillIds).toEqual(["s-org", "s-workspace"]);
      expect(out.picks.map((p) => p.layer)).toEqual(["organization", "workspace"]);
      expect(out.skillIds).not.toContain("s-project");
      expect(out.skillIds).not.toContain("s-user");
      expect(out.skillIds).not.toContain("s-team");
    });
  }

  it("a VALID snapshot is used exclusively — never merged with the fallback", () => {
    const out = resolveEffectiveAssignedSkills(ROWS, {
      snapshot: serializeAssignmentScopeSnapshot(FULL_SNAPSHOT),
      durableOrgId: "org_somewhere_else",
    });
    expect(out.usedFallback).toBe(false);
    expect(out.skillIds).toEqual(["s-project", "s-user", "s-team", "s-org", "s-workspace"]);
  });

  it("no usable snapshot AND no durable organization => the WORKSPACE layer alone, reported", () => {
    const out = resolveEffectiveAssignedSkills(ROWS, { snapshot: null, durableOrgId: null });
    expect(out.usedFallback).toBe(true);
    expect(out.fallbackDegraded).toBe("no-durable-organization");
    expect(out.skillIds).toEqual(["s-workspace"]);
  });

  it("an organization row for ANOTHER organization is not delivered under the fallback", () => {
    const out = resolveEffectiveAssignedSkills(
      [row("foreign", "organization", "org_other")],
      { snapshot: null, durableOrgId: ORG },
    );
    expect(out.skillIds).toEqual([]);
  });
});

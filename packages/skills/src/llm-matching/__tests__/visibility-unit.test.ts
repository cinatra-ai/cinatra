/**
 * Unit tests for the visibility predicate exposed via `filterMatchRowsByVisibility`.
 *
 * Coverage targets:
 *  - agent / system / third-party rows pass through unchanged
 *  - personal level: only owner === actor.userId is kept
 *  - team level: only rows owned by a team in actor.teamIds are kept
 *  - organization level: only owner === actor.orgId is kept
 *  - workspace level: rows are kept for actors with workspace-user context
 *  - workspace level: rows are denied for actors without organization context
 *  - project level: only rows owned by a project in actor.projectIds are kept
 *  - platform_admin short-circuit returns all rows untouched
 *  - rows referencing skills no longer in the live catalog are filtered
 */

import { describe, it, expect } from "vitest";
import {
  filterMatchRowsByVisibility,
  type VisibilityActor,
  type VisibilitySkillMeta,
} from "../visibility";
import type { SkillMatchRow } from "../types";

function makeRow(agentId: string, skillId: string): SkillMatchRow {
  const now = new Date("2026-05-11T00:00:00Z");
  return {
    agentId,
    skillId,
    source: "llm",
    matched: true,
    score: 0.9,
    rationale: "test",
    evaluatorVersion: "llm-matcher-v1",
    agentInputHash: "a".repeat(64),
    skillInputHash: "b".repeat(64),
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: now,
    jobStartedAt: now,
  };
}

const baseActor: VisibilityActor = {
  userId: "user-1",
  teamIds: ["team-A"],
  projectIds: ["project-X"],
  orgId: "org-1",
  platformRole: "member",
};

describe("filterMatchRowsByVisibility visibility predicate", () => {
  it("agent / system / third-party rows pass through unchanged", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-agent"),
      makeRow("@cinatra/email", "skill-system"),
      makeRow("@cinatra/email", "skill-third-party"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-agent", { level: "agent", agentId: "@cinatra/email" }],
      ["skill-system", { level: "system" }],
      ["skill-third-party", { level: "system" }],
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result).toHaveLength(3);
  });

  it("personal level keeps only owner === actor.userId", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-mine"),
      makeRow("@cinatra/email", "skill-other"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-mine", { level: "personal", scope: "user-1" }],
      ["skill-other", { level: "personal", scope: "user-2" }],
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result.map((r) => r.skillId)).toEqual(["skill-mine"]);
  });

  it("team level keeps only rows owned by a team in actor.teamIds", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-team-A"),
      makeRow("@cinatra/email", "skill-team-B"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-team-A", { level: "team", scope: "team-A" }],
      ["skill-team-B", { level: "team", scope: "team-B" }],
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result.map((r) => r.skillId)).toEqual(["skill-team-A"]);
  });

  it("organization level keeps only owner === actor.orgId", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-org-1"),
      makeRow("@cinatra/email", "skill-org-2"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-org-1", { level: "organization", scope: "org-1" }],
      ["skill-org-2", { level: "organization", scope: "org-2" }],
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result.map((r) => r.skillId)).toEqual(["skill-org-1"]);
  });

  // Workspace-tier skills are available to workspace users. Requiring both
  // userId and orgId ties workspace visibility to an authenticated actor in
  // an organization.
  it("workspace level is kept for all workspace users with userId and orgId", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-workspace-1"),
      makeRow("@cinatra/email", "skill-workspace-2"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-workspace-1", { level: "workspace", scope: "workspace-1" }],
      ["skill-workspace-2", { level: "workspace" }],
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result.map((r) => r.skillId).sort()).toEqual(["skill-workspace-1", "skill-workspace-2"]);
  });

  // An org-less or identity-less actor must not match workspace rows wholesale.
  // Without the org-context guard, the workspace tier could become a cross-org
  // skill enumeration surface.
  it("workspace rows are denied for org-less actors", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-workspace-1"),
      makeRow("@cinatra/email", "skill-workspace-2"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-workspace-1", { level: "workspace", scope: "workspace-1" }],
      ["skill-workspace-2", { level: "workspace" }],
    ]);
    const orglessActor: VisibilityActor = {
      userId: "user-1",
      teamIds: [],
      projectIds: [],
      // intentionally no orgId
      platformRole: "member",
    };
    const result = filterMatchRowsByVisibility(rows, skills, orglessActor);
    expect(result).toEqual([]);
  });

  it("project level keeps only rows owned by a project in actor.projectIds", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-project-X"),
      makeRow("@cinatra/email", "skill-project-Y"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-project-X", { level: "project", scope: "project-X" }],
      ["skill-project-Y", { level: "project", scope: "project-Y" }],
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result.map((r) => r.skillId)).toEqual(["skill-project-X"]);
  });

  it("platform_admin short-circuits and keeps all rows untouched, including workspace rows", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-personal-other"),
      makeRow("@cinatra/email", "skill-team-other"),
      makeRow("@cinatra/email", "skill-org-other"),
      makeRow("@cinatra/email", "skill-workspace"),
      makeRow("@cinatra/email", "skill-project-other"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-personal-other", { level: "personal", scope: "user-2" }],
      ["skill-team-other", { level: "team", scope: "team-Z" }],
      ["skill-org-other", { level: "organization", scope: "org-2" }],
      ["skill-workspace", { level: "workspace" }],
      ["skill-project-other", { level: "project", scope: "project-Z" }],
    ]);
    const adminActor: VisibilityActor = { ...baseActor, platformRole: "platform_admin" };
    const result = filterMatchRowsByVisibility(rows, skills, adminActor);
    expect(result).toHaveLength(5);
  });

  it("rows referencing skills no longer in the live catalog are filtered", () => {
    const rows = [
      makeRow("@cinatra/email", "skill-still-installed"),
      makeRow("@cinatra/email", "skill-uninstalled"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-still-installed", { level: "system" }],
      // skill-uninstalled intentionally absent
    ]);
    const result = filterMatchRowsByVisibility(rows, skills, baseActor);
    expect(result.map((r) => r.skillId)).toEqual(["skill-still-installed"]);
  });
});

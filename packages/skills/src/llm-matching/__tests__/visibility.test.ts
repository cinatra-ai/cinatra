/**
 * Visibility filter integration regression coverage.
 *
 * The unit tests already cover canonical per-level scoping and admin bypass.
 * This file adds:
 *  - Cross-cutting actor-shape edge cases that exercise the filter at the
 *    integration boundary (missing actor identity fields, mixed-level batch).
 *  - Reader-side composition — what happens when the filter sees rows
 *    spanning every level in one call (the actual production shape).
 *
 * Coverage targets:
 *  - Positive personal scope match for actor A; same row hidden from actor B.
 *  - Positive team scope match for actor with multiple teamIds; out-of-team
 *    row hidden.
 *  - Positive organization scope match; row in different org is hidden.
 *  - Positive project scope match for actor with multiple projectIds;
 *    out-of-project row hidden.
 *  - Workspace-level row hidden for non-admin actor regardless of any
 *    scope-vs-actor match.
 *  - platform_admin sees all rows in a mixed-level batch (all five scoped
 *    levels + agent + system + third-party + uninstalled).
 *  - Actor with no identity fields populated (no userId, no teamIds, no
 *    orgId, no projectIds, role=member) sees zero scoped-level rows but still
 *    sees agent/system/third-party rows.
 *  - Filter is pure: calling it twice with the same inputs returns equal
 *    arrays and does not depend on internal state.
 */

import { describe, it, expect } from "vitest";
import {
  filterMatchRowsByVisibility,
  type VisibilityActor,
  type VisibilitySkillMeta,
} from "../visibility";
import type { SkillMatchRow } from "../types";

const NOW = new Date("2026-05-11T15:00:00Z");

function row(skillId: string): SkillMatchRow {
  return {
    agentId: "@cinatra/email-agent",
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
    evaluatedAt: NOW,
    jobStartedAt: NOW,
  };
}

describe("filterMatchRowsByVisibility integration regression", () => {
  it("personal scope match is visible to the owner and hidden from a different user", () => {
    const rows = [row("skill-personal-A")];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-personal-A", { level: "personal", scope: "user-A" }],
    ]);
    const owner: VisibilityActor = {
      userId: "user-A",
      teamIds: [],
      projectIds: [],
      platformRole: "member",
    };
    const other: VisibilityActor = {
      userId: "user-B",
      teamIds: [],
      projectIds: [],
      platformRole: "member",
    };

    expect(filterMatchRowsByVisibility(rows, skills, owner)).toHaveLength(1);
    expect(filterMatchRowsByVisibility(rows, skills, other)).toHaveLength(0);
  });

  it("actor with multiple teamIds sees rows for any of them; out-of-team rows hidden", () => {
    const rows = [
      row("skill-team-X"),
      row("skill-team-Y"),
      row("skill-team-Z"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-team-X", { level: "team", scope: "team-X" }],
      ["skill-team-Y", { level: "team", scope: "team-Y" }],
      ["skill-team-Z", { level: "team", scope: "team-Z" }],
    ]);
    const actor: VisibilityActor = {
      teamIds: ["team-X", "team-Y"],
      projectIds: [],
      platformRole: "member",
    };

    const visible = filterMatchRowsByVisibility(rows, skills, actor).map((r) => r.skillId);
    expect(visible.sort()).toEqual(["skill-team-X", "skill-team-Y"]);
  });

  it("organization scope keeps only the matching organization", () => {
    const rows = [row("skill-org-1"), row("skill-org-2")];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-org-1", { level: "organization", scope: "org-1" }],
      ["skill-org-2", { level: "organization", scope: "org-2" }],
    ]);
    const actor: VisibilityActor = {
      orgId: "org-1",
      teamIds: [],
      projectIds: [],
      platformRole: "member",
    };
    const visible = filterMatchRowsByVisibility(rows, skills, actor).map((r) => r.skillId);
    expect(visible).toEqual(["skill-org-1"]);
  });

  it("actor with multiple projectIds sees rows for any of them", () => {
    const rows = [
      row("skill-project-A"),
      row("skill-project-B"),
      row("skill-project-C"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-project-A", { level: "project", scope: "project-A" }],
      ["skill-project-B", { level: "project", scope: "project-B" }],
      ["skill-project-C", { level: "project", scope: "project-C" }],
    ]);
    const actor: VisibilityActor = {
      teamIds: [],
      projectIds: ["project-A", "project-B"],
      platformRole: "member",
    };
    const visible = filterMatchRowsByVisibility(rows, skills, actor).map((r) => r.skillId);
    expect(visible.sort()).toEqual(["skill-project-A", "skill-project-B"]);
  });

  it("workspace-level row is hidden for non-admin regardless of any scope match", () => {
    const rows = [row("skill-ws-1")];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-ws-1", { level: "workspace", scope: "any" }],
    ]);
    const actor: VisibilityActor = {
      userId: "user-1",
      teamIds: ["team-A"],
      projectIds: ["project-X"],
      orgId: "org-1",
      platformRole: "member",
    };
    expect(filterMatchRowsByVisibility(rows, skills, actor)).toHaveLength(0);
  });

  it("platform_admin sees all rows in a mixed-level batch, including workspace and uninstalled-skill rows", () => {
    const rows = [
      row("skill-personal-other"),
      row("skill-team-other"),
      row("skill-org-other"),
      row("skill-project-other"),
      row("skill-workspace"),
      row("skill-agent"),
      row("skill-system"),
      row("skill-third-party"),
      // intentionally not in skillsById — uninstalled
      row("skill-uninstalled"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-personal-other", { level: "personal", scope: "user-2" }],
      ["skill-team-other", { level: "team", scope: "team-Z" }],
      ["skill-org-other", { level: "organization", scope: "org-2" }],
      ["skill-project-other", { level: "project", scope: "project-Z" }],
      ["skill-workspace", { level: "workspace" }],
      ["skill-agent", { level: "agent", agentId: "@cinatra/email" }],
      ["skill-system", { level: "system" }],
      ["skill-third-party", { level: "system" }],
      // skill-uninstalled deliberately omitted
    ]);
    const admin: VisibilityActor = {
      userId: "admin",
      teamIds: [],
      projectIds: [],
      platformRole: "platform_admin",
    };
    // Admin short-circuit returns all rows untouched, including the
    // uninstalled-skill row. The defensive per-row check is applied only for
    // non-admin actors.
    const visible = filterMatchRowsByVisibility(rows, skills, admin);
    expect(visible).toHaveLength(rows.length);
  });

  it("actor with no identity fields sees zero scoped rows but still sees agent/system/third-party rows", () => {
    const rows = [
      row("skill-personal"),
      row("skill-team"),
      row("skill-org"),
      row("skill-project"),
      row("skill-workspace"),
      row("skill-agent"),
      row("skill-system"),
      row("skill-third-party"),
    ];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-personal", { level: "personal", scope: "someone" }],
      ["skill-team", { level: "team", scope: "team-A" }],
      ["skill-org", { level: "organization", scope: "org-1" }],
      ["skill-project", { level: "project", scope: "project-X" }],
      ["skill-workspace", { level: "workspace" }],
      ["skill-agent", { level: "agent", agentId: "@cinatra/email" }],
      ["skill-system", { level: "system" }],
      ["skill-third-party", { level: "system" }],
    ]);
    const empty: VisibilityActor = {
      teamIds: [],
      projectIds: [],
      platformRole: "member",
    };
    const visible = filterMatchRowsByVisibility(rows, skills, empty).map((r) => r.skillId);
    expect(visible.sort()).toEqual(["skill-agent", "skill-system", "skill-third-party"]);
  });

  it("filter is pure: repeated calls with same inputs return equal arrays", () => {
    const rows = [row("skill-personal-A"), row("skill-third-party")];
    const skills = new Map<string, VisibilitySkillMeta>([
      ["skill-personal-A", { level: "personal", scope: "user-A" }],
      ["skill-third-party", { level: "system" }],
    ]);
    const actor: VisibilityActor = {
      userId: "user-A",
      teamIds: [],
      projectIds: [],
      platformRole: "member",
    };

    const a = filterMatchRowsByVisibility(rows, skills, actor);
    const b = filterMatchRowsByVisibility(rows, skills, actor);
    expect(a).toEqual(b);
    expect(a.map((r) => r.skillId).sort()).toEqual(["skill-personal-A", "skill-third-party"]);
  });
});

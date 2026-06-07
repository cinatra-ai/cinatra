// Vendored-skill workspace-default resolution test.
//
// The vendored @anthropics/skills bundle registers its inner skills at
// `level: "workspace"` — the same level as first-party
// @cinatra-ai/skill-creator. Workspace-level skills resolve for EVERY
// workspace user, including the roleless model-actor that powers the
// shell-tool skill path. This test pins that contract:
// @anthropics/skills:skill-creator MUST resolve for a roleless actor
// when registered at workspace level.

import { describe, it, expect } from "vitest";
import { filterMatchRowsByVisibility, type VisibilityActor, type VisibilitySkillMeta } from "../visibility";
import type { SkillMatchRow } from "../types";

function makeRow(agentId: string, skillId: string): SkillMatchRow {
  const now = new Date("2026-05-19T00:00:00Z");
  return {
    agentId,
    skillId,
    source: "llm",
    matched: true,
    score: 0.9,
    rationale: "test",
    evaluatorVersion: "v0",
    agentInputHash: "h0",
    skillInputHash: "h0",
    status: "ok",
    errorCode: null,
    errorMessage: null,
    evaluatedAt: now,
    jobStartedAt: now,
  };
}

describe("vendored @anthropics/skills — workspace-default resolution", () => {
  it("resolves @anthropics/skills:skill-creator for a workspace member actor at level:workspace", () => {
    const rows: SkillMatchRow[] = [
      makeRow("@cinatra-ai/author-agent", "@anthropics/skills:skill-creator"),
    ];

    // Workspace member — has userId + orgId set. Maps to the actor shape
    // treated as "in the workspace" (a roleless model-actor bypasses the
    // visibility filter via the separate policyAllows path, not exercised
    // here). Validating the resolve path for the most-common authenticated
    // workspace user.
    const actor: VisibilityActor = {
      userId: "user-1",
      teamIds: [],
      projectIds: [],
      orgId: "org-1",
      platformRole: "member",
    };

    const skills = new Map<string, VisibilitySkillMeta>([
      [
        "@anthropics/skills:skill-creator",
        { level: "workspace" }, // The vendored bundle's catalog-registration level
      ],
    ]);

    const filtered = filterMatchRowsByVisibility(rows, skills, actor);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].skillId).toBe("@anthropics/skills:skill-creator");
  });

  it("denies @anthropics/skills:skill-creator for an org-less actor (security regression guard)", () => {
    // Security regression guard for the vendored-bundle case:
    // an org-less / identity-less actor MUST NOT match workspace rows.
    // The vendored bundle has no special carve-out and inherits the same
    // workspace-filter behavior as first-party @cinatra-ai skills.
    const rows: SkillMatchRow[] = [
      makeRow("@cinatra-ai/author-agent", "@anthropics/skills:skill-creator"),
    ];
    const actor: VisibilityActor = {
      teamIds: [],
      projectIds: [],
      platformRole: "member",
    };
    const skills = new Map<string, VisibilitySkillMeta>([
      ["@anthropics/skills:skill-creator", { level: "workspace" }],
    ]);
    const filtered = filterMatchRowsByVisibility(rows, skills, actor);
    expect(filtered).toHaveLength(0);
  });
});

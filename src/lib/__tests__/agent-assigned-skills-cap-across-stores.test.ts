/**
 * ONE per-run cap across BOTH assignment stores (cinatra#2815 S3, epic #2812).
 *
 * The epic binds a run to at most five DISTINCT assigned skills. Two stores
 * answer "what is assigned to this agent here": the per-scope
 * `agent_assigned_skills` store and the older `custom_skill_assignments` table.
 * The custom rows used to be appended AFTER the effective-5 selection, so five
 * scoped picks plus one custom row reached injection as SIX assigned skills and
 * only the unrelated ceiling of 8 stood between that and the model.
 *
 * This suite pins the rule at the seam that now owns it: both stores enter ONE
 * chain, share ONE first-seen dedupe and ONE cap, and the split back out only
 * decides which gate each pick still owes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { resolveAssignedSkillTier } from "../agent-assigned-skills-injection";
import type { SkillAssignability } from "@cinatra-ai/skills/agent-skill-assignability";
import { buildAssignmentScopeSnapshot } from "../../../packages/agents/src/assignment-scope-snapshot";

const AGENT_PKG = "@cinatra-ai/web-scrape-agent";
const POPULATION = [
  {
    packageId: AGENT_PKG,
    id: "web-scrape-agent",
    identifier: "web-scrape-agent",
    packageSlug: "web-scrape-agent",
  },
];

const ORG = "org_1";
const PROJECT = "proj_1";
const USER = "user_1";
const TEAM = "team_a";

const approveAll = async (
  ids: readonly string[],
): Promise<Map<string, SkillAssignability>> =>
  new Map(ids.map((id) => [id, { skillId: id, assignable: true } as SkillAssignability]));

function row(skillId: string, scopeKind: string, scopeId: string, position = 0) {
  return { skillId, scopeKind, scopeId, position };
}

const SNAPSHOT = buildAssignmentScopeSnapshot({
  orgId: ORG,
  projectId: PROJECT,
  teamIds: [TEAM],
  originatingHumanUserId: USER,
});

/** Five per-scope picks, one per layer: the cap, exactly filled. */
const FIVE_SCOPED = [
  row("s-project", "project", PROJECT),
  row("s-user", "user", USER),
  row("s-team", "team", TEAM),
  row("s-org", "organization", ORG),
  row("s-workspace", "workspace", ""),
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("five per-scope picks plus one custom row deliver FIVE", () => {
  it("refuses the custom row over the cap and reports it", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => FIVE_SCOPED,
      customScopeRows: [row("c-workspace", "workspace", "")],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.skillIds).toEqual([
      "s-project",
      "s-user",
      "s-team",
      "s-org",
      "s-workspace",
    ]);
    expect(out.customSkillIds).toEqual([]);
    expect(out.droppedOverEffectiveCap).toEqual(["c-workspace"]);
    // The whole point: five, whatever the source.
    expect([...out.skillIds, ...out.customSkillIds]).toHaveLength(5);
  });

  it("a custom row at a NARROWER layer wins its place and pushes a scoped row out", async () => {
    // The chain decides by scope, not by store. A custom PROJECT row outranks a
    // scoped WORKSPACE row, because the chain is project-first.
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => FIVE_SCOPED,
      customScopeRows: [row("c-project", "project", PROJECT)],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect([...out.skillIds, ...out.customSkillIds]).toHaveLength(5);
    expect(out.customSkillIds).toEqual(["c-project"]);
    expect(out.skillIds).not.toContain("s-workspace");
    expect(out.droppedOverEffectiveCap).toEqual(["s-workspace"]);
  });

  it("the per-scope row holds the position when BOTH stores name one skill", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => [row("shared", "project", PROJECT)],
      customScopeRows: [row("shared", "organization", ORG)],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.skillIds).toEqual(["shared"]);
    expect(out.customSkillIds).toEqual([]);
  });

  it("a custom row the snapshot does not name is not delivered at all", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => [],
      customScopeRows: [
        row("c-foreign-project", "project", "proj_elsewhere"),
        row("c-foreign-user", "user", "someone_else"),
        row("c-org", "organization", ORG),
      ],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.customSkillIds).toEqual(["c-org"]);
  });

  it("custom rows still deliver when the per-scope read FAILS, because a degraded arm is this tier's and not the other store's", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => {
        throw new Error("assignment table unreadable");
      },
      customScopeRows: [row("c-org", "organization", ORG)],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.degraded).toBe("assignment-read-failed");
    expect(out.skillIds).toEqual([]);
    expect(out.customSkillIds).toEqual(["c-org"]);
  });

  it("the custom road takes the SOLE legacy fallback too: no project, user or team layer", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => [],
      customScopeRows: [
        row("c-project", "project", PROJECT),
        row("c-user", "user", USER),
        row("c-team", "team", TEAM),
        row("c-org", "organization", ORG),
        row("c-workspace", "workspace", ""),
      ],
      resolveAssignability: approveAll,
      runScope: { snapshot: "not-a-snapshot", durableOrgId: ORG },
    });
    expect(out.customSkillIds).toEqual(["c-org", "c-workspace"]);
    expect(out.scopeUsedFallback).toBe(true);
  });

  it("the personal layer of the custom road needs an originating human", async () => {
    const headless = buildAssignmentScopeSnapshot({ orgId: ORG, teamIds: [] });
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => [],
      customScopeRows: [row("c-user", "user", USER), row("c-org", "organization", ORG)],
      resolveAssignability: approveAll,
      runScope: { snapshot: headless, durableOrgId: ORG },
    });
    expect(out.customSkillIds).toEqual(["c-org"]);
  });
});

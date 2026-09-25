/**
 * WHICH STORE WON a pick decides which gate that pick still owes
 * (cinatra#2815 S3, epic #2812).
 *
 * Both assignment stores enter ONE chain, and the picks are split back out
 * afterwards: a per-scope pick is revalidated against the catalog snapshot, and
 * a custom pick keeps the single runtime-delivery gate its caller has always
 * applied. The split asked whether the id appeared ANYWHERE among the fetched
 * per-scope rows, including rows at a scope this run's snapshot never names. So
 * a skill the custom store won at the run's own project was classified as
 * per-scope because an unrelated project also named it, entered a gate it does
 * not owe, and could be dropped there.
 *
 * The classification belongs to the row that actually WON the chain.
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
const PROJECT = "proj_named";
const OTHER_PROJECT = "proj_elsewhere";

function row(skillId: string, scopeKind: string, scopeId: string, position = 0) {
  return { skillId, scopeKind, scopeId, position };
}

const SNAPSHOT = buildAssignmentScopeSnapshot({ orgId: ORG, projectId: PROJECT, teamIds: [] });

/** Every id is refused by the catalog gate, so a pick sent through it vanishes
 *  and a pick that does not owe it survives. That is the whole discriminator. */
const refuseAll = async (
  ids: readonly string[],
): Promise<Map<string, SkillAssignability>> =>
  new Map(ids.map((id) => [id, { skillId: id, assignable: false } as SkillAssignability]));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a pick the CUSTOM store won", () => {
  it("stays a custom pick although an unrelated per-scope row names the same skill", async () => {
    const resolveAssignability = vi.fn(refuseAll);
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      // The per-scope row sits at a project this run's snapshot never names, so
      // the chain cannot place it and it wins nothing.
      readAssignments: async () => [row("s-shared", "project", OTHER_PROJECT)],
      // The custom row sits at the run's OWN project, so it is the winner.
      customScopeRows: [row("s-shared", "project", PROJECT)],
      resolveAssignability,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.customSkillIds).toEqual(["s-shared"]);
    expect(out.skillIds).toEqual([]);
    // It never owed the catalog gate, so it was never asked about.
    expect(resolveAssignability).not.toHaveBeenCalled();
  });
});

describe("a pick the PER-SCOPE store won", () => {
  it("still owes the catalog gate when the custom store names the same skill too", async () => {
    // Both stores name the skill at the SAME scope the snapshot froze. The
    // per-scope rows enter the chain first, so the per-scope row wins and the
    // custom one is the duplicate the dedupe drops.
    const resolveAssignability = vi.fn(refuseAll);
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => [row("s-shared", "project", PROJECT)],
      customScopeRows: [row("s-shared", "project", PROJECT)],
      resolveAssignability,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.customSkillIds).toEqual([]);
    expect(out.skillIds).toEqual([]);
    expect(resolveAssignability).toHaveBeenCalledWith(["s-shared"]);
    expect(out.withheld.map((w) => w.skillId)).toEqual(["s-shared"]);
  });
});

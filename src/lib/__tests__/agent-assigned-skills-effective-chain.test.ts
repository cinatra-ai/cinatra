/**
 * THE EFFECTIVE-5 DELIVERY CHAIN, at the TIER (cinatra#2815 S3, epic #2812).
 *
 * The pure chain itself is pinned in
 * `packages/agents/src/__tests__/effective-assigned-skills.test.ts`. This suite
 * pins the tier's side of the acceptance sentence: that the resolution-time
 * loader walks the chain from the RUN'S OWN frozen snapshot, that an absent,
 * malformed or unknown-version payload resolves to workspace plus the durable
 * organization and NEVER to a project, user or team layer, and that the chain
 * runs BEFORE revalidation so only the five skills a run can actually receive
 * are ever evaluated.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  resolveAssignedSkillTier,
  resolveAssignedSkillTierIds,
} from "../agent-assigned-skills-injection";
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

/** Approves every id it is asked about — this suite isolates the CHAIN. */
const approveAll = async (
  ids: readonly string[],
): Promise<Map<string, SkillAssignability>> =>
  new Map(ids.map((id) => [id, { skillId: id, assignable: true } as SkillAssignability]));

function row(skillId: string, scopeKind: string, scopeId: string, position = 0) {
  return { skillId, scopeKind, scopeId, position };
}

const ROWS = [
  row("s-project", "project", PROJECT),
  row("s-user", "user", USER),
  row("s-team", "team", TEAM),
  row("s-org", "organization", ORG),
  row("s-workspace", "workspace", "__workspace__"),
];

const SNAPSHOT = buildAssignmentScopeSnapshot({
  orgId: ORG,
  projectId: PROJECT,
  teamIds: [TEAM],
  originatingHumanUserId: USER,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the tier walks the chain from the RUN's frozen snapshot", () => {
  it("delivers project -> user -> team -> organization -> workspace, capped at five", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => ROWS,
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
    expect(out.scopeUsedFallback).toBe(false);
    expect(out.droppedOverEffectiveCap).toEqual([]);
    expect(out.degraded).toBeNull();
  });

  it("a SIXTH distinct assignment is refused by the per-run cap and REPORTED", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => [
        ...[1, 2, 3, 4, 5].map((n) => row(`p${n}`, "project", PROJECT, n)),
        row("s-workspace", "workspace", "__workspace__"),
      ],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.skillIds).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(out.droppedOverEffectiveCap).toEqual(["s-workspace"]);
  });

  it("the chain runs BEFORE revalidation — only deliverable candidates are evaluated", async () => {
    const asked: string[][] = [];
    await resolveAssignedSkillTierIds("web-scrape-agent", POPULATION, {
      readAssignments: async () => [
        ...ROWS,
        row("s-other-project", "project", "proj_elsewhere"),
      ],
      resolveAssignability: async (ids) => {
        asked.push([...ids]);
        return approveAll(ids);
      },
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain("s-other-project");
    expect(asked[0]).toHaveLength(5);
  });

  it("a scope the snapshot does not name is NOT delivered, however many rows exist", async () => {
    const out = await resolveAssignedSkillTierIds("web-scrape-agent", POPULATION, {
      readAssignments: async () => [
        row("foreign-project", "project", "proj_elsewhere"),
        row("foreign-team", "team", "team_elsewhere"),
        row("foreign-user", "user", "user_elsewhere"),
      ],
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out).toEqual([]);
  });
});

describe("the SOLE legacy fallback, at the tier", () => {
  const unusable: Array<[string, unknown]> = [
    ["an absent payload", undefined],
    ["a malformed payload", "{not json"],
    ["an unknown version", { v: 7, orgId: ORG, teamIds: [] }],
  ];

  for (const [label, snapshot] of unusable) {
    it(`${label} delivers workspace + organization ONLY — project/user/team never`, async () => {
      const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
        readAssignments: async () => ROWS,
        resolveAssignability: approveAll,
        runScope: { snapshot, durableOrgId: ORG },
      });
      expect(out.skillIds).toEqual(["s-org", "s-workspace"]);
      expect(out.scopeUsedFallback).toBe(true);
      expect(out.skillIds).not.toContain("s-project");
      expect(out.skillIds).not.toContain("s-user");
      expect(out.skillIds).not.toContain("s-team");
    });
  }

  it("no snapshot AND no durable organization narrows to the WORKSPACE layer alone", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => ROWS,
      resolveAssignability: approveAll,
      runScope: {},
    });
    expect(out.skillIds).toEqual(["s-workspace"]);
    expect(out.scopeUsedFallback).toBe(true);
  });

  it("a caller that supplies NO scope at all gets the same narrow answer, never the package-wide set", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => ROWS,
      resolveAssignability: approveAll,
    });
    expect(out.skillIds).toEqual(["s-workspace"]);
    expect(out.scopeUsedFallback).toBe(true);
  });
});

describe("the fail-closed arms still report the scope decision", () => {
  it("an assignment-read failure yields the empty set and a degradation reason", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => {
        throw new Error("table unreadable");
      },
      resolveAssignability: approveAll,
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.skillIds).toEqual([]);
    expect(out.degraded).toBe("assignment-read-failed");
    expect(out.droppedOverEffectiveCap).toEqual([]);
  });

  it("a revalidation that refuses a chain winner withholds it, chain order preserved", async () => {
    const out = await resolveAssignedSkillTier("web-scrape-agent", POPULATION, {
      readAssignments: async () => ROWS,
      resolveAssignability: async (ids) =>
        new Map(
          ids.map((id) => [
            id,
            (id === "s-user"
              ? { skillId: id, assignable: false, reason: "archived" }
              : { skillId: id, assignable: true }) as SkillAssignability,
          ]),
        ),
      runScope: { snapshot: SNAPSHOT, durableOrgId: ORG },
    });
    expect(out.skillIds).toEqual(["s-project", "s-team", "s-org", "s-workspace"]);
    expect(out.withheld).toEqual([{ skillId: "s-user", reason: "archived" }]);
  });
});

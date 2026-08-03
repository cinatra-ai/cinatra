/**
 * CAP-PRESSURE semantics for the assigned tier (cinatra#2347 S2, epic #2345).
 *
 * The epic's behavioral contract under the 8-cap, asserted through the REAL
 * `resolveInjectedSkillSet` (the same entry the llm-bridge calls), with fake
 * ports supplying the members:
 *
 *   declared dependencies  >  personal delta  >  ASSIGNED  >  automatic matches
 *
 * The first three boundaries are the injection contract's own retention order
 * (untouched by this issue — #2090's manifest-declared channel is a DIFFERENT
 * port and stays at declared-dependency rank). The last boundary is what S2
 * adds, and it is NOT a new rank: assigned skills ride the SAME
 * `recommendation` rank automatic matches do, and win only because the resolver
 * places them EARLIER in the union, which the contract's first-seen ordering key
 * turns into earlier retention.
 *
 * SCOPE NOTE — this suite drives the ranking with a HAND-BUILT recommendation
 * list (`[...assigned, ...autoMatched]`), so on its own it proves the CONTRACT's
 * behavior given that order, not that production produces it. The two halves
 * that close the loop live elsewhere and are the load-bearing evidence:
 *   - the resolver really emits assignments before automatic matches —
 *     `agents-store-assigned-skill-tier.test.ts`;
 *   - that order really survives the bridge into the capped set delivered to the
 *     model, with real assignment rows, real `skill_matches` rows, a real
 *     declared dependency and a real personal delta —
 *     `src/app/api/llm-bridge/__tests__/assigned-skill-injection-delivery.test.ts`
 *     ("cap pressure at the REAL bridge").
 * What this suite adds on top is the boundaries that are impractical to stage
 * through the bridge: a cap filled by EIGHT declared dependencies, and the
 * delta-vs-assignment tie for the last slot.
 */
import { describe, it, expect } from "vitest";

import {
  INJECTED_SKILL_CAP,
  injectedSkillDrops,
  injectedSkillMembers,
  resolveInjectedSkillSet,
} from "@cinatra-ai/skills/injection";
import type { InjectionResolverPorts } from "@cinatra-ai/skills/injection";

const ASSIGNED = ["assigned-1", "assigned-2"];
const AUTO = ["auto-1", "auto-2"];

function ports(input: {
  declaredDependencies?: string[];
  delta?: boolean;
  assigned?: string[];
  auto?: string[];
}): InjectionResolverPorts {
  return {
    authorizeAgentRun: async () => ({ ok: true, runOwnerUserId: "owner-1" }),
    resolveDeclaredDependencySkills: async () =>
      (input.declaredDependencies ?? []).map((skillId) => ({ skillId })),
    // THE union order the resolver emits: assigned first, then auto-matched.
    resolveRunRecommendedSkills: async () =>
      [...(input.assigned ?? []), ...(input.auto ?? [])].map((skillId) => ({ skillId })),
    resolvePersonalDelta: async () =>
      input.delta ? { skillId: "personal-1", content: "MY DELTA", revisionId: "prev-1" } : null,
  };
}

const INTENT = {
  kind: "agent-run" as const,
  agentId: "@cinatra-ai/web-scrape-agent",
  runId: "run-1",
  userId: "owner-1",
};

async function resolve(input: Parameters<typeof ports>[0]) {
  const set = await resolveInjectedSkillSet(INTENT, ports(input));
  return {
    kept: injectedSkillMembers(set).map((m) => m.skillId),
    dropped: injectedSkillDrops(set).map((d) => d.skillId),
    members: injectedSkillMembers(set),
    drops: injectedSkillDrops(set),
  };
}

function deps(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `dep-${i + 1}`);
}

describe("assigned skills ride the SAME rank as automatic matches", () => {
  it("both tiers land at `recommendation` rank — no privileged rank was introduced", async () => {
    const { members } = await resolve({ assigned: ASSIGNED, auto: AUTO });
    for (const id of [...ASSIGNED, ...AUTO]) {
      expect(members.find((m) => m.skillId === id)?.rank, id).toBe("recommendation");
    }
  });

  it("with no cap pressure EVERYTHING is delivered, assigned first", async () => {
    const { kept, dropped } = await resolve({ assigned: ASSIGNED, auto: AUTO });
    expect(kept).toEqual([...ASSIGNED, ...AUTO]);
    expect(dropped).toEqual([]);
  });
});

describe("under cap pressure the assigned tier survives ahead of automatic matches", () => {
  it("truncation cuts the AUTOMATIC matches and keeps the assignments", async () => {
    // 1 delta + 5 declared deps + 2 assigned + 2 auto = 10 candidates, cap 8.
    const { kept, dropped, drops } = await resolve({
      declaredDependencies: deps(5),
      delta: true,
      assigned: ASSIGNED,
      auto: AUTO,
    });
    expect(kept).toHaveLength(INJECTED_SKILL_CAP);
    for (const id of ASSIGNED) expect(kept, id).toContain(id);
    expect(dropped).toEqual(AUTO);
    expect(drops.every((d) => d.reason === "over_cap")).toBe(true);
  });

  it("the LAST free slot goes to the assignment, not to the automatic match", async () => {
    // 1 delta + 6 deps + 1 assigned + 1 auto = 9 candidates: exactly one drop.
    const { kept, dropped } = await resolve({
      declaredDependencies: deps(6),
      delta: true,
      assigned: ["assigned-1"],
      auto: ["auto-1"],
    });
    expect(kept).toContain("assigned-1");
    expect(dropped).toEqual(["auto-1"]);
  });

  it("MUTATION GUARD — reverse the union order and the automatic match wins instead", async () => {
    // The survival above is produced by the UNION POSITION S2 chose, not by
    // anything intrinsic to the ids: feeding the same members in the opposite
    // order flips the outcome. If the resolver ever appended assignments after
    // the matched tier, the assertion above would silently become vacuous.
    const set = await resolveInjectedSkillSet(INTENT, {
      ...ports({ declaredDependencies: deps(6), delta: true }),
      resolveRunRecommendedSkills: async () => [
        { skillId: "auto-1" },
        { skillId: "assigned-1" },
      ],
    });
    expect(injectedSkillMembers(set).map((m) => m.skillId)).toContain("auto-1");
    expect(injectedSkillDrops(set).map((d) => d.skillId)).toEqual(["assigned-1"]);
  });
});

describe("declared dependencies and the personal delta still OUTRANK the assigned tier", () => {
  it("a declared dependency never yields its slot to an assignment", async () => {
    // 8 declared deps fill the cap outright (#2090's manifest channel).
    const { kept, dropped } = await resolve({
      declaredDependencies: deps(8),
      delta: true,
      assigned: ["assigned-1"],
    });
    expect(kept).toEqual(deps(8));
    expect(dropped).toEqual(expect.arrayContaining(["assigned-1", "personal-1"]));
  });

  it("the personal delta outranks an assignment for the last slot", async () => {
    // 7 deps + delta + 1 assigned = 9 candidates: the delta keeps slot 8.
    const { kept, dropped } = await resolve({
      declaredDependencies: deps(7),
      delta: true,
      assigned: ["assigned-1"],
    });
    expect(kept).toContain("personal-1");
    expect(dropped).toEqual(["assigned-1"]);
  });

  it("an assignment that is ALSO a declared dependency is delivered once, at the HIGHER rank", async () => {
    // Cross-channel dedup: #2090's channel already delivers the bytes, so the
    // assignment must not burn a second slot.
    const { kept, members } = await resolve({
      declaredDependencies: ["shared-skill"],
      assigned: ["shared-skill"],
      auto: AUTO,
    });
    expect(kept.filter((id) => id === "shared-skill")).toHaveLength(1);
    expect(members.find((m) => m.skillId === "shared-skill")?.rank).toBe(
      "declared_dependency",
    );
  });
});

describe("the contract does not resurrect a collapsed duplicate", () => {
  it("a repeated id in the recommendation list stays ONE member, at its first position", async () => {
    // NOT the AC-3 proof — that one lives in `agents-store-assigned-skill-tier`
    // and runs the real resolver, because only there do "assigned" and
    // "auto-matched" mean anything. This is the downstream half: even if a
    // caller handed the contract a list with the id twice, the delivered set
    // keeps one member at the EARLIER position, so the resolver's collapse
    // cannot be undone below it.
    const set = await resolveInjectedSkillSet(INTENT, {
      ...ports({}),
      resolveRunRecommendedSkills: async () => [
        { skillId: "shared-skill" },
        { skillId: "auto-1" },
        { skillId: "shared-skill" },
      ],
    });
    expect(injectedSkillMembers(set).map((m) => m.skillId)).toEqual([
      "shared-skill",
      "auto-1",
    ]);
  });
});

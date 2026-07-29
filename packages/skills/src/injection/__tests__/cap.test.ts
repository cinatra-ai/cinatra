/**
 * The hard cap and its ranking (cinatra#2091, epic #2086 S4).
 *
 * Pins the two orders the ratified rank sentence carries — DELIVERY order
 * (delta first) and RETENTION order (declared dependencies never yield a slot)
 * — plus determinism and the exact drop reasons the efficacy ledger stores.
 */
import { describe, it, expect } from "vitest";
import {
  rankAndCapInjectedMembers,
  INJECTED_SKILL_CAP,
  type InjectedSkillMember,
} from "..";

function dep(id: string): InjectedSkillMember {
  return { skillId: id, rank: "declared_dependency", deliveryMode: "catalog", revisionId: null };
}
function rec(id: string): InjectedSkillMember {
  return { skillId: id, rank: "recommendation", deliveryMode: "catalog", revisionId: null };
}
function delta(id: string): InjectedSkillMember {
  return {
    skillId: id,
    rank: "personal_delta",
    deliveryMode: "inline",
    revisionId: "rev-1",
    content: "DELTA",
  };
}

describe("rankAndCapInjectedMembers", () => {
  it("the cap is 8 TOTAL — the personal delta occupies one of the eight", () => {
    const { members, dropped } = rankAndCapInjectedMembers({
      delta: delta("p1"),
      declaredDependencies: [],
      recommendations: Array.from({ length: 10 }, (_, i) => rec(`r${i}`)),
    });
    expect(members).toHaveLength(INJECTED_SKILL_CAP);
    expect(members[0]!.skillId).toBe("p1");
    // 11 candidates, 8 kept => 3 dropped, all recommendations.
    expect(dropped).toHaveLength(3);
    expect(dropped.every((d) => d.reason === "over_cap")).toBe(true);
  });

  it("delivers the delta FIRST, then declared dependencies, then recommendations", () => {
    const { members } = rankAndCapInjectedMembers({
      delta: delta("p1"),
      declaredDependencies: [dep("d1"), dep("d2")],
      recommendations: [rec("r1")],
    });
    expect(members.map((m) => m.skillId)).toEqual(["p1", "d1", "d2", "r1"]);
  });

  it("a declared dependency NEVER yields its slot to a recommendation", () => {
    const { members, dropped } = rankAndCapInjectedMembers({
      delta: null,
      declaredDependencies: Array.from({ length: 6 }, (_, i) => dep(`d${i}`)),
      recommendations: Array.from({ length: 6 }, (_, i) => rec(`r${i}`)),
    });
    const kept = members.map((m) => m.skillId);
    for (let i = 0; i < 6; i += 1) expect(kept).toContain(`d${i}`);
    expect(dropped.every((d) => d.rank === "recommendation")).toBe(true);
  });

  it("EXACTLY 8 required dependencies leave no slot — the delta drops, and is recorded", () => {
    const { members, dropped } = rankAndCapInjectedMembers({
      delta: delta("p1"),
      declaredDependencies: Array.from({ length: 8 }, (_, i) => dep(`d${i}`)),
      recommendations: [],
    });
    expect(members).toHaveLength(8);
    expect(members.some((m) => m.skillId === "p1")).toBe(false);
    expect(dropped).toEqual([
      {
        skillId: "p1",
        rank: "personal_delta",
        reason: "delta_displaced_by_required_dependencies",
      },
    ]);
  });

  it("MORE than 8 required dependencies is recorded with its own configuration-error reason", () => {
    const { members, dropped } = rankAndCapInjectedMembers({
      delta: null,
      declaredDependencies: Array.from({ length: 11 }, (_, i) => dep(`d${i}`)),
      recommendations: [],
    });
    expect(members).toHaveLength(8);
    expect(dropped).toHaveLength(3);
    expect(
      dropped.every((d) => d.reason === "over_cap_required_dependencies"),
    ).toBe(true);
  });

  it("dedupes across ranks — a skill that is BOTH a dependency and a recommendation takes ONE slot at the stronger rank", () => {
    const { members } = rankAndCapInjectedMembers({
      delta: null,
      declaredDependencies: [dep("shared")],
      recommendations: [rec("shared"), rec("other")],
    });
    expect(members.map((m) => m.skillId)).toEqual(["shared", "other"]);
    expect(members[0]!.rank).toBe("declared_dependency");
  });

  it("is deterministic — identical input yields an identical selection", () => {
    const build = () =>
      rankAndCapInjectedMembers({
        delta: delta("p1"),
        declaredDependencies: [dep("b"), dep("a")],
        recommendations: [rec("z"), rec("y"), rec("x"), rec("w"), rec("v"), rec("u"), rec("t")],
      });
    const first = build();
    const second = build();
    expect(second.members).toEqual(first.members);
    expect(second.dropped).toEqual(first.dropped);
  });

  it("an empty candidate set yields an empty selection with no drops", () => {
    const { members, dropped } = rankAndCapInjectedMembers({
      delta: null,
      declaredDependencies: [],
      recommendations: [],
    });
    expect(members).toEqual([]);
    expect(dropped).toEqual([]);
  });
});

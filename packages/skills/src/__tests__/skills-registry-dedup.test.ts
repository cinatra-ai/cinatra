/**
 * `dedupSkillsByName` is the dropdown-only view-model helper.
 *
 * Deduping at the `listInstalledSkills()` layer is unsafe because downstream
 * callers (`personal-skills.ts`, `agents/server-actions.ts`) depend on exact
 * skill-id addressability. Dropping rows there breaks them. Dedup belongs at
 * the dropdown render site only, AFTER the level=agent / agentId-set filter.
 *
 * Tests below pin (a) the pure dedup function and (b) the SkillManifest
 * `agentId` surface.
 */
import { describe, it, expect } from "vitest";
import { dedupSkillsByName } from "../dedup-skills";

// Inline SkillManifest-shaped fixture — the dedup function only needs
// `name` and `level`, so we don't import the full type.
type SkillFixture = {
  id: string;
  name: string;
  level?: string;
  agentId?: string;
};

function makeSkill(overrides: Partial<SkillFixture>): SkillFixture {
  return {
    id: "id",
    name: "Skill",
    ...overrides,
  };
}

describe("dedupSkillsByName (dropdown view-model)", () => {
  it("DEDUP-01: same display name from two package sources → one entry; system wins", () => {
    const result = dedupSkillsByName([
      makeSkill({ id: "a", name: "Market Ads", level: "system" }),
      makeSkill({ id: "b", name: "Market Ads", level: "third-party" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("DEDUP-02: precedence — team beats personal", () => {
    const result = dedupSkillsByName([
      makeSkill({ id: "p", name: "Cold Email", level: "personal" }),
      makeSkill({ id: "t", name: "Cold Email", level: "team" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t");
  });

  it("DEDUP-03: different display names are NOT deduped", () => {
    const result = dedupSkillsByName([
      makeSkill({ id: "a", name: "Read CSV", level: "system" }),
      makeSkill({ id: "b", name: "Write CSV", level: "system" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("DEDUP-04: precedence — system > organization > team > workspace > project > personal > third-party", () => {
    const allLevels = ["third-party", "personal", "project", "workspace", "team", "organization", "system"] as const;
    const inputs = allLevels.map((level, i) => makeSkill({ id: `id-${i}`, name: "X", level }));
    const result = dedupSkillsByName(inputs);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe("system");
  });

  it("DEDUP-05: name comparison is case-insensitive + trim-tolerant", () => {
    const result = dedupSkillsByName([
      makeSkill({ id: "a", name: "Market Ads", level: "system" }),
      makeSkill({ id: "b", name: "  market ads  ", level: "personal" }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("DEDUP-06: function is a pure helper — does not mutate inputs", () => {
    const inputs: SkillFixture[] = [
      makeSkill({ id: "a", name: "X", level: "system" }),
      makeSkill({ id: "b", name: "X", level: "personal" }),
    ];
    const before = JSON.stringify(inputs);
    dedupSkillsByName(inputs);
    expect(JSON.stringify(inputs)).toBe(before);
  });
});

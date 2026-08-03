// PURE search model for the assignable-skills picker (cinatra#2348 S3).
//
// Narrowing, ordering and paging are the three things a "search box" can get
// subtly wrong without ever throwing: an unstable order silently drops rows
// between pages, an unclamped limit turns one keystroke into a full-catalog
// response, and a needle compiled into a pattern lets `%` or `.*` widen the
// match. Each is pinned here, with no I/O in sight.
import { describe, expect, it } from "vitest";

import {
  ASSIGNABLE_SKILL_MAX_PAGE_SIZE,
  ASSIGNABLE_SKILL_PAGE_SIZE,
  assignableSkillRowMatches,
  compareAssignableSkillRows,
  normalizeAssignableSkillPage,
  normalizeAssignableSkillQuery,
  selectAssignableSkillPage,
  type AssignableSkillRow,
} from "../assignable-skills-search-model";

function row(overrides: Partial<AssignableSkillRow> = {}): AssignableSkillRow {
  return {
    skillId: "@acme/widget-skills:do-thing",
    skillName: "Do Thing",
    skillDescription: "Does the thing.",
    packageName: "@acme/widget-skills",
    displayName: "Widget Skills",
    vendorName: "Acme Corporation",
    status: "active",
    ...overrides,
  };
}

/** N distinct rows, named so the sorted order is predictable. */
function rows(n: number): AssignableSkillRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({
      skillId: `@acme/pack-${String(i).padStart(3, "0")}:s`,
      skillName: `Skill ${String(i).padStart(3, "0")}`,
      displayName: `Pack ${String(i).padStart(3, "0")}`,
      packageName: `@acme/pack-${String(i).padStart(3, "0")}`,
    }),
  );
}

describe("normalizeAssignableSkillPage — the page cap", () => {
  it("defaults to the shared page size", () => {
    expect(normalizeAssignableSkillPage()).toEqual({ offset: 0, limit: ASSIGNABLE_SKILL_PAGE_SIZE });
    expect(normalizeAssignableSkillPage({})).toEqual({
      offset: 0,
      limit: ASSIGNABLE_SKILL_PAGE_SIZE,
    });
  });

  it("CLAMPS an oversized limit to the max page size", () => {
    expect(normalizeAssignableSkillPage({ limit: 10_000 }).limit).toBe(
      ASSIGNABLE_SKILL_MAX_PAGE_SIZE,
    );
  });

  it("floors a limit below 1 to 1, and a negative offset to 0", () => {
    expect(normalizeAssignableSkillPage({ limit: 0 }).limit).toBe(1);
    expect(normalizeAssignableSkillPage({ limit: -5 }).limit).toBe(1);
    expect(normalizeAssignableSkillPage({ offset: -12 }).offset).toBe(0);
  });

  it("reads a NON-FINITE bound as unspecified, never as 'give me everything'", () => {
    expect(normalizeAssignableSkillPage({ limit: Number.NaN, offset: Number.NaN })).toEqual({
      offset: 0,
      limit: ASSIGNABLE_SKILL_PAGE_SIZE,
    });
    expect(normalizeAssignableSkillPage({ limit: Infinity }).limit).toBe(ASSIGNABLE_SKILL_PAGE_SIZE);
    expect(normalizeAssignableSkillPage({ offset: -Infinity }).offset).toBe(0);
    expect(normalizeAssignableSkillPage({ offset: Infinity }).offset).toBe(0);
  });

  it("truncates fractional windows", () => {
    expect(normalizeAssignableSkillPage({ offset: 3.9, limit: 7.9 })).toEqual({
      offset: 3,
      limit: 7,
    });
  });
});

describe("normalizeAssignableSkillQuery / assignableSkillRowMatches — the LITERAL needle", () => {
  it("treats a blank query as match-everything", () => {
    expect(normalizeAssignableSkillQuery("")).toBeNull();
    expect(normalizeAssignableSkillQuery("   ")).toBeNull();
    expect(normalizeAssignableSkillQuery(null)).toBeNull();
    expect(normalizeAssignableSkillQuery(undefined)).toBeNull();
  });

  it("matches case-insensitively across title, skill name, package and vendor", () => {
    expect(assignableSkillRowMatches(row(), "widget")).toBe(true);
    expect(assignableSkillRowMatches(row(), "DO THING")).toBe(true);
    expect(assignableSkillRowMatches(row(), "@acme/")).toBe(true);
    expect(assignableSkillRowMatches(row(), "acme corp")).toBe(true);
    expect(assignableSkillRowMatches(row(), "nothing-like-this")).toBe(false);
  });

  it("does NOT match on the description (an unindexed field must not widen results)", () => {
    expect(assignableSkillRowMatches(row({ skillDescription: "zebra" }), "zebra")).toBe(false);
  });

  it("treats SQL LIKE wildcards as LITERAL characters", () => {
    // The co-owner search escapes `%`/`_`/`\` before building an ILIKE pattern.
    // Here the needle is never a pattern at all, so the same guarantee holds
    // structurally: `%` matches a literal percent sign and nothing else.
    const plain = rows(3);
    expect(selectAssignableSkillPage(plain, "%").results).toEqual([]);
    expect(selectAssignableSkillPage(plain, "_").results).toEqual([]);
    expect(selectAssignableSkillPage(plain, "\\").results).toEqual([]);
    const literal = [row({ displayName: "100% Coverage", skillId: "@acme/a:s" })];
    expect(selectAssignableSkillPage(literal, "100%").results).toHaveLength(1);
  });

  it("treats REGEX metacharacters as literal too (the needle is never compiled)", () => {
    const plain = rows(3);
    for (const needle of [".*", "^Pack", "(", "[a-z]", "?", "+"]) {
      expect(selectAssignableSkillPage(plain, needle).results, needle).toEqual([]);
    }
    const literal = [row({ displayName: "C++ Helpers", skillId: "@acme/a:s" })];
    expect(selectAssignableSkillPage(literal, "c++").results).toHaveLength(1);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(selectAssignableSkillPage([row()], "   widget  ").results).toHaveLength(1);
  });

  it("tolerates a row with NO vendor byline", () => {
    expect(assignableSkillRowMatches(row({ vendorName: null }), "widget")).toBe(true);
    expect(assignableSkillRowMatches(row({ vendorName: null }), "acme corp")).toBe(false);
  });

  it("normalizes the query ITSELF, so a raw needle can never miss", () => {
    // The predicate is exported; a caller that skipped normalization would
    // otherwise compare "DO THING" against a lowercased haystack and silently
    // match nothing.
    expect(assignableSkillRowMatches(row(), "  WIDGET  ")).toBe(true);
    expect(assignableSkillRowMatches(row(), "")).toBe(true);
    expect(assignableSkillRowMatches(row(), null)).toBe(true);
  });
});

describe("compareAssignableSkillRows — a STABLE total order", () => {
  it("orders by extension title, then skill name, then id", () => {
    const a = row({ displayName: "Alpha", skillName: "b", skillId: "id-1" });
    const b = row({ displayName: "Beta", skillName: "a", skillId: "id-0" });
    expect(compareAssignableSkillRows(a, b)).toBeLessThan(0);

    const sameExt1 = row({ displayName: "Alpha", skillName: "Apple", skillId: "id-9" });
    const sameExt2 = row({ displayName: "Alpha", skillName: "Banana", skillId: "id-0" });
    expect(compareAssignableSkillRows(sameExt1, sameExt2)).toBeLessThan(0);

    const tie1 = row({ displayName: "Alpha", skillName: "Apple", skillId: "id-0" });
    const tie2 = row({ displayName: "Alpha", skillName: "Apple", skillId: "id-1" });
    expect(compareAssignableSkillRows(tie1, tie2)).toBeLessThan(0);
    expect(compareAssignableSkillRows(tie1, tie1)).toBe(0);
  });

  it("is case-insensitive on the title so casing does not reshuffle pages", () => {
    const a = row({ displayName: "apple pack", skillId: "id-a" });
    const b = row({ displayName: "Banana Pack", skillId: "id-b" });
    expect(compareAssignableSkillRows(a, b)).toBeLessThan(0);
  });
});

describe("selectAssignableSkillPage — narrow, order, page", () => {
  it("narrows BEFORE paging (typing changes which rows page one holds)", () => {
    const population = [
      row({ displayName: "Alpha Pack", skillId: "a" }),
      row({ displayName: "Beta Pack", skillId: "b" }),
      row({ displayName: "Gamma Pack", skillId: "c" }),
    ];
    expect(selectAssignableSkillPage(population, "", { limit: 2 })).toEqual({
      results: [population[0], population[1]],
      hasMore: true,
    });
    // Same window, narrowed needle: page one is now the ONE matching row and
    // there is nothing more — proof the filter ran server-side, ahead of the
    // slice, rather than the client trimming a full page.
    expect(selectAssignableSkillPage(population, "gamma", { limit: 2 })).toEqual({
      results: [population[2]],
      hasMore: false,
    });
  });

  it("reports hasMore exactly, via the limit+1 over-read", () => {
    const population = rows(21);
    const first = selectAssignableSkillPage(population, "", { limit: 20 });
    expect(first.results).toHaveLength(20);
    expect(first.hasMore).toBe(true);

    const second = selectAssignableSkillPage(population, "", { offset: 20, limit: 20 });
    expect(second.results).toHaveLength(1);
    expect(second.hasMore).toBe(false);

    // Exactly one full page and nothing beyond it.
    const exact = selectAssignableSkillPage(rows(20), "", { limit: 20 });
    expect(exact.results).toHaveLength(20);
    expect(exact.hasMore).toBe(false);
  });

  it("pages without dropping or duplicating a row", () => {
    const population = rows(17);
    const seen: string[] = [];
    for (let offset = 0; offset < 20; offset += 5) {
      seen.push(...selectAssignableSkillPage(population, "", { offset, limit: 5 }).results.map((r) => r.skillId));
    }
    expect(seen).toHaveLength(17);
    expect(new Set(seen).size).toBe(17);
    expect(seen).toEqual([...population].sort(compareAssignableSkillRows).map((r) => r.skillId));
  });

  it("clamps an absurd limit rather than returning the whole catalog", () => {
    const page = selectAssignableSkillPage(rows(200), "", { limit: 10_000 });
    expect(page.results).toHaveLength(ASSIGNABLE_SKILL_MAX_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
  });

  it("returns an empty page past the end without throwing", () => {
    expect(selectAssignableSkillPage(rows(3), "", { offset: 500 })).toEqual({
      results: [],
      hasMore: false,
    });
  });

  it("does not mutate its input", () => {
    const population = rows(4);
    const before = population.map((r) => r.skillId);
    selectAssignableSkillPage(population, "pack", { limit: 2 });
    expect(population.map((r) => r.skillId)).toEqual(before);
  });
});

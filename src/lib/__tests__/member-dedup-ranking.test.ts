// Unit tests for the member-dedup ranking comparator.
//
// The production dedup runs as a SQL window CTE inside
// buildCreateStoreSchemaQueries (guarded byte-shape by
// member-dedup-migration-shape.test.ts). compareMemberDedup /
// pickSurvivingMemberRow are the JS mirror of that ORDER BY; these tests
// pin each tie-break dimension so the documented strategy can't silently
// drift: role rank DESC (owner > admin > member > unknown/NULL), then
// createdAt ASC NULLS LAST, then id ASC.

import { describe, expect, it } from "vitest";

import {
  compareMemberDedup,
  memberDedupRoleRank,
  pickSurvivingMemberRow,
  type MemberDedupRow,
} from "@/lib/drizzle-store";

describe("memberDedupRoleRank", () => {
  it("ranks owner > admin > member > unknown/NULL", () => {
    expect(memberDedupRoleRank("owner")).toBe(3);
    expect(memberDedupRoleRank("admin")).toBe(2);
    expect(memberDedupRoleRank("member")).toBe(1);
    expect(memberDedupRoleRank(null)).toBe(0);
    expect(memberDedupRoleRank(undefined)).toBe(0);
    // Better Auth supports custom roles; they must never beat a known role.
    expect(memberDedupRoleRank("billing-manager")).toBe(0);
  });

  it("takes the MAX rank across comma-split role tokens (Better Auth multi-role)", () => {
    // Better Auth stores role arrays as comma-joined text. 'owner,admin' is
    // owner-capable and MUST rank as owner (3) — not 0 — or the dedup would
    // delete the owner-capable row and keep a plain 'member'.
    expect(memberDedupRoleRank("owner,admin")).toBe(3);
    expect(memberDedupRoleRank("admin,owner")).toBe(3);
    expect(memberDedupRoleRank("admin,sale")).toBe(2);
    expect(memberDedupRoleRank("member,billing")).toBe(1);
    expect(memberDedupRoleRank("sale,billing")).toBe(0);
    // Whitespace around tokens is trimmed (string_to_array + trim() in SQL).
    expect(memberDedupRoleRank(" owner , admin ")).toBe(3);
  });
});

describe("pickSurvivingMemberRow", () => {
  const d = (iso: string) => new Date(iso);

  it("role rank dominates createdAt and id (owner survives)", () => {
    const rows: MemberDedupRow[] = [
      { id: "a", role: "member", createdAt: d("2020-01-01T00:00:00Z") }, // oldest + lowest id
      { id: "z", role: "owner", createdAt: d("2026-01-01T00:00:00Z") }, // newest + highest id
      { id: "m", role: "admin", createdAt: d("2023-01-01T00:00:00Z") },
    ];
    expect(pickSurvivingMemberRow(rows).id).toBe("z");
  });

  it("a comma-role 'owner,admin' row survives over a plain 'member' row", () => {
    // The deploy-time data-loss guard: ranking the raw string would score
    // 'owner,admin' as 0 and delete it, stranding the org on a 'member' row.
    const rows: MemberDedupRow[] = [
      { id: "member-row", role: "member", createdAt: d("2020-01-01T00:00:00Z") }, // oldest
      { id: "multi-role-row", role: "owner,admin", createdAt: d("2025-01-01T00:00:00Z") },
    ];
    expect(pickSurvivingMemberRow(rows).id).toBe("multi-role-row");
  });

  it("equal role: oldest createdAt wins", () => {
    const rows: MemberDedupRow[] = [
      { id: "b", role: "member", createdAt: d("2024-06-01T00:00:00Z") },
      { id: "a", role: "member", createdAt: d("2022-06-01T00:00:00Z") }, // oldest
      { id: "c", role: "member", createdAt: d("2025-06-01T00:00:00Z") },
    ];
    expect(pickSurvivingMemberRow(rows).id).toBe("a");
  });

  it("equal role + equal createdAt: lowest id wins", () => {
    const same = d("2024-06-01T00:00:00Z");
    const rows: MemberDedupRow[] = [
      { id: "id-c", role: "admin", createdAt: same },
      { id: "id-a", role: "admin", createdAt: same }, // lowest id
      { id: "id-b", role: "admin", createdAt: same },
    ];
    expect(pickSurvivingMemberRow(rows).id).toBe("id-a");
  });

  it("createdAt NULLS LAST: a dated row beats a NULL-createdAt row of equal role", () => {
    const rows: MemberDedupRow[] = [
      { id: "null-row", role: "member", createdAt: null },
      { id: "dated-row", role: "member", createdAt: d("2030-01-01T00:00:00Z") },
    ];
    // Even a far-future dated row outranks NULL createdAt.
    expect(pickSurvivingMemberRow(rows).id).toBe("dated-row");
  });

  it("two NULL-createdAt rows of equal role: lowest id wins", () => {
    const rows: MemberDedupRow[] = [
      { id: "y", role: "member", createdAt: null },
      { id: "x", role: "member", createdAt: null },
    ];
    expect(pickSurvivingMemberRow(rows).id).toBe("x");
  });

  it("accepts ISO-string createdAt the way pg returns timestamps", () => {
    const rows: MemberDedupRow[] = [
      { id: "later", role: "owner", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "earlier", role: "owner", createdAt: "2021-01-01T00:00:00.000Z" },
    ];
    expect(pickSurvivingMemberRow(rows).id).toBe("earlier");
  });

  it("throws on an empty partition (unreachable in the SQL, fail-loud in JS)", () => {
    expect(() => pickSurvivingMemberRow([])).toThrow(/empty partition/);
  });
});

describe("compareMemberDedup", () => {
  it("is a total order consistent with pickSurvivingMemberRow", () => {
    const rows: MemberDedupRow[] = [
      { id: "c", role: "member", createdAt: new Date("2024-01-01T00:00:00Z") },
      { id: "a", role: "owner", createdAt: new Date("2024-01-01T00:00:00Z") },
      { id: "b", role: "admin", createdAt: new Date("2024-01-01T00:00:00Z") },
    ];
    const sorted = [...rows].sort(compareMemberDedup).map((r) => r.id);
    expect(sorted).toEqual(["a", "b", "c"]);
    // Surviving (rn=1) row is the sort head.
    expect(pickSurvivingMemberRow(rows).id).toBe(sorted[0]);
  });
});

// String-set equality guard for the co-owner constraint DDL leaf
// (src/lib/co-owner-constraint-schema.ts).
//
// The skill_package_co_owners + skill_co_owners post-CREATE index + FK-
// constraint-repair DDL was extracted VERBATIM out of
// buildCreateStoreSchemaQueries into a pure-strings leaf to relieve the
// drizzle-store.ts file-size ratchet. This is a NO-BEHAVIOUR-CHANGE move: the
// emitted DDL sequence must be byte-identical. This test locks that contract so
// a future edit to either the leaf or the spread site cannot silently drift the
// bootstrap DDL:
//   1. each leaf function returns exactly the expected statement shape/count;
//   2. the leaf output appears as a CONTIGUOUS, ORDERED subsequence inside
//      buildCreateStoreSchemaQueries — immediately after its own CREATE TABLE.
import { describe, expect, it } from "vitest";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  skillPackageCoOwnerConstraintQueries,
  skillCoOwnerConstraintQueries,
} from "@/lib/co-owner-constraint-schema";

const SCHEMA = "cinatra_coowner_test";

/** Index of the contiguous run of `needle` inside `hay`, or -1. */
function subsequenceStart(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe("co-owner constraint DDL leaf", () => {
  const all = buildCreateStoreSchemaQueries(SCHEMA).map((q) => q.text);
  const pkg = skillPackageCoOwnerConstraintQueries(SCHEMA).map((q) => q.text);
  const skill = skillCoOwnerConstraintQueries(SCHEMA).map((q) => q.text);

  it("each leaf emits its index + one FK-repair DO block", () => {
    expect(pkg).toHaveLength(2);
    expect(skill).toHaveLength(2);
    expect(pkg[0]).toContain("skill_package_co_owners_user_id_idx");
    expect(pkg[1]).toContain("skill_package_co_owners_package_id_fkey");
    expect(skill[0]).toContain("skill_co_owners_user_id_idx");
    expect(skill[1]).toContain("skill_co_owners_skill_id_fkey");
  });

  it("leaf output is a contiguous ordered subsequence of the bootstrap DDL", () => {
    const pkgAt = subsequenceStart(all, pkg);
    const skillAt = subsequenceStart(all, skill);
    expect(pkgAt).toBeGreaterThanOrEqual(0);
    expect(skillAt).toBeGreaterThanOrEqual(0);
    // pkg run sits right after the skill_package_co_owners CREATE TABLE.
    expect(all[pkgAt - 1]).toContain(`."skill_package_co_owners" (`);
    // skill run sits right after the skill_co_owners CREATE TABLE, and after pkg.
    expect(all[skillAt - 1]).toContain(`."skill_co_owners" (`);
    expect(skillAt).toBeGreaterThan(pkgAt);
  });
});

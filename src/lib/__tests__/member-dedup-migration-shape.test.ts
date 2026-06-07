// Byte-shape guard for the member dedup migration SQL.
//
// member-dedup-ranking.test.ts asserts the JS *mirror* of the ranking; this
// file asserts the actual production SQL emitted by buildCreateStoreSchemaQueries
// so the synthetic ranking test can't stay green while the real migration
// drifts. Matches against the joined query batch (NOT a snapshot file — those
// rot on whitespace).

import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

function batchText(): string {
  return buildCreateStoreSchemaQueries("cinatra_test")
    .map((q) => q.text)
    .join("\n");
}

describe("member dedup migration SQL shape", () => {
  const sql = batchText();

  it("gates the dedup on the unique index not yet existing", () => {
    expect(sql).toMatch(/IF to_regclass\('public\.member_org_user_uniq'\) IS NULL THEN/);
  });

  it("partitions by (organizationId, userId) with a ROW_NUMBER window", () => {
    expect(sql).toMatch(
      /ROW_NUMBER\(\) OVER \(\s*PARTITION BY "organizationId", "userId"/,
    );
  });

  it("ranks role by MAX over comma-split tokens (Better Auth multi-role safe)", () => {
    // role_rank is computed in an inner CTE as the MAX known-token rank after
    // comma-splitting + trimming, so 'owner,admin' ranks as owner. Ranking the
    // raw string would delete the owner-capable row.
    expect(sql).toMatch(/unnest\(string_to_array\(role, ','\)\) AS tok/);
    expect(sql).toMatch(
      /MAX\(CASE trim\(tok\)\s*WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 WHEN 'member' THEN 1 ELSE 0 END\)/,
    );
    // COALESCE to 0 so a NULL role (string_to_array → no rows) ranks as 0.
    expect(sql).toMatch(/COALESCE\(\(\s*SELECT MAX\(CASE trim\(tok\)/);
  });

  it("orders by role_rank DESC, then createdAt ASC NULLS LAST, then id ASC", () => {
    expect(sql).toMatch(
      /ORDER BY role_rank DESC, "createdAt" ASC NULLS LAST, id ASC/,
    );
  });

  it("deletes the non-surviving rows via a DELETE CTE returning ids", () => {
    expect(sql).toMatch(
      /DELETE FROM public\."member" WHERE id IN \(SELECT id FROM ranked WHERE rn > 1\) RETURNING id/,
    );
  });

  it("emits an auditable RAISE WARNING with the deleted count (does not fail loud)", () => {
    expect(sql).toMatch(
      /RAISE WARNING 'v6\.24 dedup: deleted % duplicate member rows', deleted_count/,
    );
    // Must NOT escalate to an exception on count > 0.
    expect(sql).not.toMatch(/RAISE EXCEPTION 'v6\.24 dedup/);
  });

  it("creates the non-deferrable unique index after the dedup", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uniq ON public\."member" \("organizationId", "userId"\)/,
    );
    // ON CONFLICT needs a non-deferrable arbiter.
    expect(sql).not.toMatch(/member_org_user_uniq[\s\S]*DEFERRABLE/);
    // Dedup DELETE must precede the index creation in the batch.
    const dedupIdx = sql.indexOf("WHERE rn > 1) RETURNING id");
    const createIdx = sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uniq");
    expect(dedupIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(dedupIdx);
  });
});

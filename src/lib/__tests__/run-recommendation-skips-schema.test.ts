// DDL parity for `run_recommendation_skips` (cinatra#2794 S9b).
//
// The table has TWO homes that must agree: the fresh-install bootstrap DDL
// (`runRecommendationSkipsSchemaQueries`, spread into
// `buildCreateStoreSchemaQueries`) and the operator-upgrade migration
// (`migrations/core/core__0095`). A fresh install that gets the table while an
// upgraded instance does not is not a cosmetic split-brain here: the marker
// write is the RELEASE GATE for a skip, so on an instance without the table
// every skip would fail verification and refuse, and the run-start hold would
// become undecidable.
//
// This suite pins the SHAPE so a drift is caught without a database. The
// behavioural proof that a marker is genuinely COMMITTED (and that a legitimate
// skill id `__run_level_skip__` stays readable beside it) runs against a real
// Postgres in
// `packages/agents/src/__tests__/run-recommendation-skip-record.integration.test.ts`.
import { describe, expect, it } from "vitest";

import {
  RUN_RECOMMENDATION_SKIPS_SKIPPED_AT_INDEX,
  RUN_RECOMMENDATION_SKIPS_TABLE,
  runRecommendationSkipsSchemaQueries,
} from "@/lib/artifacts/artifact-review-gate-schema";
import { runRecommendationSkipsDdlSql } from "../../../migrations/core/core__0095_run-recommendation-skip-record.mjs";

const bootstrap = runRecommendationSkipsSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

const BOTH: Array<[string, string]> = [
  ["fresh-install bootstrap", bootstrap],
  ["operator-upgrade migration", runRecommendationSkipsDdlSql],
];

describe("run_recommendation_skips — DDL parity between the two homes", () => {
  it.each(BOTH)("%s creates the table idempotently", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(`CREATE TABLE IF NOT EXISTS[^(]*${RUN_RECOMMENDATION_SKIPS_TABLE}`),
    );
  });

  it.each(BOTH)("%s keys the marker on the RUN ALONE", (_name, sql) => {
    // The whole point of the table: a skip that names no skill still has a row.
    // The PK is also what makes a retried decision converge instead of
    // duplicating.
    expect(sql).toMatch(/run_id\s+text PRIMARY KEY/);
  });

  it.each(BOTH)("%s records who decided and how much was offered", (_name, sql) => {
    // Always known — the skip path is fail-closed on run.runBy === the session.
    expect(sql).toMatch(/skipped_by\s+text NOT NULL/);
    // The fact the sentinel row destroyed: 0 = drift left nothing to name.
    expect(sql).toMatch(/candidate_count integer NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/skipped_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it.each(BOTH)("%s carries NO foreign key to agent_runs", (_name, sql) => {
    // Deliberate, on the sibling precedent (run_selected_skill_revisions /
    // run_rejected_recommendations both carry a bare run_id). Behavioural
    // reason too: a failed marker write REFUSES the skip, so an FK would turn a
    // concurrently-deleted run into a user-visible refusal.
    expect(sql).not.toMatch(/REFERENCES/i);
  });

  it.each(BOTH)("%s indexes the recency lookup", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS ${RUN_RECOMMENDATION_SKIPS_SKIPPED_AT_INDEX}[\\s\\S]*\\(skipped_at DESC\\)`,
      ),
    );
  });

  it("qualifies the bootstrap form with the app schema and leaves the migration bare", () => {
    expect(runRecommendationSkipsSchemaQueries("cinatra")[0]!.text).toContain(
      `"cinatra"."${RUN_RECOMMENDATION_SKIPS_TABLE}"`,
    );
    // The runner sets search_path, so the migration must NOT hard-code a schema.
    expect(runRecommendationSkipsDdlSql).not.toContain('"cinatra"');
  });

  it("escapes a quote in the schema identifier", () => {
    expect(runRecommendationSkipsSchemaQueries('we"ird')[0]!.text).toContain('"we""ird"');
  });

  it("is spread into the canonical bootstrap so a fresh install is born with it", async () => {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const all = buildCreateStoreSchemaQueries("cinatra")
      .map((q) => q.text)
      .join("\n");
    expect(all).toContain(RUN_RECOMMENDATION_SKIPS_TABLE);
  });
});

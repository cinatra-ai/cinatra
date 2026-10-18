// DDL parity for `run_context_answers` (cinatra#3080).
//
// The table has TWO homes that must agree: the fresh-install bootstrap DDL
// (`runContextAnswersSchemaQueries`, spread into `buildCreateStoreSchemaQueries`
// through the audit table's own leaf) and the operator-upgrade migration
// (`migrations/core/core__0113`). An upgraded instance without the table would
// fail every context finalize, because finalize now records the whole answer
// in the same transaction as its audit rows.
//
// This suite pins the SHAPE without a database. The behavioural proof — the
// answer recorded by finalize, the latest one inherited by a repair, the
// migration on a database from before it — runs against a real Postgres in
// `packages/agents/src/__tests__/context-repair-inheritance-3080.integration.test.ts`.
import { describe, expect, it } from "vitest";

import {
  RUN_CONTEXT_ANSWERS_TABLE,
  runContextAnswersSchemaQueries,
  runContextSelectionsSchemaQueries,
} from "@/lib/artifact-claim-schema";
import {
  down,
  runContextAnswersDdlSql,
  up,
} from "../../../migrations/core/core__0113_run-context-answers.mjs";

const bootstrap = runContextAnswersSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

const BOTH: Array<[string, string]> = [
  ["fresh-install bootstrap", bootstrap],
  ["operator-upgrade migration", runContextAnswersDdlSql],
];

/** What a migration step hands the runner, read through a stand-in builder
 *  that only records `pgm.sql` (the one builder call these steps make). */
function collect(step: unknown): string {
  const out: string[] = [];
  (step as (pgm: { sql: (text: string) => void }) => void)({ sql: (text) => out.push(text) });
  return out.join("\n");
}

describe("run_context_answers — DDL parity between the two homes", () => {
  it.each(BOTH)("%s creates the table idempotently", (_name, sql) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS[^(]*${RUN_CONTEXT_ANSWERS_TABLE}`));
  });

  it.each(BOTH)("%s records the WHOLE ordered answer of one finalize, an empty one included", (_name, sql) => {
    expect(sql).toMatch(/refs\s+jsonb NOT NULL/);
    expect(sql).toContain("CHECK (jsonb_typeof(refs) = 'array')");
    expect(sql).toMatch(/parent_package_name\s+text NOT NULL/);
    expect(sql).toMatch(/selected_by\s+text NOT NULL/);
    expect(sql).toMatch(/selection_mode\s+text NOT NULL/);
  });

  it.each(BOTH)("%s orders answers by a per-slot sequence, unique per (org, run, slot), never by the clock", (_name, sql) => {
    expect(sql).toMatch(/answer_seq\s+integer NOT NULL/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS rca_run_slot_seq_idx[\s\S]*\(org_id, parent_run_id, slot_id, answer_seq\)/,
    );
  });

  it.each(BOTH)("%s is append-only", (_name, sql) => {
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON");
    expect(sql).toContain("run_context_answers is append-only");
  });

  it.each(BOTH)("%s touches no other table and backfills nothing", (_name, sql) => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b|\bUPDATE\s+\S+\s+SET\b|\bALTER TABLE\b/i);
    expect(sql).not.toContain("run_context_selections");
  });

  it("qualifies the bootstrap form with the app schema and leaves the migration bare", () => {
    expect(runContextAnswersSchemaQueries("cinatra")[0]!.text).toContain(
      `"cinatra"."${RUN_CONTEXT_ANSWERS_TABLE}"`,
    );
    expect(runContextAnswersDdlSql).not.toContain('"cinatra"');
    expect(runContextAnswersSchemaQueries('we"ird')[0]!.text).toContain('"we""ird"');
  });

  it("rides the audit table's own leaf, so a fresh install is born with it", async () => {
    expect(
      runContextSelectionsSchemaQueries("cinatra")
        .map((q) => q.text)
        .join("\n"),
    ).toContain(`"cinatra"."${RUN_CONTEXT_ANSWERS_TABLE}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const all = buildCreateStoreSchemaQueries("cinatra")
      .map((q) => q.text)
      .join("\n");
    expect(all).toContain(RUN_CONTEXT_ANSWERS_TABLE);
  });

  it("migrates up with the parity DDL and down only over an EMPTY table", () => {
    expect(collect(up)).toBe(runContextAnswersDdlSql);
    const reverted = collect(down);
    expect(reverted).toMatch(/IF EXISTS \(SELECT 1 FROM run_context_answers\) THEN\s+RAISE EXCEPTION/);
    expect(reverted).toContain("DROP TABLE run_context_answers");
  });
});

/**
 * cinatra#2911 — the bootstrap SQL that decides whether `agent_runs.created_at`
 * survives a cold init.
 *
 * `created_at` records when a run was REQUESTED; the insert default is its only
 * legitimate writer. The bootstrap list used to carry an UNGUARDED whole-table
 * `UPDATE … SET created_at = COALESCE(started_at, completed_at, created_at)`,
 * and that list is replayed once per fresh server process — so a run that had
 * since started came back with `started_at` as its creation time and a run that
 * failed before starting came back with `completed_at`, its own end time.
 *
 * These are TEXT assertions on the builder (no database), so the guard cannot be
 * dropped without a red here. The behavioural proof against a real Postgres —
 * insert, replay, assert unchanged — lives in
 * `agent-run-created-at-immutable.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { agentRunCreatedAtSchemaQueries } from "@/lib/agent-run-created-at-schema";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

const SCHEMA = "cinatra_test_schema";
const stmts = agentRunCreatedAtSchemaQueries(SCHEMA).map((q) => q.text);

/** Every statement in the whole bootstrap list that WRITES agent_runs.created_at. */
function bootstrapCreatedAtWrites(): string[] {
  return buildCreateStoreSchemaQueries(SCHEMA)
    .map((q) => q.text)
    .filter((t) => /\bagent_runs\b/.test(t) && /\bSET\s+created_at\b/i.test(t));
}

describe("agent_runs.created_at bootstrap DDL (cinatra#2911)", () => {
  it("emits add-column, guarded backfill, finalize — in that order", () => {
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/ADD COLUMN IF NOT EXISTS created_at timestamptz/);
    expect(stmts[1]).toMatch(/^UPDATE\b/);
    expect(stmts[2]).toMatch(/ALTER COLUMN created_at/);
  });

  it("adds the column NULLABLE and WITHOUT a default — the only way a missing value stays distinguishable", () => {
    // A default would make PostgreSQL fill every existing row with it, so no row
    // would be NULL and the guard below would have nothing to narrow on.
    expect(stmts[0]).not.toMatch(/\bDEFAULT\b/i);
    expect(stmts[0]).not.toMatch(/\bNOT\s+NULL\b/i);
  });

  it("backfills ONLY a NULL created_at — a present value is never recomputed", () => {
    expect(stmts[1]).toMatch(/WHERE created_at IS NULL$/);
    // The source columns are the run's own later-populated timestamps; the
    // fallback is now(), never created_at itself.
    expect(stmts[1]).toMatch(/COALESCE\(started_at, completed_at, now\(\)\)/);
  });

  it("restores the deployed shape after the backfill: DEFAULT now() and NOT NULL", () => {
    expect(stmts[2]).toMatch(/SET DEFAULT now\(\)/);
    expect(stmts[2]).toMatch(/SET NOT NULL/);
  });

  it("quotes the schema identifier, doubling an embedded quote", () => {
    for (const text of agentRunCreatedAtSchemaQueries('we"ird').map((q) => q.text)) {
      expect(text).toContain('"we""ird"."agent_runs"');
    }
  });

  it("the whole bootstrap list contains no UNGUARDED created_at rewrite", () => {
    const writes = bootstrapCreatedAtWrites();
    // Non-vacuous: the guarded backfill IS in the list.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/WHERE created_at IS NULL$/);
  });

  it("is spread into the bootstrap list ahead of the index that orders by created_at", () => {
    const texts = buildCreateStoreSchemaQueries(SCHEMA).map((q) => q.text);
    const addIdx = texts.findIndex((t) =>
      /agent_runs" ADD COLUMN IF NOT EXISTS created_at/.test(t),
    );
    const indexIdx = texts.findIndex((t) =>
      /agent_runs_source_lookup_idx/.test(t),
    );
    expect(addIdx).toBeGreaterThan(-1);
    expect(indexIdx).toBeGreaterThan(addIdx);
  });
});

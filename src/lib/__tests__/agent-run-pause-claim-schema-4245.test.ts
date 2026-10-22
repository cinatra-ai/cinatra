/**
 * cinatra#4245 PR A1: the pause claim columns, inert.
 *
 * The operator upgrade (core__0116) and the fresh-install bootstrap must give a
 * database the same four agent_runs columns, the same two CHECKs and the same
 * lifecycle_repair column; Drizzle must declare what the DDL creates. No
 * database is started here: the DB tier beside this file applies the DDL.
 *
 * Red at main: the migration module and the bootstrap leaf export do not exist.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentRuns, lifecycleRepair } from "../../../packages/agents/src/schema";
import { agentRunPauseClaimSchemaQueries } from "../agent-run-created-at-schema";
import { lifecycleRepairSchemaQueries } from "../artifacts/artifact-review-gate-schema";
import { buildCreateStoreSchemaQueries } from "../drizzle-store";
import * as migration from "../../../migrations/core/core__0116_agent-run-pause-claim.mjs";
import { readManifestUnion } from "../../../migrations/manifest-reader.mjs";

const FIXTURE = "cinatra_fixture";
const normalized = (sql: string) =>
  sql
    .replaceAll(`"${FIXTURE}".`, "")
    .replaceAll('"agent_runs"', "agent_runs")
    .replaceAll('"lifecycle_repair"', "lifecycle_repair")
    .replaceAll(/\s+/g, " ")
    .trim();

const operatorUp = (): string[] => {
  const sql = vi.fn();
  migration.up({ sql });
  return sql.mock.calls.map((call) => String(call[0]));
};
const repairColumnLine = (schema: string) =>
  lifecycleRepairSchemaQueries(schema).map((row) => row.text).filter((text) => text.includes("paused_run_generation"));

describe("pause claim columns: Drizzle declares what the DDL creates (cinatra#4245)", () => {
  it("declares the generation as a non-null bigint number defaulting to 0, and the claim triple nullable", () => {
    expect(agentRuns.pauseGeneration.name).toBe("pause_generation");
    expect(agentRuns.pauseGeneration.getSQLType()).toBe("bigint");
    expect(agentRuns.pauseGeneration.notNull).toBe(true);
    expect(agentRuns.pauseGeneration.default).toBe(0);
    expect(agentRuns.pauseGeneration.dataType).toBe("number");
    expect([agentRuns.pauseClaimToken.name, agentRuns.pauseClaimPhase.name, agentRuns.pauseClaimExpiresAt.name])
      .toEqual(["pause_claim_token", "pause_claim_phase", "pause_claim_expires_at"]);
    for (const column of [agentRuns.pauseClaimToken, agentRuns.pauseClaimPhase, agentRuns.pauseClaimExpiresAt]) {
      expect(column.notNull).toBe(false);
    }
    expect(agentRuns.pauseClaimExpiresAt.getSQLType()).toBe("timestamp with time zone");
    expect(lifecycleRepair.pausedRunGeneration.name).toBe("paused_run_generation");
    expect(lifecycleRepair.pausedRunGeneration.getSQLType()).toBe("bigint");
    expect(lifecycleRepair.pausedRunGeneration.notNull).toBe(false);
  });
});

describe("pause claim columns: operator upgrade and bootstrap parity (cinatra#4245)", () => {
  it("core__0116 up emits exactly the bootstrap leaf's statements, then the lifecycle_repair column", () => {
    const operator = operatorUp().map(normalized);
    const bootstrap = [
      ...agentRunPauseClaimSchemaQueries(FIXTURE).map((row) => row.text),
      ...repairColumnLine(FIXTURE),
    ].map(normalized);
    expect(operator).toHaveLength(4);
    expect(operator).toEqual(bootstrap);
  });

  it("adds every column with IF NOT EXISTS and each CHECK only while pg_constraint lacks its name", () => {
    const [columns, phase, shape, repair] = operatorUp();
    for (const name of ["pause_generation bigint NOT NULL DEFAULT 0", "pause_claim_token text", "pause_claim_phase text", "pause_claim_expires_at timestamptz"]) {
      expect(columns).toContain(`ADD COLUMN IF NOT EXISTS ${name}`);
    }
    expect(repair).toBe("ALTER TABLE lifecycle_repair ADD COLUMN IF NOT EXISTS paused_run_generation bigint");
    for (const [stmt, name] of [[phase, "agent_runs_pause_claim_phase_chk"], [shape, "agent_runs_pause_claim_shape_chk"]] as const) {
      expect(normalized(stmt)).toMatch(new RegExp(`IF NOT EXISTS \\( SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'agent_runs'::regclass \\) THEN ALTER TABLE agent_runs ADD CONSTRAINT ${name} CHECK`));
    }
    expect(phase).toContain("CHECK (pause_claim_phase IS NULL OR pause_claim_phase IN ('claimed','sending','changes_requested'))");
    expect(shape).toContain(
      "CHECK ((pause_claim_token IS NULL) = (pause_claim_phase IS NULL) AND (pause_claim_phase IS NULL OR (pause_claim_phase = 'changes_requested') = (pause_claim_expires_at IS NULL)))",
    );
    for (const stmt of operatorUp()) expect(stmt).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|TRUNCATE|DROP|CASCADE|REFERENCES)\b/i);
  });

  it("the actual bootstrap carries each statement once, after the table it alters is created", () => {
    const all = buildCreateStoreSchemaQueries(FIXTURE).map((row) => row.text);
    const runs = all.findIndex((row) => row.startsWith(`CREATE TABLE IF NOT EXISTS "${FIXTURE}"."agent_runs"`));
    const repairs = all.findIndex((row) => row.startsWith(`CREATE TABLE IF NOT EXISTS "${FIXTURE}"."lifecycle_repair"`));
    expect(runs).toBeGreaterThan(-1);
    expect(repairs).toBeGreaterThan(-1);
    for (const stmt of agentRunPauseClaimSchemaQueries(FIXTURE).map((row) => row.text)) {
      expect(all.filter((row) => row === stmt)).toHaveLength(1);
      expect(all.indexOf(stmt)).toBeGreaterThan(runs);
    }
    const [repairLine] = repairColumnLine(FIXTURE);
    expect(all.filter((row) => row === repairLine)).toHaveLength(1);
    expect(all.indexOf(repairLine)).toBeGreaterThan(repairs);
  });

  it("quotes the schema in identifier and literal positions", () => {
    for (const text of agentRunPauseClaimSchemaQueries('we"ird').map((row) => row.text)) {
      expect(text).toContain('ALTER TABLE "we""ird"."agent_runs"');
    }
    for (const text of agentRunPauseClaimSchemaQueries("we'ird").map((row) => row.text).slice(1)) {
      expect(text).toContain(`conrelid = '"we''ird"."agent_runs"'::regclass`);
    }
    expect(repairColumnLine(`we"ird`)).toEqual([`ALTER TABLE "we""ird"."lifecycle_repair" ADD COLUMN IF NOT EXISTS paused_run_generation bigint`]);
  });
});

describe("pause claim columns: rollback and ledger (cinatra#4245)", () => {
  it("down drops the two constraints first, then exactly the five new columns", () => {
    const sql = vi.fn();
    migration.down({ sql });
    const statements = sql.mock.calls.map((call) => String(call[0]));
    expect(statements).toEqual([
      "ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_pause_claim_shape_chk, DROP CONSTRAINT IF EXISTS agent_runs_pause_claim_phase_chk",
      "ALTER TABLE agent_runs DROP COLUMN IF EXISTS pause_claim_expires_at, DROP COLUMN IF EXISTS pause_claim_phase, DROP COLUMN IF EXISTS pause_claim_token, DROP COLUMN IF EXISTS pause_generation",
      "ALTER TABLE lifecycle_repair DROP COLUMN IF EXISTS paused_run_generation",
    ]);
  });

  it("ships its manifest fragment naming the module and both tables", () => {
    const { entries, errors } = readManifestUnion(path.resolve(__dirname, "../../../migrations"));
    expect(errors).toEqual([]);
    const entry = entries.find((row: Record<string, unknown>) => row.seq === "0116");
    expect(entry?.file).toBe("core/core__0116_agent-run-pause-claim.mjs");
    expect(entry?.tables).toEqual(["agent_runs", "lifecycle_repair"]);
    // The convention counts a NOT NULL column and a CHECK on an existing table
    // as user-land-affecting, so the fragment says so (schema-migration-gate).
    expect(entry?.destructive).toBe(true);
  });
});

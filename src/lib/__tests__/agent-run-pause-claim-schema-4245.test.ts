/**
 * cinatra#4245 PR A1: the pause claim columns, inert.
 *
 * The operator upgrade (core__0116) and the fresh-install bootstrap must give a
 * database the same four agent_runs columns, the same two CHECKs and the same
 * lifecycle_repair column; Drizzle must declare what the DDL creates. No
 * database is started here: the DB tier beside this file applies the DDL.
 *
 * Red at main: the migration module and the bootstrap leaf export do not exist.
 *
 * Pre-1 fold (each red at b128ee97): the shape CHECK refuses an orphan expiry
 * (C1/C6); up runs outside a transaction, adds each CHECK NOT VALID and
 * validates it in its own statement (C4); the regclass text survives a schema
 * name holding a double quote (C5).
 *
 * Pre-2 fold (red at 675c2bfc): up bounds every lock wait with lock_timeout,
 * set first and reset last.
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
  migration.up({ sql, noTransaction: vi.fn() });
  return sql.mock.calls.map((call) => String(call[0]));
};
/** The DDL of up, without the lock_timeout SET before it and the RESET after it. */
const operatorDdl = (): string[] => operatorUp().slice(1, -1);
const PHASE_CHK = "agent_runs_pause_claim_phase_chk";
const SHAPE_CHK = "agent_runs_pause_claim_shape_chk";
const SHAPE_SQL =
  "(pause_claim_token IS NULL AND pause_claim_phase IS NULL AND pause_claim_expires_at IS NULL) OR (pause_claim_token IS NOT NULL AND pause_claim_phase IS NOT NULL AND (pause_claim_phase = 'changes_requested') = (pause_claim_expires_at IS NULL))";

// Evaluates the shape CHECK text over one row without a database, in SQL's
// three-valued logic (NULL is `null`), for the subset the CHECK uses: OR, AND,
// boolean `=`, `col IS [NOT] NULL` and `col = 'literal'`. A CHECK admits a row
// unless the expression is FALSE. The DB tier beside this file proves the same
// matrix on a real Postgres.
type Tri = boolean | null;
function shapeAdmits(checkSql: string, row: Record<string, string | null>): boolean {
  const tokens = checkSql.match(/\(|\)|=|'[^']*'|[A-Za-z_]+/g) ?? [];
  expect(tokens.join("")).toBe(checkSql.replaceAll(/\s+/g, ""));
  let at = 0;
  const take = (want?: string): string => {
    const token = tokens[at++] ?? "";
    if (want !== undefined) expect(token).toBe(want);
    return token;
  };
  const or = (): Tri => {
    const parts = [and()];
    while (tokens[at] === "OR") { take(); parts.push(and()); }
    return parts.includes(true) ? true : parts.includes(null) ? null : false;
  };
  const and = (): Tri => {
    const parts = [eq()];
    while (tokens[at] === "AND") { take(); parts.push(eq()); }
    return parts.includes(false) ? false : parts.includes(null) ? null : true;
  };
  const eq = (): Tri => {
    const left = prim();
    if (tokens[at] !== "=") return left;
    take();
    const right = prim();
    return left === null || right === null ? null : left === right;
  };
  const prim = (): Tri => {
    if (tokens[at] === "(") { take(); const inner = or(); take(")"); return inner; }
    const column = take();
    expect(Object.keys(row)).toContain(column);
    const value = row[column];
    if (tokens[at] === "IS") {
      take();
      const negated = tokens[at] === "NOT";
      if (negated) take();
      take("NULL");
      return negated ? value !== null : value === null;
    }
    take("=");
    const literal = take();
    expect(literal).toMatch(/^'[^']*'$/);
    return value === null ? null : value === literal.slice(1, -1);
  };
  const verdict = or();
  expect(at).toBe(tokens.length);
  return verdict !== false;
}
const lease = (token: string | null, phase: string | null, expiry: string | null) =>
  ({ pause_claim_token: token, pause_claim_phase: phase, pause_claim_expires_at: expiry });
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
    const operator = operatorDdl().map(normalized);
    const bootstrap = [
      ...agentRunPauseClaimSchemaQueries(FIXTURE).map((row) => row.text),
      ...repairColumnLine(FIXTURE),
    ].map(normalized);
    expect(operator).toHaveLength(6);
    expect(operator).toEqual(bootstrap);
  });

  it("adds every column with IF NOT EXISTS and each CHECK only while pg_constraint lacks its name", () => {
    const [columns, phase, shape, , , repair] = operatorDdl();
    for (const name of ["pause_generation bigint NOT NULL DEFAULT 0", "pause_claim_token text", "pause_claim_phase text", "pause_claim_expires_at timestamptz"]) {
      expect(columns).toContain(`ADD COLUMN IF NOT EXISTS ${name}`);
    }
    expect(repair).toBe("ALTER TABLE lifecycle_repair ADD COLUMN IF NOT EXISTS paused_run_generation bigint");
    const [, , , validatePhase, validateShape] = operatorDdl();
    for (const [stmt, name] of [[phase, PHASE_CHK], [shape, SHAPE_CHK]] as const) {
      expect(normalized(stmt)).toMatch(new RegExp(`IF NOT EXISTS \\( SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'agent_runs'::regclass \\) THEN ALTER TABLE agent_runs ADD CONSTRAINT ${name} CHECK`));
    }
    for (const [stmt, name] of [[validatePhase, PHASE_CHK], [validateShape, SHAPE_CHK]] as const) {
      expect(normalized(stmt)).toBe(
        `DO $$ BEGIN IF EXISTS ( SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'agent_runs'::regclass AND NOT convalidated ) THEN ALTER TABLE agent_runs VALIDATE CONSTRAINT ${name}; END IF; END $$`,
      );
    }
    expect(phase).toContain("CHECK (pause_claim_phase IS NULL OR pause_claim_phase IN ('claimed','sending','changes_requested')) NOT VALID;");
    expect(shape).toContain(`CHECK (${SHAPE_SQL}) NOT VALID;`);
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
    // Pre-1 C5: the regclass text is a quoted identifier inside a literal, so
    // a double quote is doubled for the identifier first (team"blue).
    for (const [schema, rel] of [['team"blue', `'"team""blue"."agent_runs"'`], [`a"b'c`, `'"a""b''c"."agent_runs"'`]] as const) {
      const guarded = agentRunPauseClaimSchemaQueries(schema).map((row) => row.text).slice(1);
      expect(guarded).toHaveLength(4);
      for (const text of guarded) expect(text).toContain(`conrelid = ${rel}::regclass`);
    }
    expect(repairColumnLine(`we"ird`)).toEqual([`ALTER TABLE "we""ird"."lifecycle_repair" ADD COLUMN IF NOT EXISTS paused_run_generation bigint`]);
  });
});

describe("pause claim columns: the shape CHECK admits exactly the lease shapes (pre-1 C1/C6)", () => {
  const ADMITTED = new Set(["-|-|-", "tok|claimed|ts", "tok|sending|ts", "tok|changes_requested|-"]);
  const leafShape = () => {
    const text = agentRunPauseClaimSchemaQueries(FIXTURE).map((row) => row.text).find((row) => row.includes(`ADD CONSTRAINT ${SHAPE_CHK}`));
    const match = /CHECK \(([\s\S]*)\) NOT VALID;/.exec(text ?? "");
    return match?.[1] ?? "";
  };

  it("operator and bootstrap carry the same shape text", () => {
    expect(migration.pauseClaimShapeCheckSql).toBe(SHAPE_SQL);
    expect(leafShape()).toBe(SHAPE_SQL);
  });

  it.each<[string, () => string]>([["the operator upgrade", () => migration.pauseClaimShapeCheckSql], ["the bootstrap", leafShape]])(
    "%s refuses an orphan expiry and every other shape outside the four lease shapes",
    (_label, read) => {
      const verdicts: string[] = [];
      for (const token of [null, "tok"]) {
        for (const phase of [null, "claimed", "sending", "changes_requested"]) {
          for (const expiry of [null, "ts"]) {
            const key = `${token ?? "-"}|${phase ?? "-"}|${expiry ?? "-"}`;
            if (shapeAdmits(read(), lease(token, phase, expiry))) verdicts.push(key);
          }
        }
      }
      expect(verdicts.sort()).toEqual([...ADMITTED].sort());
      expect(shapeAdmits(read(), lease(null, null, "ts"))).toBe(false);
    },
  );
});

describe("pause claim columns: no table scan under ACCESS EXCLUSIVE (pre-1 C4)", () => {
  it("up declares noTransaction, so each statement commits on its own", () => {
    const noTransaction = vi.fn();
    migration.up({ sql: vi.fn(), noTransaction });
    expect(noTransaction).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => string[]]>([["the operator upgrade", operatorUp], ["the bootstrap", () => agentRunPauseClaimSchemaQueries(FIXTURE).map((row) => row.text)]])(
    "%s adds each CHECK NOT VALID and validates it in a later, separate statement",
    (_label, statements) => {
      const all = statements();
      for (const name of [PHASE_CHK, SHAPE_CHK]) {
        const add = all.findIndex((stmt) => stmt.includes(`ADD CONSTRAINT ${name}`));
        const validate = all.findIndex((stmt) => stmt.includes(`VALIDATE CONSTRAINT ${name}`));
        expect(add).toBeGreaterThan(-1);
        expect(validate).toBeGreaterThan(add);
        expect(all[add]).toMatch(/\) NOT VALID;/);
        expect(all[add]).not.toContain("VALIDATE CONSTRAINT");
        expect(all[validate]).not.toContain("ADD ");
        expect(all[validate]).toContain("AND NOT convalidated");
      }
      // A validated CHECK is never added in one statement with the table lock.
      for (const stmt of all) {
        if (/ADD CONSTRAINT/.test(stmt)) expect(stmt).toMatch(/NOT VALID/);
      }
    },
  );
});

describe("pause claim columns: every lock wait is bounded (pre-2 fold)", () => {
  it("up sets lock_timeout first and resets it last, around exactly the DDL", () => {
    const all = operatorUp();
    expect(all).toHaveLength(8);
    expect(all[0]).toBe(`SET lock_timeout = ${migration.PAUSE_CLAIM_LOCK_TIMEOUT_MS}`);
    expect(all.at(-1)).toBe("RESET lock_timeout");
    expect(all.slice(1, -1)).toEqual(migration.pauseClaimDdlStatements);
    expect(all.filter((stmt) => /lock_timeout/.test(stmt))).toHaveLength(2);
  });

  it("the bound is 5 s, under a fifth of the application's 27 s server cancel", () => {
    // src/lib/db/pooled.ts: a pooled transaction's statement is cancelled at
    // 0.9 x the 30 s POSTGRES_ASYNC_TIMEOUT_MS default.
    const appServerCancelMs = 0.9 * 30_000;
    expect(migration.PAUSE_CLAIM_LOCK_TIMEOUT_MS).toBe(5_000);
    expect(migration.PAUSE_CLAIM_LOCK_TIMEOUT_MS).toBeLessThan(appServerCancelMs / 5);
  });

  it("the bootstrap leaf sets no lock_timeout of its own", () => {
    for (const { text } of agentRunPauseClaimSchemaQueries(FIXTURE)) expect(text).not.toMatch(/lock_timeout/);
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

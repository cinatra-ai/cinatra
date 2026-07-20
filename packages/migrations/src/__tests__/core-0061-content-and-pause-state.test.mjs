// core__0061 durable per-turn content + structured pause/resume state
// (cinatra#1037 P5.6 drop-history PR1 EXPAND) — SQL-builder shape + additive/
// idempotency assertions. Mirrors the core-0060 test idiom: assert the SQL shape
// (exported as data) without a live DB; the real apply + idempotency is exercised
// by the lane-DB migration proof.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(
    REPO_ROOT,
    "migrations",
    "core",
    "core__0061_assistant-turn-content-and-pause-state.mjs",
  )
);
const { readManifestUnion } = await import(
  path.join(REPO_ROOT, "migrations", "manifest-reader.mjs")
);

describe("core__0061 — module shape", () => {
  it("exports up/down + the DDL builders + the relation identifiers", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect(typeof mod.buildTurnContentColumnSql).toBe("function");
    expect(typeof mod.buildPauseStateTableSql).toBe("function");
    expect(mod.ASSISTANT_TURNS_TABLE).toBe("assistant_turns");
    expect(mod.ASSISTANT_TURN_CONTENT_COLUMN).toBe("content");
    expect(mod.ASSISTANT_THREAD_PAUSE_STATE_TABLE).toBe("assistant_thread_pause_state");
  });

  it("ships its append-only ledger fragment (union ledger seq 0061, ADDITIVE)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations"));
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0061");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe(
      "core/core__0061_assistant-turn-content-and-pause-state.mjs",
    );
    // Additive: a nullable column + a brand-new table — no user-land data
    // affected, so the gate does not require destructive: true.
    expect(entry?.destructive).toBe(false);
    expect(entry?.tables).toEqual([
      "assistant_turns",
      "assistant_thread_pause_state",
    ]);
  });
});

describe("core__0061 — durable content column", () => {
  const stmts = mod.buildTurnContentColumnSql();

  it("adds a NULLABLE jsonb column idempotently (never NOT NULL on existing data)", () => {
    const add = stmts[0];
    expect(add).toMatch(/ALTER TABLE assistant_turns ADD COLUMN IF NOT EXISTS content jsonb;/);
    expect(add).not.toMatch(/NOT NULL/);
  });

  it("guards the column to a JSON object when present (its required constraint)", () => {
    const check = stmts[1];
    expect(check).toMatch(/assistant_turns_content_object_check/);
    expect(check).toMatch(/jsonb_typeof\(content\) = 'object'/);
    expect(check).toMatch(/content IS NULL OR/);
    // add-constraint-if-absent (Postgres has no ADD CONSTRAINT IF NOT EXISTS)
    expect(check).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
  });
});

describe("core__0061 — structured pause/resume table", () => {
  const stmts = mod.buildPauseStateTableSql();

  it("creates the pause table idempotently with a (thread_id, participant_id) PK", () => {
    const create = stmts[0];
    expect(create).toMatch(
      /CREATE TABLE IF NOT EXISTS assistant_thread_pause_state/,
    );
    expect(create).toMatch(/PRIMARY KEY \(thread_id, participant_id\)/);
  });

  it("cascades from assistant_threads (FK added if absent)", () => {
    const fk = stmts[1];
    expect(fk).toMatch(/assistant_thread_pause_state_thread_id_fkey/);
    expect(fk).toMatch(
      /FOREIGN KEY \(thread_id\) REFERENCES assistant_threads \(id\) ON DELETE CASCADE/,
    );
  });

  it("indexes by thread for the per-thread read", () => {
    const idx = stmts[2];
    expect(idx).toMatch(
      /CREATE INDEX IF NOT EXISTS assistant_thread_pause_state_thread_idx ON assistant_thread_pause_state \(thread_id\)/,
    );
  });
});

describe("core__0061 — down() is a true additive reverse", () => {
  it("drops the pause table + the content column/CHECK (never throws)", () => {
    const sql = [];
    const pgm = { sql: (s) => sql.push(s) };
    expect(() => mod.down(pgm)).not.toThrow();
    const joined = sql.join("\n");
    expect(joined).toMatch(/DROP TABLE IF EXISTS assistant_thread_pause_state;/);
    expect(joined).toMatch(
      /ALTER TABLE assistant_turns DROP CONSTRAINT IF EXISTS assistant_turns_content_object_check;/,
    );
    expect(joined).toMatch(
      /ALTER TABLE assistant_turns DROP COLUMN IF EXISTS content;/,
    );
  });
});

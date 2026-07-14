// Contract test for the assistant handle registry migration
// (migrations/core/core__0046_assistant-handle-registry.mjs, cinatra#1037 P1.2).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — the
// registry table, the platform-unique handle index, a clean index-before-table
// reversal, and that the migration is STRUCTURAL ONLY (handles are populated by
// the runtime boot backfill, not by a SQL INSERT — the single collision-correct
// path). The real-Postgres execution is covered by scripts/ci/upgrade-proof.sh +
// the verify-stack boot proof.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0046_assistant-handle-registry.mjs";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

describe("core__0046 up()", () => {
  const stmts = collectSql(up as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();
  const normalized = joined.replace(/\s+/g, " ");

  it("creates the assistant_handles registry table idempotently", () => {
    expect(joined).toContain("create table if not exists assistant_handles");
  });

  it("carries the 1:1 principal key, handle, override flag, and timestamps", () => {
    expect(normalized).toContain("assistant_user_id text primary key");
    expect(normalized).toContain("handle text not null");
    expect(normalized).toContain("is_override boolean not null default false");
    expect(normalized).toContain("created_at timestamptz not null default now()");
    expect(normalized).toContain("updated_at timestamptz not null default now()");
  });

  it("makes the handle platform-unique via a unique index (idempotent)", () => {
    expect(joined).toContain("create unique index if not exists assistant_handles_handle_key");
    expect(joined).toContain("(handle)");
  });

  it("is STRUCTURAL ONLY — no SQL data backfill (handles are minted by the boot backfill)", () => {
    // A single collision-correct code path: the migration must not INSERT rows.
    expect(joined).not.toContain("insert into");
    expect(joined).not.toContain('public."user"');
    expect(joined).not.toContain("row_number");
  });
});

describe("core__0046 down()", () => {
  const stmts = collectSql(down as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("drops the unique index before the table (clean reversal)", () => {
    const idxAt = joined.indexOf("drop index if exists assistant_handles_handle_key");
    const tblAt = joined.indexOf("drop table if exists assistant_handles");
    expect(idxAt).toBeGreaterThanOrEqual(0);
    expect(tblAt).toBeGreaterThanOrEqual(0);
    expect(idxAt).toBeLessThan(tblAt);
  });
});

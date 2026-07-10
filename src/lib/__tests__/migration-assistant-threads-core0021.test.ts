// Contract test for the structured-threads migration
// (migrations/core/core__0021_assistant-threads-turns.mjs, cinatra#1037 P2a).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — the two
// tables, the FK + status/role CHECK invariants, the two read indexes, and a
// clean child-before-parent reversal. The real-Postgres execution of the chain
// against a non-fresh schema is covered by scripts/ci/upgrade-proof.sh.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0021_assistant-threads-turns.mjs";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

describe("core__0021 up()", () => {
  const stmts = collectSql(up as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("creates both tables idempotently", () => {
    expect(joined).toContain("create table if not exists assistant_threads");
    expect(joined).toContain("create table if not exists assistant_turns");
  });

  it("assistant_threads carries the principal, org/owner, context_id and timestamps", () => {
    const normalized = joined.replace(/\s+/g, " ");
    expect(normalized).toContain("assistant_user_id text");
    expect(normalized).toContain("owner_user_id text");
    expect(normalized).toContain("org_id text");
    expect(normalized).toContain("context_id text");
  });

  it("assistant_turns carries the turn↔run pointer (run_id) + principal attribution", () => {
    const normalized = joined.replace(/\s+/g, " ");
    expect(normalized).toContain("thread_id text not null");
    expect(normalized).toContain("run_id text");
    expect(normalized).toContain("assistant_user_id text");
  });

  it("adds the thread FK (ON DELETE CASCADE), guarded for idempotency", () => {
    expect(joined).toContain("assistant_turns_thread_id_fkey");
    expect(joined).toContain("references assistant_threads (id) on delete cascade");
    expect(joined).toContain("pg_constraint");
    expect(joined).toContain("current_schema()");
  });

  it("adds the status + role CHECK invariants", () => {
    expect(joined).toContain("assistant_turns_status_check");
    expect(joined).toContain("check (status in ('running', 'completed', 'error'))");
    expect(joined).toContain("assistant_turns_role_check");
    expect(joined).toContain("check (role in ('user', 'assistant'))");
  });

  it("creates both read indexes idempotently", () => {
    expect(joined).toContain("create index if not exists assistant_threads_org_updated_idx");
    expect(joined).toContain("create index if not exists assistant_turns_thread_created_idx");
  });

  it("uses unqualified table names (runner sets search_path to the app schema)", () => {
    expect(joined).not.toContain('"public"."assistant_threads"');
    expect(joined).not.toContain("public.assistant_turns");
  });
});

describe("core__0021 down()", () => {
  const stmts = collectSql(down as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("drops both indexes and both tables — all IF EXISTS", () => {
    expect(joined).toContain("drop index if exists assistant_turns_thread_created_idx");
    expect(joined).toContain("drop index if exists assistant_threads_org_updated_idx");
    expect(joined).toContain("drop table if exists assistant_turns");
    expect(joined).toContain("drop table if exists assistant_threads");
  });

  it("drops the child (FK-referencing) table before the parent", () => {
    const childIdx = joined.indexOf("drop table if exists assistant_turns");
    const parentIdx = joined.indexOf("drop table if exists assistant_threads");
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeGreaterThan(childIdx);
  });
});

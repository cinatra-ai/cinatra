// Contract test for the PR2 CUTOVER marker + legacy-write fence migration
// (migrations/core/core__0066_chat-threads-cutover-marker-and-fence.mjs,
// cinatra#1037 P5.6 drop-history PR2).
//
// The migration module is imported by RELATIVE PATH so the real SQL is exercised.
// Pure unit test (no DB): pins up()/down() — the operator-half columns/indexes,
// the cutover marker singleton table AND its activation, the BEFORE INSERT/UPDATE
// fence on chat_threads that keys off the marker via TG_TABLE_SCHEMA, and a
// STRUCTURAL down() reversal (lossy once post-cutover writes have landed — see
// the migration header). The real-Postgres apply/fence/idempotent/down behaviour
// is covered by the on-lane-DB proof in the PR2 verify stage.

import { describe, expect, it } from "vitest";

import {
  up,
  down,
  buildOperatorHalfColumnSql,
  buildCutoverMarkerTableSql,
  buildLegacyWriteFenceSql,
  buildCutoverMarkerActivationSql,
  CUTOVER_MARKER_TABLE,
  CHAT_THREADS_LEGACY_WRITE_FENCE_FUNCTION,
  CHAT_THREADS_LEGACY_WRITE_FENCE_TRIGGER,
} from "../../../migrations/core/core__0066_chat-threads-cutover-marker-and-fence.mjs";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

describe("core__0066 up()", () => {
  const stmts = collectSql(up as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("carries the operator-half ownership/ordering columns idempotently", () => {
    expect(joined).toContain("alter table assistant_threads add column if not exists project_id text");
    expect(joined).toContain("alter table assistant_threads add column if not exists team_id text");
    expect(joined).toContain("alter table assistant_threads add column if not exists origin text");
    expect(joined).toContain("alter table assistant_threads add column if not exists scalars jsonb");
    expect(joined).toContain("alter table assistant_turns add column if not exists ordinal integer");
  });

  it("guards the origin-discriminator domain CHECK behind an add-constraint-if-absent probe", () => {
    expect(joined).toContain("assistant_threads_origin_domain_check");
    expect(joined).toContain("origin in ('legacy-chat', 'assistant-native')");
    // additive: no backfill / no data rewrite of origin
    expect(joined).not.toContain("update assistant_threads set origin");
  });

  it("guards the scalars object CHECK behind an add-constraint-if-absent probe", () => {
    expect(joined).toContain("assistant_threads_scalars_object_check");
    expect(joined).toContain("jsonb_typeof(scalars) = 'object'");
    expect(joined).toContain("current_schema()"); // absent-constraint probe, not a blind ADD
  });

  it("carries the two PARTIAL ownership indexes (non-null project_id / team_id only)", () => {
    expect(joined).toContain("create index if not exists assistant_threads_project_updated_idx");
    expect(joined).toContain("where project_id is not null");
    expect(joined).toContain("create index if not exists assistant_threads_team_updated_idx");
    expect(joined).toContain("where team_id is not null");
  });

  it("creates the cutover marker singleton table AND activates it (owner ruling 2026-07-21 final teardown)", () => {
    expect(joined).toContain("create table if not exists assistant_cutover_marker");
    expect(joined).toContain("assistant_cutover_marker_singleton");
    expect(joined).toContain("check (id)");
    // The write surface is chat_threads-clean, so the marker is SET here — this
    // arms the fence. Idempotent (ON CONFLICT DO NOTHING on the singleton).
    expect(joined).toContain("insert into assistant_cutover_marker (id) values (true) on conflict (id) do nothing");
  });

  it("installs the legacy-write fence as a BEFORE INSERT OR UPDATE trigger on chat_threads", () => {
    expect(joined).toContain("create or replace function fn_chat_threads_legacy_write_fence()");
    expect(joined).toContain("before insert or update on chat_threads");
    // idempotent: DROP TRIGGER IF EXISTS precedes CREATE TRIGGER.
    expect(joined).toContain("drop trigger if exists trg_chat_threads_legacy_write_fence on chat_threads");
    expect(joined.indexOf("drop trigger if exists trg_chat_threads_legacy_write_fence")).toBeLessThan(
      joined.indexOf("create trigger trg_chat_threads_legacy_write_fence"),
    );
  });

  it("resolves the marker in the fired table's schema via TG_TABLE_SCHEMA (not a bare search_path lookup)", () => {
    const fence = buildLegacyWriteFenceSql().join("\n").toLowerCase();
    expect(fence).toContain("tg_table_schema");
    expect(fence).toContain("execute format('select exists (select 1 from %i.assistant_cutover_marker)', tg_table_schema)");
    expect(fence).toContain("raise exception");
  });

  it("runs the fence as SECURITY DEFINER with a pinned search_path so the marker read never fails on a missing invoker grant", () => {
    const fence = buildLegacyWriteFenceSql().join("\n").toLowerCase();
    expect(fence).toContain("security definer");
    expect(fence).toContain("set search_path = pg_catalog, pg_temp");
  });

  it("exposes stable identifier exports for the later cutover stages", () => {
    expect(CUTOVER_MARKER_TABLE).toBe("assistant_cutover_marker");
    expect(CHAT_THREADS_LEGACY_WRITE_FENCE_FUNCTION).toBe("fn_chat_threads_legacy_write_fence");
    expect(CHAT_THREADS_LEGACY_WRITE_FENCE_TRIGGER).toBe("trg_chat_threads_legacy_write_fence");
  });

  it("is additive — no chat_threads drop, no NOT NULL tightening on existing columns, no data rewrite", () => {
    expect(joined).not.toContain("drop table if exists chat_threads");
    // No NOT NULL tightening of an EXISTING column (the marker table's own
    // net-new cutover_at NOT NULL DEFAULT now() is additive and allowed).
    expect(joined).not.toContain("alter column");
    expect(joined).not.toContain("set not null");
    expect(joined).not.toContain("update assistant_threads");
    expect(joined).not.toContain("update chat_threads");
  });
});

describe("core__0066 down()", () => {
  const stmts = collectSql(down as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("is a STRUCTURAL reverse in dependency order — trigger, function, marker, indexes, columns (lossy after post-cutover writes)", () => {
    expect(joined).toContain("drop trigger if exists trg_chat_threads_legacy_write_fence on chat_threads");
    expect(joined).toContain("drop function if exists fn_chat_threads_legacy_write_fence()");
    expect(joined).toContain("drop table if exists assistant_cutover_marker");
    expect(joined).toContain("drop index if exists assistant_threads_team_updated_idx");
    expect(joined).toContain("drop index if exists assistant_threads_project_updated_idx");
    expect(joined).toContain("alter table assistant_turns drop column if exists ordinal");
    expect(joined).toContain("alter table assistant_threads drop constraint if exists assistant_threads_scalars_object_check");
    expect(joined).toContain("alter table assistant_threads drop column if exists scalars");
    expect(joined).toContain("alter table assistant_threads drop column if exists team_id");
    expect(joined).toContain("alter table assistant_threads drop column if exists project_id");
    // trigger dropped before its function; function before its table.
    expect(joined.indexOf("drop trigger")).toBeLessThan(joined.indexOf("drop function"));
    expect(joined.indexOf("drop function")).toBeLessThan(joined.indexOf("drop table if exists assistant_cutover_marker"));
  });

  it("does NOT drop chat_threads (that is PR3)", () => {
    expect(joined).not.toContain("drop table if exists chat_threads");
  });
});

describe("core__0066 exported builders stay in sync with up()", () => {
  it("up() emits exactly the operator halves + marker table + fence + marker activation builder output", () => {
    const upStmts = collectSql(up as (b: { sql: (s: string) => void }) => void);
    const expected = [
      ...buildOperatorHalfColumnSql(),
      ...buildCutoverMarkerTableSql(),
      ...buildLegacyWriteFenceSql(),
      ...buildCutoverMarkerActivationSql(),
    ];
    expect(upStmts).toEqual(expected);
  });
});

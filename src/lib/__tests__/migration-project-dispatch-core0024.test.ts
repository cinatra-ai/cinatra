// Contract test for the dynamic-dispatch primitive storage migration
// (migrations/core/core__0024_project-dispatch-ledger-lease.mjs, cinatra#1032
// deliverable 2).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — both
// tables, the ledger's unique key, the status/action-version CHECKs, the lease
// PK, idempotency, and a clean reversal — plus the bootstrap-DDL parity: the
// migration and `projectDispatchSchemaQueries` (the buildCreateStoreSchemaQueries
// leaf) must create the same tables, columns, and indexes, or the fresh-install
// and operator-upgrade paths diverge. Live execution against Postgres is
// covered by the DB-gated project-dispatch-ledger-lease integration test in
// packages/agents and by scripts/ci/upgrade-proof.sh.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0024_project-dispatch-ledger-lease.mjs";
// The ledger every consumer sees is the manifest.json + manifest.d/ union,
// computed by the shared reader (plain runtime ESM, same import form).
import { readManifestUnion } from "../../../migrations/manifest-reader.mjs";
import { projectDispatchSchemaQueries } from "@/lib/extension-grant-schema";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

const upJoined = collectSql(up as (b: { sql: (s: string) => void }) => void)
  .join("\n")
  .toLowerCase();

describe("core__0024 up()", () => {
  it("creates the dispatch-attempt ledger table idempotently", () => {
    expect(upJoined).toContain("create table if not exists project_dispatch_attempts");
    for (const col of [
      "org_id text not null",
      "project_ref text not null",
      "item_natural_key text not null",
      "action_version integer not null",
      "worker_role text not null",
      "worker_package text not null",
      "worker_version_constraint text not null",
      "idempotency_key text not null",
      "run_id text",
      "status text not null default 'pending'",
      "version integer not null default 0",
    ]) {
      expect(upJoined).toContain(col);
    }
  });

  it("keys the ledger UNIQUE on (org_id, item_natural_key, action_version)", () => {
    expect(upJoined).toContain(
      "create unique index if not exists project_dispatch_attempts_item_action_uniq",
    );
    expect(upJoined.replace(/\s+/g, " ")).toContain(
      "(org_id, item_natural_key, action_version)",
    );
  });

  it("constrains status to the pending/dispatched/failed vocabulary and action_version to >= 0", () => {
    const normalized = upJoined.replace(/\s+/g, " ");
    expect(normalized).toContain("check (status in ('pending', 'dispatched', 'failed'))");
    expect(normalized).toContain("check (action_version >= 0)");
  });

  it("puts NO foreign key on run_id (append-only history outlives the run row)", () => {
    expect(upJoined).not.toContain("references");
  });

  it("creates the lease table with the (org_id, project_ref) PK and fencing version", () => {
    expect(upJoined).toContain("create table if not exists project_leases");
    expect(upJoined.replace(/\s+/g, " ")).toContain("primary key (org_id, project_ref)");
    expect(upJoined).toContain("expires_at timestamptz not null");
    expect(upJoined).toContain("version integer not null default 1");
  });

  it("uses unqualified table names (runner sets search_path to the app schema)", () => {
    expect(upJoined).not.toContain('"public"."project_');
    expect(upJoined).not.toContain("public.project_");
  });
});

describe("core__0024 down()", () => {
  const stmts = collectSql(down as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("drops both indexes and both tables — all IF EXISTS", () => {
    expect(joined).toContain("drop index if exists project_dispatch_attempts_item_action_uniq");
    expect(joined).toContain("drop index if exists project_dispatch_attempts_project_idx");
    expect(joined).toContain("drop table if exists project_dispatch_attempts");
    expect(joined).toContain("drop table if exists project_leases");
  });

  it("drops the ledger indexes before the ledger table", () => {
    const idx = joined.indexOf("drop index if exists project_dispatch_attempts_item_action_uniq");
    const tbl = joined.indexOf("drop table if exists project_dispatch_attempts");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(tbl).toBeGreaterThan(idx);
  });
});

describe("bootstrap-DDL parity (projectDispatchSchemaQueries)", () => {
  const bootstrap = projectDispatchSchemaQueries("cinatra")
    .map((q) => q.text)
    .join("\n")
    .toLowerCase();

  /** Strip schema qualification + whitespace so the two DDL sources compare on
   *  substance (the migration rides search_path; the bootstrap qualifies). */
  const normalize = (s: string) => s.replace(/"cinatra"\./g, "").replace(/["\s;]+/g, " ").trim();

  it("creates the same tables and indexes as the migration", () => {
    for (const name of [
      "create table if not exists project_dispatch_attempts",
      "create table if not exists project_leases",
      "create unique index if not exists project_dispatch_attempts_item_action_uniq",
      "create index if not exists project_dispatch_attempts_project_idx",
    ]) {
      expect(normalize(bootstrap)).toContain(name);
      expect(normalize(upJoined)).toContain(name);
    }
  });

  it("declares the same column set for both tables in both sources", () => {
    const columns = (ddl: string, table: string): string[] => {
      const m = ddl.match(new RegExp(`create table if not exists ${table} \\(([^;]*?)\\)\\s*(?:;|$)`, "s"));
      expect(m, `CREATE TABLE ${table} present`).toBeTruthy();
      return (m as RegExpMatchArray)[1]
        .split(",")
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((t) => t && !["constraint", "primary", "check"].includes(t));
    };
    for (const table of ["project_dispatch_attempts", "project_leases"]) {
      expect(columns(normalize(bootstrap), table)).toEqual(columns(normalize(upJoined), table));
    }
  });
});

describe("ledger union entry (manifest.json + manifest.d/ via the shared reader)", () => {
  it("ships the non-destructive 0024 entry naming both tables", () => {
    const { entries, errors } = readManifestUnion("migrations") as {
      entries: Array<{ seq: string; file: string; destructive: boolean; tables: string[] }>;
      errors: string[];
    };
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0024");
    expect(entry).toBeTruthy();
    expect(entry?.file).toBe("core/core__0024_project-dispatch-ledger-lease.mjs");
    expect(entry?.destructive).toBe(false);
    expect(entry?.tables).toEqual(["project_dispatch_attempts", "project_leases"]);
  });
});

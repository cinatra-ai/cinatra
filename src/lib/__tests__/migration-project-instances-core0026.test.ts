// Contract test for the project-instance registry migration
// (migrations/core/core__0026_project-instances.mjs, cinatra#1032
// deliverable 3).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — the
// table, its PK, the provider_mode CHECK, idempotency, and a clean reversal —
// plus the bootstrap-DDL parity: the migration and
// `projectInstancesSchemaQueries` (the buildCreateStoreSchemaQueries leaf)
// must create the same table, columns, and constraints, or the fresh-install
// and operator-upgrade paths diverge. Live store behavior against Postgres is
// covered by the DB-gated project-instance-store integration test in
// packages/agents.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0026_project-instances.mjs";
import { projectInstancesSchemaQueries } from "@/lib/extension-grant-schema";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

const upJoined = collectSql(up as (b: { sql: (s: string) => void }) => void)
  .join("\n")
  .toLowerCase();

const EXPECTED_COLUMNS = [
  "org_id text not null",
  "project_ref text not null",
  "project_id text",
  "template_package text not null",
  "template_id text not null",
  "template_digest text not null",
  "pm_agent_package text not null",
  "provider_id text not null",
  "provider_mode text not null",
  "created_at timestamptz not null default now()",
  "updated_at timestamptz not null default now()",
];

describe("core__0026 up()", () => {
  it("creates the project_instances table idempotently", () => {
    expect(upJoined).toContain("create table if not exists project_instances");
    for (const col of EXPECTED_COLUMNS) {
      expect(upJoined).toContain(col);
    }
  });

  it("keys the instance on (org_id, project_ref)", () => {
    expect(upJoined).toContain("primary key (org_id, project_ref)");
  });

  it("CHECK-constrains provider_mode to the selection modes", () => {
    expect(upJoined).toContain("project_instances_provider_mode_check");
    expect(upJoined).toContain("check (provider_mode in ('configured', 'auto'))");
  });
});

describe("core__0026 down()", () => {
  it("cleanly reverses the table (fresh addition — exact pre-0026 shape)", () => {
    const downJoined = collectSql(down as (b: { sql: (s: string) => void }) => void)
      .join("\n")
      .toLowerCase();
    expect(downJoined).toContain("drop table if exists project_instances");
  });
});

describe("bootstrap-DDL parity (projectInstancesSchemaQueries)", () => {
  it("the fresh-install bootstrap creates the SAME table shape as the migration", () => {
    const bootstrap = projectInstancesSchemaQueries("app")
      .map((q) => q.text)
      .join("\n")
      .toLowerCase();
    expect(bootstrap).toContain('create table if not exists "app"."project_instances"');
    for (const col of EXPECTED_COLUMNS) {
      expect(bootstrap).toContain(col);
    }
    expect(bootstrap).toContain("primary key (org_id, project_ref)");
    expect(bootstrap).toContain("check (provider_mode in ('configured', 'auto'))");
  });

  it("quotes an embedded double quote in the schema name (injection hygiene)", () => {
    const q = projectInstancesSchemaQueries('we"ird')[0].text;
    expect(q).toContain('"we""ird"');
  });
});

/**
 * Real-Postgres integration proof for the S11c baseline-backed 3-way UPGRADE
 * merge (cinatra#1628, remaining AC2). Drives the ACTUAL dashboards single-writer
 * `upgradeExtensionDashboards` against a live Postgres so the no-clobber merge,
 * baseline re-base, version stamping, seed-baseline bootstrap, and idempotency are
 * verified end-to-end at the DB boundary.
 *
 * GATED (same idiom as adopt-extension-dashboards.integration.test.ts): runs only
 * when DASH_DB_IT=1 AND SUPABASE_DB_URL point at a throwaway Postgres. Skipped in
 * the default unit run. Run locally against the verify stack:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *   SUPABASE_SCHEMA=cinatra_s11c_it DASH_DB_IT=1 \
 *   npx vitest run --no-coverage src/__tests__/upgrade-extension-dashboards.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { upgradeExtensionDashboards } from "../mutation-service";
import { computeAppliedDefaultHash } from "../contribution-upgrade-merge";
import type { DashboardActor } from "../permissions";

const RUN_IT = process.env.DASH_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_s11c_it";
if (RUN_IT && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the integration test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;

const ORG = "org-s11c";
const PKG = "@cinatra-ai/blog-content-agent";
const LINEAGE = "contribution:@cinatra-ai/blog-content-agent#blog-operator";

const actor: DashboardActor = { userId: "u-s11c", organizationId: ORG, teamIds: [], orgRole: "owner", teamRoles: {} };

const p = (instanceId: string, title: string) => ({
  instanceId, kind: "object-list", version: "1.0.0", slot: "fixed", config: { title, typeId: "task" },
});
const cfg = (portlets: unknown[]) => ({ apiVersion: "1.2", scopeLevel: "organization", portlets });

const BASE = cfg([p("a", "v1")]);
const OURS = cfg([p("a", "USER-EDIT")]); // user customized a
const THEIRS = cfg([p("a", "v2"), p("b", "brand-new")]); // vendor changed a + added b

async function seedRow(
  pool: Pool,
  row: { id: string; config: unknown; appliedDefaultJson: unknown | null; appliedVersion: number | null; status?: string },
) {
  await pool.query(
    `INSERT INTO "${SCHEMA}".dashboards
       (id, name, config_json, config_version, owner_level, owner_id, organization_id, visibility, status,
        created_by, extension_id, is_template, contribution_id, applied_default_json, applied_default_hash, applied_contribution_version)
     VALUES ($1,$2,$3,'1.2','organization','owner-1',$4,'members',$5,'sys',$6,false,$7,$8,$9,$10)`,
    [
      row.id, `${row.id} name`, JSON.stringify(row.config), ORG, row.status ?? "published", PKG, LINEAGE,
      row.appliedDefaultJson === null ? null : JSON.stringify(row.appliedDefaultJson),
      row.appliedDefaultJson === null ? null : computeAppliedDefaultHash(row.appliedDefaultJson),
      row.appliedVersion,
    ],
  );
}

async function readRow(pool: Pool, id: string) {
  const r = await pool.query(
    `SELECT config_json, applied_default_json, applied_contribution_version, applied_default_hash, status
       FROM "${SCHEMA}".dashboards WHERE id = $1`,
    [id],
  );
  return r.rows[0] as
    | { config_json: any; applied_default_json: any; applied_contribution_version: number | null; applied_default_hash: string | null; status: string }
    | undefined;
}

describe.skipIf(!RUN_IT)("upgradeExtensionDashboards (real Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    await pool.query(`CREATE TABLE "${SCHEMA}".dashboards (
      id text PRIMARY KEY, name text NOT NULL, description text, config_json jsonb NOT NULL,
      config_version text NOT NULL DEFAULT '1.2', dashboard_version integer NOT NULL DEFAULT 1,
      published_revision_number integer, owner_level text NOT NULL, owner_id text NOT NULL,
      organization_id text NOT NULL, visibility text NOT NULL DEFAULT 'private', status text NOT NULL DEFAULT 'draft',
      created_by text NOT NULL, updated_by text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, archived_at timestamptz,
      project_id text, extension_id text, is_template boolean NOT NULL DEFAULT false, template_scope text,
      entity_type text, entity_id text, is_default boolean NOT NULL DEFAULT false, contribution_id text,
      applied_contribution_version integer, applied_default_json jsonb, applied_default_hash text, archive_reason text
    )`);
    await pool.query(`CREATE TABLE "${SCHEMA}".audit_events (
      id text PRIMARY KEY, organization_id text, actor_principal_id text, actor_principal_type text,
      auth_source text, delegated_by text, impersonated_user_id text, resource_type text, resource_id text,
      operation text, decision text, policy_version text, request_id text, run_id text, a2a_task_id text,
      ip text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${SCHEMA}".dashboards, "${SCHEMA}".audit_events`);
  });

  it("3-way merges: keeps the user edit, applies the new default portlet, re-bases the baseline", async () => {
    await seedRow(pool, { id: "r1", config: OURS, appliedDefaultJson: BASE, appliedVersion: 1 });
    const res = await upgradeExtensionDashboards(undefined, {
      organizationId: ORG, contributionId: LINEAGE, newDefault: THEIRS, newContributionVersion: 2, actor,
    });
    expect(res.merged).toBe(1);
    const row = await readRow(pool, "r1");
    const byId = Object.fromEntries((row!.config_json.portlets as any[]).map((x) => [x.instanceId, x]));
    expect(byId.a.config.title).toBe("USER-EDIT"); // user customization preserved
    expect(byId.b.config.title).toBe("brand-new"); // new default portlet added
    expect(row!.applied_contribution_version).toBe(2); // provenance stamped
    expect(row!.applied_default_hash).toBe(computeAppliedDefaultHash(THEIRS)); // baseline re-based
  });

  it("is idempotent on a second identical upgrade", async () => {
    await seedRow(pool, { id: "r1", config: OURS, appliedDefaultJson: BASE, appliedVersion: 1 });
    await upgradeExtensionDashboards(undefined, { organizationId: ORG, contributionId: LINEAGE, newDefault: THEIRS, newContributionVersion: 2, actor });
    const again = await upgradeExtensionDashboards(undefined, { organizationId: ORG, contributionId: LINEAGE, newDefault: THEIRS, newContributionVersion: 2, actor });
    expect(again.merged).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it("SEEDS a baseline (never clobbers config) for a row with no prior applied_default_json", async () => {
    await seedRow(pool, { id: "legacy", config: OURS, appliedDefaultJson: null, appliedVersion: null });
    const res = await upgradeExtensionDashboards(undefined, { organizationId: ORG, contributionId: LINEAGE, newDefault: THEIRS, newContributionVersion: 2, actor });
    expect(res.seeded).toBe(1);
    const row = await readRow(pool, "legacy");
    // config_json untouched (still the user's), baseline seeded to theirs.
    expect((row!.config_json.portlets as any[]).map((x) => x.instanceId)).toEqual(["a"]);
    expect(row!.applied_default_hash).toBe(computeAppliedDefaultHash(THEIRS));
    expect(row!.applied_contribution_version).toBe(2);
  });
});

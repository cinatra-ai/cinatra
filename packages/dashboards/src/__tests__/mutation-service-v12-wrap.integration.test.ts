/**
 * Real-Postgres integration proof for the cinatra#326 server-side wrap +
 * autosave round-trip. Drives the ACTUAL mutation service (createDashboard /
 * upsertDashboardConfig / updateDashboard) against a live Postgres, so the
 * behavior the unit suite can't reach (the wrap + re-envelope landing real rows)
 * is verified end-to-end at the DB boundary.
 *
 * GATED: only runs when DASH_DB_IT=1 AND SUPABASE_DB_URL point at a throwaway
 * Postgres (the default CI unit run has neither, so it is skipped — it is NOT
 * part of the green unit gate). Run locally:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5439/postgres \
 *   SUPABASE_SCHEMA=cinatra_it DASH_DB_IT=1 \
 *   npx vitest run --no-coverage src/__tests__/mutation-service-v12-wrap.integration.test.ts
 *
 * Schema is provisioned from the canonical bootstrap DDL
 * (`buildCreateStoreSchemaQueries`) so the row shape matches production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  createDashboard,
  updateDashboard,
  upsertDashboardConfig,
} from "../mutation-service";
import { unwrapV12ToDc, isV12Envelope } from "../v12-envelope";
import { DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";
import { AGENTS_DEFAULT_CONFIG } from "../components/seed-configs/agents-default";
import type { DashboardActor } from "../permissions";

const RUN_IT = process.env.DASH_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_it";
// This value is interpolated into raw SQL identifiers (CREATE/DROP SCHEMA, table
// refs). Reject anything that is not a plain unquoted identifier so a crafted
// env value cannot break out of the identifier (the suite DROPs the schema CASCADE).
if (RUN_IT && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the integration test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;

const actor: DashboardActor = {
  userId: "u-it-1",
  organizationId: "org-it-1",
  teamIds: [],
  orgRole: "owner",
  teamRoles: {},
};

async function readRow(pool: Pool, id: string) {
  const q = `SELECT config_version, config_json FROM "${SCHEMA}".dashboards WHERE id = $1 LIMIT 1`;
  const r = await pool.query(q, [id]);
  return r.rows[0] as { config_version: string; config_json: unknown } | undefined;
}

describe.skipIf(!RUN_IT)("mutation-service apiVersion 1.2 wrap (real Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    // The three tables the mutation service touches, in their POST-migration
    // (Drizzle-mirror `store/schema.ts`) shape — sufficient + faithful for the
    // create/upsert/update write paths under test. (Full bootstrap DDL needs the
    // whole Better Auth public schema; not required to exercise the apiVersion 1.2 wrap.)
    await pool.query(`CREATE TABLE "${SCHEMA}".dashboards (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      config_json jsonb NOT NULL,
      config_version text NOT NULL DEFAULT '1.0.0',
      dashboard_version integer NOT NULL DEFAULT 1,
      published_revision_number integer,
      owner_level text NOT NULL,
      owner_id text NOT NULL,
      organization_id text NOT NULL,
      visibility text NOT NULL DEFAULT 'private',
      status text NOT NULL DEFAULT 'draft',
      created_by text NOT NULL,
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      archived_at timestamptz,
      project_id text,
      extension_id text,
      is_template boolean NOT NULL DEFAULT false,
      template_scope text
    )`);
    await pool.query(`CREATE TABLE "${SCHEMA}".dashboard_revisions (
      dashboard_id text NOT NULL REFERENCES "${SCHEMA}".dashboards(id) ON DELETE CASCADE,
      revision_number integer NOT NULL,
      config_json jsonb NOT NULL,
      config_version text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (dashboard_id, revision_number)
    )`);
    await pool.query(`CREATE TABLE "${SCHEMA}".audit_events (
      id text PRIMARY KEY,
      organization_id text,
      actor_principal_id text,
      actor_principal_type text,
      auth_source text,
      delegated_by text,
      impersonated_user_id text,
      resource_type text,
      resource_id text,
      operation text,
      decision text,
      policy_version text,
      request_id text,
      run_id text,
      a2a_task_id text,
      ip text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      await pool.end();
    }
  });

  it("createDashboard wraps a BARE drizzle-cube config into a persisted apiVersion 1.2 analytics envelope", async () => {
    const row = await createDashboard(
      {
        id: "it-create-1",
        name: "IT create",
        config: AGENTS_DEFAULT_CONFIG, // bare DC, no configVersion → defaults to apiVersion 1.2
        ownerLevel: "user",
        ownerId: actor.userId,
      },
      actor,
    );
    expect(row.configVersion).toBe(DASHBOARD_CONFIG_V12_VERSION);
    const persisted = await readRow(pool, "it-create-1");
    expect(persisted?.config_version).toBe(DASHBOARD_CONFIG_V12_VERSION);
    expect(isV12Envelope(persisted?.config_json)).toBe(true);
    // The embedded DC is the original bare config, recoverable by unwrap.
    expect(unwrapV12ToDc(persisted?.config_json)).toEqual(AGENTS_DEFAULT_CONFIG);
  });

  it("upsertDashboardConfig first-create wraps; re-save re-envelopes the SAME row (autosave round-trip)", async () => {
    const id = "it-upsert-1";
    // First save (materialize) with a bare DC.
    await upsertDashboardConfig(
      id,
      { config: AGENTS_DEFAULT_CONFIG, name: "IT upsert", ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    const first = await readRow(pool, id);
    expect(first?.config_version).toBe(DASHBOARD_CONFIG_V12_VERSION);
    expect(isV12Envelope(first?.config_json)).toBe(true);

    // Second save with an EDITED bare DC (simulating an autosave after a layout edit).
    const editedDc = {
      ...AGENTS_DEFAULT_CONFIG,
      layoutMode: "rows" as const,
      colorPalette: "edited-palette",
    };
    await upsertDashboardConfig(
      id,
      { config: editedDc, ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    const second = await readRow(pool, id);
    expect(second?.config_version).toBe(DASHBOARD_CONFIG_V12_VERSION);
    // Reload shows the EDIT (the re-enveloped DC), not the seed.
    expect(unwrapV12ToDc(second?.config_json)).toEqual(editedDc);
  });

  it("updateDashboard on an existing apiVersion 1.2 row never silently downgrades and re-envelopes a bare body", async () => {
    const id = "it-update-1";
    await createDashboard(
      { id, name: "IT update", config: AGENTS_DEFAULT_CONFIG, ownerLevel: "user", ownerId: actor.userId },
      actor,
    );
    // An MCP-style update sending a BARE DC body + explicit legacy version must
    // NOT downgrade the apiVersion 1.2 row — it stays apiVersion 1.2 and re-envelopes the body.
    const editedDc = { ...AGENTS_DEFAULT_CONFIG, colorPalette: "update-edit" };
    await updateDashboard(id, { config: editedDc, configVersion: "1.1.0" }, actor);
    const after = await readRow(pool, id);
    expect(after?.config_version).toBe(DASHBOARD_CONFIG_V12_VERSION);
    expect(unwrapV12ToDc(after?.config_json)).toEqual(editedDc);
  });
});

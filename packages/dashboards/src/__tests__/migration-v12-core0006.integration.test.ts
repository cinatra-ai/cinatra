/**
 * Real-Postgres integration proof for the cinatra#327 core__0006 data migration
 * AFTER fixing the two verify findings (PR #336). Drives the REPO's ACTUAL
 * migration runner (`packages/cli/src/core-migrations.mjs` → `runCoreMigrations`,
 * the same node-pg-migrate runner production boot uses) against a live Postgres,
 * executing the REAL fixed core__0006 module — so the SQL behavior the unit
 * suite can't reach is verified end-to-end at the DB boundary, and it runs the
 * REAL registry validator over every migrated row.
 *
 * Proves:
 *   - Finding 2 (BLOCKER): a pure-1.0.0 row (the render-kind LEGACY_V1_0_CONFIG
 *     shape — no title/w/h/x/y) is UP-CONVERTED to a valid grid (schema-1.1)
 *     body before wrapping, so the migrated row's embedded config.dashboard
 *     PASSES the analytics deep validator (assertConfigV12).
 *   - Finding 1 (secondary): a NON-migrated MULTI-portlet operator
 *     (apiVersion-1.2) row (analytics-first + sibling) is LEFT UNTOUCHED by
 *     down() (siblings kept).
 *   - up() idempotent; up()→down()→up() round-trips; extension + non-analytics
 *     envelope rows untouched.
 *
 * GATED: only runs when DASH_DB_IT=1 AND SUPABASE_DB_URL point at a throwaway
 * Postgres (the default CI unit run has neither, so it is skipped — it is NOT
 * part of the green unit gate, mirroring mutation-service-v12-wrap.integration).
 * Run locally:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:55327/mig327 \
 *   SUPABASE_SCHEMA=cinatra_it_mig DASH_DB_IT=1 \
 *   npx vitest run --no-coverage src/__tests__/migration-v12-core0006.integration.test.ts
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { wrapDcAsV12 } from "../v12-envelope";
import {
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
} from "../extension/dashboard-config-v12";
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";
import { registerCorePortletKinds, ANALYTICS_PORTLET_KIND } from "../portlets/kinds";
import { getPortletKindDescriptor, validatePortletConfig } from "../portlets/registry";

const V12 = DASHBOARD_CONFIG_V12_VERSION; // the apiVersion literal (avoids a bare token)
const RUN_IT = process.env.DASH_DB_IT === "1" && !!process.env.SUPABASE_DB_URL;
const RAW_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_it_mig";
// Interpolated into raw SQL identifiers (CREATE/DROP SCHEMA). Reject anything
// that is not a plain unquoted identifier (the suite DROPs the schema CASCADE).
if (RUN_IT && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(RAW_SCHEMA)) {
  throw new Error(`Unsafe SUPABASE_SCHEMA for the integration test: ${RAW_SCHEMA}`);
}
const SCHEMA = RAW_SCHEMA;

// The repo root (…/packages/dashboards/src/__tests__ → up 4) holds migrations/.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const MODULE_REL = "migrations/core/core__0006_dashboards-v12.mjs";

registerCorePortletKinds();

// Mirror of mutation-service.ts::assertConfigV12 (structural + per-kind deep).
function registryErrors(config: unknown): string[] {
  const res = validateDashboardConfigV12(config, { getPortletKind: getPortletKindDescriptor });
  if (!res.ok) return res.errors;
  const errs: string[] = [];
  for (const p of res.config.portlets)
    for (const e of validatePortletConfig(p.kind, p.version, { config: p.config, inputs: p.inputs, outputs: p.outputs }))
      errs.push(`portlet "${p.instanceId}": ${e.message}`);
  return errs;
}

const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// A valid bare grid (schema-1.1) drizzle-cube config.
const dc = (tag: string) => ({
  portlets: [{ id: `p-${tag}`, title: `Portlet ${tag}`, w: 6, h: 8, x: 0, y: 0, analysisConfig: {} }],
  layoutMode: "grid" as const,
});
// The pure-1.0.0 LEGACY_V1_0_CONFIG shape (no title/w/h/x/y), incl. an
// EMPTY-title portlet (reachable; the strict v1.1 title.min(1) rejects "", so
// the up-convert must NULLIF it to id [codex merge-safe corner]).
const pureV10 = () => ({
  portlets: [
    { id: "p1", type: "chart" },
    { id: "p2", type: "kpi", title: "Rev", query: { measures: ["x"] } },
    { id: "p3", type: "table", title: "" },
  ],
  layout: { columns: 3, gap: 8 },
});
// TS replica of the SQL up-convert (for the EXPECTED embedded DC of a 1.0 row).
const upconvert = (cfg: Record<string, unknown>) => ({
  ...cfg,
  portlets: (Array.isArray(cfg.portlets) ? cfg.portlets : []).map((p) => {
    const e = p as Record<string, unknown>;
    const title = e.title === "" ? null : e.title; // NULLIF(title,'')
    return { ...e, title: title ?? e.id, w: 0, h: 0, x: 0, y: 0, query: e.query ?? {} };
  }),
});
const envelope = (cfg: unknown, scopeLevel: string) => ({
  apiVersion: V12, scopeLevel,
  portlets: [{ instanceId: "analytics", kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: cfg } }],
});
const multiEnvelope = (cfg: unknown, scopeLevel: string) => ({
  apiVersion: V12, scopeLevel,
  portlets: [
    { instanceId: "analytics", kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: cfg } },
    { instanceId: "ol", kind: "object-list", version: "1.0.0", slot: "optional", config: { typeId: "task" }, outputs: ["selectedId"] },
  ],
});

describe.skipIf(!RUN_IT)("core__0006 dashboards migration (real Postgres, cinatra#327 fix)", () => {
  let pool: Pool;
  let runCoreMigrations: (opts: Record<string, unknown>) => Promise<{ ranNames: string[] }>;
  let runnerRoot: string;

  beforeAll(async () => {
    ({ runCoreMigrations } = await import(path.join(REPO_ROOT, "packages/cli/src/core-migrations.mjs")));
    // Runner root: migrations/core holding ONLY the 0006 module (symlink).
    runnerRoot = mkdtempSync(path.join(os.tmpdir(), "it-mig327-"));
    mkdirSync(path.join(runnerRoot, "migrations", "core"), { recursive: true });
    symlinkSync(path.join(REPO_ROOT, MODULE_REL), path.join(runnerRoot, "migrations", "core", "core__0006_dashboards-v12.mjs"));

    pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    // Pre-0006 (legacy default) shape — the columns 0006 reads.
    await pool.query(`CREATE TABLE "${SCHEMA}".dashboards (
      id text PRIMARY KEY, name text NOT NULL, config_json jsonb NOT NULL,
      config_version text NOT NULL DEFAULT '1.0.0',
      owner_level text NOT NULL, owner_id text NOT NULL, organization_id text NOT NULL,
      created_by text NOT NULL, project_id text, extension_id text,
      is_template boolean NOT NULL DEFAULT false, template_scope text)`);
    await pool.query(`CREATE TABLE "${SCHEMA}".dashboard_revisions (
      dashboard_id text NOT NULL REFERENCES "${SCHEMA}".dashboards(id) ON DELETE CASCADE,
      revision_number integer NOT NULL, config_json jsonb NOT NULL,
      config_version text NOT NULL, created_by text NOT NULL,
      PRIMARY KEY (dashboard_id, revision_number))`);

    const ins = async (o: Record<string, unknown>) =>
      pool.query(
        `INSERT INTO "${SCHEMA}".dashboards (id,name,config_json,config_version,owner_level,owner_id,organization_id,created_by,project_id,extension_id,is_template,template_scope)
         VALUES ($1,$1,$2,$3,$4,'u1','org1','u1',$5,$6,$7,$8)`,
        [o.id, o.config, o.version, o.ownerLevel, o.projectId ?? null, o.extensionId ?? null, o.isTemplate ?? false, o.templateScope ?? null],
      );
    await ins({ id: "d-pure-v10", version: "1.0.0", ownerLevel: "user", config: pureV10() });
    await ins({ id: "d-legacy-grid", version: "1.1.0", ownerLevel: "team", config: dc("team") });
    await ins({ id: "d-ext", version: V12, ownerLevel: "organization", extensionId: "@cinatra-ai/ext", config: envelope(dc("ext"), "organization") });
    await ins({ id: "d-multi", version: V12, ownerLevel: "team", config: multiEnvelope(dc("multi"), "team") });
    await pool.query(
      `INSERT INTO "${SCHEMA}".dashboard_revisions (dashboard_id,revision_number,config_json,config_version,created_by)
       VALUES ('d-pure-v10',1,$1,'1.0.0','u1')`, [pureV10()],
    );
  }, 60_000);

  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {}); await pool.end(); }
    if (runnerRoot) { try { rmSync(runnerRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  const row = async (id: string) => {
    const r = await pool.query(`SELECT config_json, config_version FROM "${SCHEMA}".dashboards WHERE id=$1`, [id]);
    return r.rows[0] as { config_json: unknown; config_version: string };
  };
  const rev = async (id: string, n: number) => {
    const r = await pool.query(`SELECT config_json, config_version FROM "${SCHEMA}".dashboard_revisions WHERE dashboard_id=$1 AND revision_number=$2`, [id, n]);
    return r.rows[0] as { config_json: unknown; config_version: string };
  };
  const embeddedDc = (r: { config_json: unknown }) => (r.config_json as { portlets: { config: { dashboard: unknown } }[] }).portlets[0].config.dashboard;
  const up = () => runCoreMigrations({ connectionString: process.env.SUPABASE_DB_URL, schemaName: SCHEMA, rootDir: runnerRoot, direction: "up", log: () => {} });
  const down = () => runCoreMigrations({ connectionString: process.env.SUPABASE_DB_URL, schemaName: SCHEMA, rootDir: runnerRoot, direction: "down", count: 1, log: () => {} });

  it("BLOCKER (Finding 2): up() up-converts a pure-1.0.0 row so config.dashboard PASSES the analytics validator", async () => {
    const res = await up();
    expect(res.ranNames.some((n) => n.includes("0006_dashboards-v12"))).toBe(true);

    const r = await row("d-pure-v10");
    expect(r.config_version).toBe(V12);
    // embedded DC is the up-converted grid body.
    expect(eq(embeddedDc(r), upconvert(pureV10()))).toBe(true);
    // THE proof: the whole envelope passes the REAL registry validator.
    expect(registryErrors(r.config_json)).toEqual([]);
    // embedded body is a valid grid (schema-1.1) DC.
    expect(DashboardConfigV1_1Schema.safeParse(embeddedDc(r)).success).toBe(true);

    // the pure-1.0.0 REVISION is up-converted too.
    const rv = await rev("d-pure-v10", 1);
    expect(rv.config_version).toBe(V12);
    expect(registryErrors(rv.config_json)).toEqual([]);
  });

  it("a genuine schema-1.1 row migrates to a registry-valid envelope (1.1 path unchanged)", async () => {
    const r = await row("d-legacy-grid");
    expect(r.config_version).toBe(V12);
    expect(eq(embeddedDc(r), dc("team"))).toBe(true);
    expect(registryErrors(r.config_json)).toEqual([]);
  });

  it("up() leaves pre-existing extension + multi-portlet operator envelope rows untouched", async () => {
    expect(eq((await row("d-ext")).config_json, envelope(dc("ext"), "organization"))).toBe(true);
    expect(eq((await row("d-multi")).config_json, multiEnvelope(dc("multi"), "team"))).toBe(true);
  });

  it("up() is idempotent (a second runner up() is a ledger no-op)", async () => {
    const res = await up();
    expect(res.ranNames.length).toBe(0);
  });

  it("Finding 1 (secondary): down() leaves the MULTI-portlet operator envelope row UNTOUCHED (siblings preserved)", async () => {
    const res = await down();
    expect(res.ranNames.some((n) => n.includes("0006_dashboards-v12"))).toBe(true);

    const multi = await row("d-multi");
    expect(multi.config_version).toBe(V12);
    expect(eq(multi.config_json, multiEnvelope(dc("multi"), "team"))).toBe(true);
    expect((multi.config_json as { portlets: unknown[] }).portlets).toHaveLength(2);

    // extension row also untouched.
    expect(eq((await row("d-ext")).config_json, envelope(dc("ext"), "organization"))).toBe(true);
  });

  it("down() reverts the migrated pure-1.0.0 row to a VALID schema-1.1 body (lossless up-convert, never restores worse 1.0)", async () => {
    const r = await row("d-pure-v10");
    expect(r.config_version).toBe("1.1.0");
    expect(eq(r.config_json, upconvert(pureV10()))).toBe(true);
    expect(DashboardConfigV1_1Schema.safeParse(r.config_json).success).toBe(true);
  });

  it("up()→down()→up() round-trips: the pure-1.0.0 row re-migrates to an identical valid envelope", async () => {
    const res = await up();
    expect(res.ranNames.some((n) => n.includes("0006_dashboards-v12"))).toBe(true);
    const r = await row("d-pure-v10");
    expect(eq(r.config_json, envelope(upconvert(pureV10()), "user"))).toBe(true);
    expect(registryErrors(r.config_json)).toEqual([]);
    // multi-portlet row STILL untouched after the full cycle.
    expect(eq((await row("d-multi")).config_json, multiEnvelope(dc("multi"), "team"))).toBe(true);
  });
});

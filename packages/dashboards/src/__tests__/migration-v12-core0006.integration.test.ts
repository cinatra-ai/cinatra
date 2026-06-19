/**
 * Real-Postgres integration proof for the cinatra#327 core__0006 data migration
 * AFTER the robust-B rewrite (owner decision eng#206: a ONE-SHOT TOTAL
 * normalizer; NO backward compat; the strict validator stays strict). Drives the
 * REPO's ACTUAL migration runner (`packages/cli/src/core-migrations.mjs` →
 * `runCoreMigrations`, the same node-pg-migrate runner production boot uses)
 * against a live Postgres, executing the REAL core__0006 module — so the SQL +
 * JS-normalize behavior the unit suite can't reach is verified end-to-end at the
 * DB boundary, and it runs the REAL registry validator over every migrated row.
 *
 * Proves:
 *   - TOTALITY: EVERY legacy/corrupt-at-rest row (a pure-1.0.0 body, a genuine
 *     1.1 body, AND a battery of adversarial bodies — scalar/null/array root,
 *     dashboardFilterMapping:"bad", eagerLoad:"yes", grid:{cols:-1},
 *     layoutMode:"freeform", colorPalette:42, bad portlet element, dup/missing
 *     ids, missing portlets, + a materialized FUZZ set) migrates to a row whose
 *     config_json PASSES the analytics deep validator (assertConfigV12). The
 *     migration NEVER aborts on these (the final-validation gate never fires).
 *   - MARKER: migrated rows carry portlets[0].config.__cinatraMigration.
 *   - up() idempotent; up()→down()→up() round-trips.
 *   - down() (marker-gated) reverts ONLY marked migration rows; a NATIVE #326
 *     single-analytics operator row (NO marker), a multi-portlet operator row,
 *     and an extension row are all LEFT UNTOUCHED.
 *   - Zero-legacy postcondition holds (no 1.0/1.1 row/revision remains after up).
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

import {
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
} from "../extension/dashboard-config-v12";
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";
import { registerCorePortletKinds, ANALYTICS_PORTLET_KIND } from "../portlets/kinds";
import { getPortletKindDescriptor, validatePortletConfig } from "../portlets/registry";

// The REAL bundled normalizer/wrap (to compute EXPECTED embedded DCs + the marker).
import {
  normalizeDashboardConfig,
  wrapMigratedEnvelope,
  MIGRATION_MARKER_KEY,
  MIGRATION_MARKER_VALUE,
} from "../../../../migrations/core/core__0006_dashboards-v12.mjs";

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
// The pure-1.0.0 LEGACY_V1_0_CONFIG shape (no title/w/h/x/y), incl. an EMPTY-title portlet.
const pureV10 = () => ({
  portlets: [
    { id: "p1", type: "chart" },
    { id: "p2", type: "kpi", title: "Rev", query: { measures: ["x"] } },
    { id: "p3", type: "table", title: "" },
  ],
  layout: { columns: 3, gap: 8 },
});

// The full adversarial battery (the corrupt-at-rest shapes robust-B must repair).
const ADVERSARIAL: ReadonlyArray<{ id: string; raw: unknown }> = [
  { id: "adv-scalar", raw: 42 },
  { id: "adv-string", raw: "not a dashboard" },
  { id: "adv-null", raw: null },
  { id: "adv-array", raw: [{ id: "x" }, 1, "y"] },
  { id: "adv-empty", raw: {} },
  { id: "adv-no-portlets", raw: { layoutMode: "grid" } },
  { id: "adv-portlets-str", raw: { portlets: "nope" } },
  { id: "adv-bad-elem", raw: { portlets: [1, null, "x", []] } },
  { id: "adv-missing-id", raw: { portlets: [{ type: "chart" }] } },
  { id: "adv-empty-id", raw: { portlets: [{ id: "", type: "chart" }] } },
  { id: "adv-dup-ids", raw: { portlets: [{ id: "d" }, { id: "d" }, { id: "d" }] } },
  { id: "adv-dfm-bad", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, dashboardFilterMapping: "bad" }] } },
  { id: "adv-eager-yes", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, eagerLoad: "yes" }] } },
  { id: "adv-w-neg", raw: { portlets: [{ id: "p", title: "T", w: -3, h: 1.5, x: 0, y: 0, query: {} }] } },
  // UNSAFE integers (> MAX_SAFE_INTEGER): Number.isInteger accepts but Zod v4
  // .int() rejects — the normalizer must drop them to 0 so the migrated row is
  // not a FALSE-valid that fails the real schema at rest [codex BLOCKER].
  { id: "adv-w-unsafe", raw: { portlets: [{ id: "p", title: "T", w: 1e21, h: 2 ** 53, x: 0, y: Number.MAX_SAFE_INTEGER + 1, query: {} }] } },
  { id: "adv-grid-unsafe", raw: { portlets: [], grid: { cols: 1e21, rowHeight: 50, minW: 3, minH: 4 } } },
  { id: "adv-no-content", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0 }] } },
  { id: "adv-grid-neg", raw: { portlets: [], grid: { cols: -1, rowHeight: 50, minW: 3, minH: 4 } } },
  { id: "adv-layoutmode", raw: { portlets: [], layoutMode: "freeform" } },
  { id: "adv-palette-num", raw: { portlets: [], colorPalette: 42 } },
  { id: "adv-everything", raw: { portlets: [{ id: 5, title: 9, w: "x", dashboardFilterMapping: 1 }, "junk", null], grid: { cols: 0 }, layoutMode: "spiral", colorPalette: false, eagerLoad: 0 } },
];

// A small materialized FUZZ set (seeded, deterministic) — rows that must ALL
// migrate to registry-valid envelopes through the REAL runner.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fuzzBody(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth > 3 || r < 0.25) {
    const leaf = rng();
    if (leaf < 0.25) return null;
    if (leaf < 0.5) return Math.floor((rng() - 0.5) * 100);
    if (leaf < 0.7) return rng() < 0.5;
    if (leaf < 0.85) return ["a", "yes", ""][Math.floor(rng() * 3)];
    return [Number.NaN, Number.POSITIVE_INFINITY][Math.floor(rng() * 2)];
  }
  if (r < 0.55) return Array.from({ length: Math.floor(rng() * 4) }, () => fuzzBody(rng, depth + 1));
  const keys = ["portlets", "id", "title", "w", "h", "grid", "cols", "layoutMode", "colorPalette", "eagerLoad", "dashboardFilterMapping", "query"];
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 5);
  for (let i = 0; i < n; i += 1) obj[keys[Math.floor(rng() * keys.length)]] = fuzzBody(rng, depth + 1);
  return obj;
}
const FUZZ: Array<{ id: string; raw: unknown }> = (() => {
  const rng = mulberry32(0x533d);
  return Array.from({ length: 40 }, (_, i) => ({ id: `fuzz-${i}`, raw: fuzzBody(rng, 0) }));
})();

// EXPECTED embedded DC of a migrated row = the REAL bundled normalizer's output.
const expectDc = (raw: unknown, idBase: string) => normalizeDashboardConfig(raw, { idBase });

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

describe.skipIf(!RUN_IT)("core__0006 dashboards migration (real Postgres, cinatra#327 robust-B)", () => {
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
    await pool.query(`SET search_path TO "${SCHEMA}"`);
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
        [o.id, JSON.stringify(o.config), o.version, o.ownerLevel, o.projectId ?? null, o.extensionId ?? null, o.isTemplate ?? false, o.templateScope ?? null],
      );
    // Named legacy rows.
    await ins({ id: "d-pure-v10", version: "1.0.0", ownerLevel: "user", config: pureV10() });
    await ins({ id: "d-legacy-grid", version: "1.1.0", ownerLevel: "team", config: dc("team") });
    await ins({ id: "d-proj", version: "1.1.0", ownerLevel: "user", projectId: "proj-1", config: dc("proj") });
    // Pre-existing apiVersion-1.2 rows that must be UNTOUCHED.
    await ins({ id: "d-ext", version: V12, ownerLevel: "organization", extensionId: "@cinatra-ai/ext", config: envelope(dc("ext"), "organization") });
    await ins({ id: "d-multi", version: V12, ownerLevel: "team", config: multiEnvelope(dc("multi"), "team") });
    // A NATIVE #326 single-analytics operator row — same SHAPE as a migrated row
    // but NO marker. Must be UNTOUCHED by down() (the robust-B marker test).
    await ins({ id: "d-native", version: V12, ownerLevel: "user", config: envelope(dc("native"), "user") });

    // Adversarial + fuzz legacy rows (alternate 1.0.0/1.1.0 version label).
    let i = 0;
    for (const { id, raw } of [...ADVERSARIAL, ...FUZZ]) {
      await ins({ id, version: i % 2 === 0 ? "1.0.0" : "1.1.0", ownerLevel: "user", config: raw });
      i += 1;
    }

    // A pure-1.0.0 REVISION (and a revision for an adversarial row).
    await pool.query(
      `INSERT INTO "${SCHEMA}".dashboard_revisions (dashboard_id,revision_number,config_json,config_version,created_by)
       VALUES ('d-pure-v10',1,$1,'1.0.0','u1'), ('adv-everything',1,$2,'1.0.0','u1')`,
      [JSON.stringify(pureV10()), JSON.stringify({ portlets: "garbage" })],
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
  const marker = (r: { config_json: unknown }) => (r.config_json as { portlets: { config: Record<string, unknown> }[] }).portlets[0].config[MIGRATION_MARKER_KEY];
  const up = () => runCoreMigrations({ connectionString: process.env.SUPABASE_DB_URL, schemaName: SCHEMA, rootDir: runnerRoot, direction: "up", log: () => {} });
  const down = () => runCoreMigrations({ connectionString: process.env.SUPABASE_DB_URL, schemaName: SCHEMA, rootDir: runnerRoot, direction: "down", count: 1, log: () => {} });

  it("up() runs the migration once", async () => {
    const res = await up();
    expect(res.ranNames.some((n) => n.includes("0006_dashboards-v12"))).toBe(true);
  });

  it("BLOCKER (Finding 2): a pure-1.0.0 row is normalized so config.dashboard PASSES the analytics validator + carries the marker", async () => {
    const r = await row("d-pure-v10");
    expect(r.config_version).toBe(V12);
    expect(eq(embeddedDc(r), expectDc(pureV10(), "dashboards:d-pure-v10"))).toBe(true);
    expect(registryErrors(r.config_json)).toEqual([]);
    expect(DashboardConfigV1_1Schema.safeParse(embeddedDc(r)).success).toBe(true);
    expect(marker(r)).toBe(MIGRATION_MARKER_VALUE);

    // the pure-1.0.0 REVISION is normalized too.
    const rv = await rev("d-pure-v10", 1);
    expect(rv.config_version).toBe(V12);
    expect(registryErrors(rv.config_json)).toEqual([]);
    expect(marker(rv)).toBe(MIGRATION_MARKER_VALUE);
  });

  it("TOTALITY: EVERY adversarial + fuzz row migrates to a registry-VALID apiVersion-1.2 envelope (none aborted)", async () => {
    for (const { id, raw } of [...ADVERSARIAL, ...FUZZ]) {
      const r = await row(id);
      expect(r.config_version, `${id} version`).toBe(V12);
      // registry-valid at rest (the REAL validator).
      expect(registryErrors(r.config_json), `${id} registry`).toEqual([]);
      // embedded DC passes the REAL strict schema.
      expect(DashboardConfigV1_1Schema.safeParse(embeddedDc(r)).success, `${id} schema`).toBe(true);
      // exactly the bundled normalizer's output (DB normalize == JS normalize).
      const expected = expectDc(raw, `dashboards:${id}`);
      expect(eq(embeddedDc(r), expected), `${id} embedded DC mismatch`).toBe(true);
      // marked.
      expect(marker(r), `${id} marker`).toBe(MIGRATION_MARKER_VALUE);
    }
    // the garbage REVISION too.
    const rv = await rev("adv-everything", 1);
    expect(rv.config_version).toBe(V12);
    expect(registryErrors(rv.config_json)).toEqual([]);
  });

  it("scopeLevel derives from the parent row (project_id -> 'project')", async () => {
    expect((await row("d-proj")).config_json).toMatchObject({ scopeLevel: "project" });
  });

  it("a genuine schema-1.1 row migrates to a registry-valid marked envelope (1.1 path: fixed point)", async () => {
    const r = await row("d-legacy-grid");
    expect(r.config_version).toBe(V12);
    expect(eq(embeddedDc(r), dc("team"))).toBe(true); // byte-equivalent (normalize is a fixed point)
    expect(registryErrors(r.config_json)).toEqual([]);
    expect(marker(r)).toBe(MIGRATION_MARKER_VALUE);
  });

  it("up() leaves pre-existing extension + multi-portlet + native single-analytics apiVersion-1.2 rows UNTOUCHED", async () => {
    expect(eq((await row("d-ext")).config_json, envelope(dc("ext"), "organization"))).toBe(true);
    expect(eq((await row("d-multi")).config_json, multiEnvelope(dc("multi"), "team"))).toBe(true);
    expect(eq((await row("d-native")).config_json, envelope(dc("native"), "user"))).toBe(true);
    // none of the untouched rows gained a marker.
    expect(marker(await row("d-native"))).toBeUndefined();
  });

  it("ZERO-LEGACY postcondition: no 1.0/1.1 row or revision remains after up()", async () => {
    const r = await pool.query(
      `SELECT (SELECT COUNT(*) FROM "${SCHEMA}".dashboards WHERE config_version IN ('1.0.0','1.1.0')) AS d,
              (SELECT COUNT(*) FROM "${SCHEMA}".dashboard_revisions WHERE config_version IN ('1.0.0','1.1.0')) AS r`,
    );
    expect(Number(r.rows[0].d)).toBe(0);
    expect(Number(r.rows[0].r)).toBe(0);
  });

  it("up() is idempotent (a second runner up() is a ledger no-op)", async () => {
    const res = await up();
    expect(res.ranNames.length).toBe(0);
  });

  it("Finding 1 (robust-B): down() reverts ONLY marked rows; native single-analytics + multi-portlet + extension UNTOUCHED", async () => {
    const res = await down();
    expect(res.ranNames.some((n) => n.includes("0006_dashboards-v12"))).toBe(true);

    // NATIVE single-analytics operator row (no marker) — UNTOUCHED.
    const native = await row("d-native");
    expect(native.config_version).toBe(V12);
    expect(eq(native.config_json, envelope(dc("native"), "user"))).toBe(true);

    // multi-portlet operator row — UNTOUCHED (siblings preserved).
    const multi = await row("d-multi");
    expect(multi.config_version).toBe(V12);
    expect((multi.config_json as { portlets: unknown[] }).portlets).toHaveLength(2);
    // extension row — UNTOUCHED.
    expect(eq((await row("d-ext")).config_json, envelope(dc("ext"), "organization"))).toBe(true);

    // a MARKED migrated row WAS reverted to a valid 1.1 body.
    const reverted = await row("d-pure-v10");
    expect(reverted.config_version).toBe("1.1.0");
    expect(eq(reverted.config_json, expectDc(pureV10(), "dashboards:d-pure-v10"))).toBe(true);
    expect(DashboardConfigV1_1Schema.safeParse(reverted.config_json).success).toBe(true);
    // the adversarial rows reverted too (to their normalized 1.1 bodies).
    expect((await row("adv-grid-neg")).config_version).toBe("1.1.0");
    expect(DashboardConfigV1_1Schema.safeParse((await row("adv-scalar")).config_json).success).toBe(true);
  });

  it("up()→down()→up() round-trips: marked rows re-migrate to identical valid envelopes; untouched rows stay put", async () => {
    const res = await up();
    expect(res.ranNames.some((n) => n.includes("0006_dashboards-v12"))).toBe(true);
    const r = await row("d-pure-v10");
    expect(eq(r.config_json, wrapMigratedEnvelope(expectDc(pureV10(), "dashboards:d-pure-v10"), "user"))).toBe(true);
    expect(registryErrors(r.config_json)).toEqual([]);
    // native + multi-portlet STILL untouched after the full cycle.
    expect(eq((await row("d-native")).config_json, envelope(dc("native"), "user"))).toBe(true);
    expect(eq((await row("d-multi")).config_json, multiEnvelope(dc("multi"), "team"))).toBe(true);
  });
});

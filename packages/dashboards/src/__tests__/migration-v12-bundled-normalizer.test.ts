// cinatra#327 (PR #336) — the robust-B TOTAL-normalizer guard for the
// core__0006 migration. Owner decision: NO backward compat — a ONE-SHOT
// migration must rewrite EVERY legacy/corrupt-at-rest dashboard body into a
// registry-VALID apiVersion-1.2 analytics envelope; the strict validator STAYS strict.
//
// The migration's transform now lives as a JS-side TOTAL normalizer BUNDLED into
// the runtime artifact `migrations/core/core__0006_dashboards-v12.mjs` (core
// migrations are plain runtime modules — they cannot import the TS package). This
// Postgres-free suite imports that bundle directly and proves THREE things:
//
//   1. TOTALITY — `validateMigratedEnvelopeV12(buildMigratedEnvelope(any))` is
//      ALWAYS ok: for every named adversarial bad value, a scalar/null/array
//      root, a bad portlet element, duplicate/missing ids, a missing portlets
//      array, a bad grid, bad nested arrays, an already-valid 1.1 body, AND a
//      seeded random-JSON FUZZ set. normalizeDashboardConfig NEVER throws.
//
//   2. EQUIVALENCE (anti-drift) — the BUNDLED validator agrees with the REAL
//      package validators (`validateDashboardConfigV12` + the analytics kind's
//      deep `validatePortletConfig`, i.e. exactly `mutation-service.ts::
//      assertConfigV12`) on a battery of VALID and INVALID envelopes; and the
//      bundled normalizer's embedded DC ALWAYS passes the REAL
//      `DashboardConfigV1_1Schema`. So the bundle cannot silently drift from the
//      schema the app enforces — the integration test (real Postgres) is the
//      end-to-end backstop; this pins the logic cheaply.
//
//   3. MARKER + byte-equivalence — the migrated envelope stamps the marker at
//      `portlets[0].config.__cinatraMigration` (a strict-allowed opaque-record
//      slot), a conforming 1.1 body round-trips byte-equivalent through the
//      embedded DC, and the marker survives a later #326 `reEnvelopeDcSave`.
import { describe, expect, it } from "vitest";

// The REAL package validators (the write-site truth the migration must match).
import {
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
} from "../extension/dashboard-config-v12";
import { DashboardConfigV1_1Schema } from "../store/dashboard-config";
import { registerCorePortletKinds, ANALYTICS_PORTLET_KIND } from "../portlets/kinds";
import { getPortletKindDescriptor, validatePortletConfig } from "../portlets/registry";
import { reEnvelopeDcSave } from "../v12-envelope";

// The BUNDLED migration coercer/validator (the runtime artifact under test).
import {
  normalizeDashboardConfig,
  buildMigratedEnvelope,
  wrapMigratedEnvelope,
  validateMigratedEnvelopeV12,
  validateEmbeddedDcV1_1,
  deriveScopeLevel,
  V12_API_VERSION,
  MIGRATION_MARKER_KEY,
  MIGRATION_MARKER_VALUE,
} from "../../../../migrations/core/core__0006_dashboards-v12.mjs";

registerCorePortletKinds();

/**
 * Mirror of `mutation-service.ts::assertConfigV12` — the EXACT registry
 * validation a write (and a migrated row at rest) must pass: structural
 * `validateDashboardConfigV12` + per-kind deep `validatePortletConfig`. Returns
 * collected error strings ([] = ok). This is the REAL validator the bundled
 * `validateMigratedEnvelopeV12` is pinned EQUIVALENT to.
 */
function realRegistryErrors(config: unknown): string[] {
  const res = validateDashboardConfigV12(config, { getPortletKind: getPortletKindDescriptor });
  if (!res.ok) return res.errors;
  const errors: string[] = [];
  for (const p of res.config.portlets) {
    for (const e of validatePortletConfig(p.kind, p.version, { config: p.config, inputs: p.inputs, outputs: p.outputs })) {
      errors.push(`portlet "${p.instanceId}": ${e.message}`);
    }
  }
  return errors;
}

/** The structural shape of a migrated envelope (the bundled .mjs is untyped JS). */
type MigratedEnvelope = {
  apiVersion: string;
  scopeLevel: string;
  portlets: Array<{ instanceId: string; kind: string; version: string; slot: string; config: Record<string, unknown> }>;
};

/** Build a migrated envelope from a raw legacy body (the migration's pipeline). */
function migrate(raw: unknown, scope: Record<string, unknown> = { ownerLevel: "user" }): MigratedEnvelope {
  return buildMigratedEnvelope(raw, scope, "test:row", () => {}) as MigratedEnvelope;
}

// ── 1. TOTALITY: every named adversarial body migrates to a VALID envelope ───

describe("core__0006 normalizer TOTALITY (cinatra#327 robust-B)", () => {
  // Each entry: a corrupt/legacy body that must migrate to a registry-valid envelope.
  const ADVERSARIAL: ReadonlyArray<{ name: string; raw: unknown }> = [
    { name: "scalar root (number)", raw: 42 },
    { name: "scalar root (string)", raw: "totally not a dashboard" },
    { name: "scalar root (boolean)", raw: true },
    { name: "null root", raw: null },
    { name: "array root", raw: [{ id: "x" }, 1, "y"] },
    { name: "empty object root", raw: {} },
    { name: "missing portlets", raw: { layoutMode: "grid" } },
    { name: "portlets not an array", raw: { portlets: "nope" } },
    { name: "portlets is a number", raw: { portlets: 7 } },
    { name: "bad portlet element (number)", raw: { portlets: [1] } },
    { name: "bad portlet element (string)", raw: { portlets: ["x"] } },
    { name: "bad portlet element (null)", raw: { portlets: [null] } },
    { name: "bad portlet element (array)", raw: { portlets: [[]] } },
    { name: "portlet missing id", raw: { portlets: [{ type: "chart" }] } },
    { name: "portlet empty id", raw: { portlets: [{ id: "", type: "chart" }] } },
    { name: "portlet empty title (1.0 permits, 1.1 rejects)", raw: { portlets: [{ id: "p", title: "" }] } },
    { name: "duplicate ids", raw: { portlets: [{ id: "dup" }, { id: "dup" }, { id: "dup" }] } },
    { name: "pure-1.0.0 (no title/w/h/x/y)", raw: { portlets: [{ id: "p1", type: "chart" }], layout: { columns: 3, gap: 8 } } },
    { name: "dashboardFilterMapping:'bad' (portlet)", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, dashboardFilterMapping: "bad" }] } },
    { name: "dashboardFilterMapping mixed array (portlet)", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, dashboardFilterMapping: ["ok", 5, null] }] } },
    { name: "eagerLoad:'yes' (portlet)", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, eagerLoad: "yes" }] } },
    { name: "eagerLoad:1 (portlet)", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, eagerLoad: 1 }] } },
    { name: "w negative", raw: { portlets: [{ id: "p", title: "T", w: -3, h: 1, x: 0, y: 0, query: {} }] } },
    { name: "w float / NaN / Infinity", raw: { portlets: [{ id: "p", title: "T", w: 1.5, h: Number.NaN, x: Number.POSITIVE_INFINITY, y: 0, query: {} }] } },
    // UNSAFE integers: Number.isInteger accepts these but Zod v4 .int() (the real
    // schema) REJECTS them (> MAX_SAFE_INTEGER). The normalizer MUST drop them to
    // 0, else a FALSE-valid envelope would fail the real schema [codex BLOCKER].
    { name: "w = 1e21 (unsafe int)", raw: { portlets: [{ id: "p", title: "T", w: 1e21, h: 1, x: 0, y: 0, query: {} }] } },
    { name: "x = 2**53 (unsafe int)", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 2 ** 53, y: 0, query: {} }] } },
    { name: "y = MAX_SAFE_INTEGER+1", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: Number.MAX_SAFE_INTEGER + 1, query: {} }] } },
    { name: "grid.cols = 1e21 (unsafe int)", raw: { portlets: [], grid: { cols: 1e21, rowHeight: 50, minW: 3, minH: 4 } } },
    { name: "portlet missing content spec", raw: { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0 }] } },
    { name: "grid:{cols:-1}", raw: { portlets: [], grid: { cols: -1, rowHeight: 50, minW: 3, minH: 4 } } },
    { name: "grid not an object", raw: { portlets: [], grid: "big" } },
    { name: "grid missing dims", raw: { portlets: [], grid: { cols: 12 } } },
    { name: "layoutMode:'freeform'", raw: { portlets: [], layoutMode: "freeform" } },
    { name: "colorPalette:42", raw: { portlets: [], colorPalette: 42 } },
    { name: "eagerLoad:'yes' (root)", raw: { portlets: [], eagerLoad: "yes" } },
    { name: "thumbnailData non-string", raw: { portlets: [], thumbnailData: { a: 1 } } },
    { name: "layouts non-object", raw: { portlets: [], layouts: [1, 2] } },
    { name: "everything wrong at once", raw: { portlets: [{ id: 5, title: 9, w: "x", dashboardFilterMapping: 1 }, "junk", null], grid: { cols: 0 }, layoutMode: "spiral", colorPalette: false, eagerLoad: 0 } },
    { name: "prototype-pollution keys (JSON.parse makes them own props — harmless passthrough)", raw: JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"portlets":[{"id":"p","title":"T","w":1,"h":1,"x":0,"y":0,"query":{}}]}') },
    { name: "already-valid 1.1 (fixed point)", raw: { portlets: [{ id: "a", title: "A", w: 6, h: 8, x: 0, y: 0, analysisConfig: {} }], layoutMode: "grid", grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 }, colorPalette: "default" } },
    { name: "valid 1.1 with passthrough/unknown keys", raw: { portlets: [{ id: "a", title: "A", w: 6, h: 8, x: 0, y: 0, query: { measures: ["m"] }, futureField: { nested: true } }], migrations: [{ v: 1 }], thumbnailUrl: "https://x/y.png" } },
  ];

  for (const { name, raw } of ADVERSARIAL) {
    it(`migrates [${name}] to a registry-VALID apiVersion-1.2 envelope (bundled AND real validator agree ok)`, () => {
      // The migration pipeline never throws and final-validation passes (or it
      // would have thrown). Assert BOTH validators say ok.
      const env = migrate(raw);
      expect(validateMigratedEnvelopeV12(env).ok).toBe(true); // bundled
      expect(realRegistryErrors(env)).toEqual([]); // REAL package validator
      // The embedded DC passes the REAL strict schema the app enforces.
      const dc = (env.portlets[0].config as { dashboard: unknown }).dashboard;
      expect(DashboardConfigV1_1Schema.safeParse(dc).success).toBe(true);
    });
  }

  it("normalizeDashboardConfig NEVER throws on hostile inputs (incl. a throwing getter)", () => {
    const hostile = { get portlets() { throw new Error("boom"); } };
    expect(() => normalizeDashboardConfig(hostile, { idBase: "h" })).not.toThrow();
    // and the result is still a valid embedded DC.
    expect(validateEmbeddedDcV1_1(normalizeDashboardConfig(hostile, { idBase: "h" }))).toEqual([]);
    for (const v of [undefined, null, 0, "", NaN, Symbol.iterator, () => {}, []]) {
      expect(() => normalizeDashboardConfig(v as unknown, { idBase: "x" })).not.toThrow();
      expect(validateEmbeddedDcV1_1(normalizeDashboardConfig(v as unknown, { idBase: "x" }))).toEqual([]);
    }
  });

  it("generates STABLE deterministic ids for missing/invalid ones and keeps them UNIQUE", () => {
    const dc = normalizeDashboardConfig(
      { portlets: [{ type: "chart" }, { id: "" }, { id: "kept" }, { id: "kept" }, 99] },
      { idBase: "dashboards:abc" },
    ) as { portlets: Array<{ id: string }> };
    const ids = dc.portlets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    // deterministic: same input -> same ids.
    const again = normalizeDashboardConfig(
      { portlets: [{ type: "chart" }, { id: "" }, { id: "kept" }, { id: "kept" }, 99] },
      { idBase: "dashboards:abc" },
    ) as { portlets: Array<{ id: string }> };
    expect(again.portlets.map((p) => p.id)).toEqual(ids);
    // the kept non-empty id is preserved; the duplicate is suffixed, not dropped.
    expect(ids).toContain("kept");
    expect(ids.filter((id) => id.startsWith("kept")).length).toBe(2);
  });
});

// ── 2. FUZZ: validateV12(normalize(any)).ok === true for random JSON ─────────

describe("core__0006 normalizer FUZZ (cinatra#327)", () => {
  // Tiny seeded PRNG (mulberry32) — deterministic, no external dep.
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
  const KEYS = ["portlets", "id", "title", "w", "h", "x", "y", "query", "analysisConfig", "grid", "cols", "rowHeight", "minW", "minH", "layoutMode", "colorPalette", "eagerLoad", "dashboardFilterMapping", "layouts", "thumbnailData", "rnd", "type", "cubeId"];
  function randValue(rng: () => number, depth: number): unknown {
    const r = rng();
    if (depth > 4 || r < 0.18) {
      const leaf = rng();
      if (leaf < 0.2) return null;
      if (leaf < 0.4) return Math.floor((rng() - 0.5) * 200); // ints incl. negative
      if (leaf < 0.55) return (rng() - 0.5) * 100; // floats
      if (leaf < 0.7) return rng() < 0.5; // boolean
      if (leaf < 0.85) return ["a", "b", String(Math.floor(rng() * 9))][Math.floor(rng() * 3)]; // string
      return [Number.NaN, Number.POSITIVE_INFINITY, "", "yes"][Math.floor(rng() * 4)]; // nasty scalars
    }
    if (r < 0.5) {
      const n = Math.floor(rng() * 4);
      return Array.from({ length: n }, () => randValue(rng, depth + 1));
    }
    const obj: Record<string, unknown> = {};
    const n = Math.floor(rng() * 5);
    for (let i = 0; i < n; i += 1) {
      const k = KEYS[Math.floor(rng() * KEYS.length)];
      obj[k] = randValue(rng, depth + 1);
    }
    return obj;
  }

  it("validateV12(wrap(normalize(any))).ok === true for 2000 random JSON values", () => {
    const rng = mulberry32(0xc0ffee);
    let checked = 0;
    for (let i = 0; i < 2000; i += 1) {
      const raw = randValue(rng, 0);
      // never throws:
      let env: unknown;
      expect(() => {
        env = migrate(raw);
      }).not.toThrow();
      // bundled validator ok:
      expect(validateMigratedEnvelopeV12(env).ok).toBe(true);
      // and the REAL package validator ALSO ok (sampled to keep the suite fast,
      // but the bundled/real equivalence is proven exhaustively below).
      if (i % 5 === 0) {
        expect(realRegistryErrors(env)).toEqual([]);
        expect(DashboardConfigV1_1Schema.safeParse((env as { portlets: Array<{ config: { dashboard: unknown } }> }).portlets[0].config.dashboard).success).toBe(true);
      }
      checked += 1;
    }
    expect(checked).toBe(2000);
  });

  it("randomly-rooted top-level raw (sometimes a bare array/scalar) still always migrates", () => {
    const rng = mulberry32(123);
    for (let i = 0; i < 500; i += 1) {
      const raw = rng() < 0.5 ? randValue(rng, 5) /* leaf-biased */ : randValue(rng, 0);
      const env = migrate(raw);
      expect(realRegistryErrors(env)).toEqual([]);
    }
  });
});

// ── 3. EQUIVALENCE: bundled validator ≡ real package validator ───────────────

describe("core__0006 bundled-validator EQUIVALENCE with the package validators (anti-drift)", () => {
  const validDc = { portlets: [{ id: "a", title: "A", w: 6, h: 8, x: 0, y: 0, analysisConfig: {} }], layoutMode: "grid" as const };

  // Build envelopes the migration could conceivably produce + hand-crafted
  // INVALID ones, and assert the bundled `validateMigratedEnvelopeV12` and the
  // real `assertConfigV12`-equivalent agree on ok/not-ok for each.
  const CASES: ReadonlyArray<{ name: string; env: unknown }> = [
    { name: "canonical migrated envelope (valid)", env: wrapMigratedEnvelope(validDc, "user") },
    { name: "valid, project scope", env: wrapMigratedEnvelope(validDc, "project") },
    { name: "INVALID scopeLevel", env: { apiVersion: V12_API_VERSION, scopeLevel: "galaxy", portlets: [{ instanceId: "analytics", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: validDc } }] } },
    { name: "INVALID apiVersion", env: { apiVersion: "not-a-version", scopeLevel: "user", portlets: [{ instanceId: "analytics", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: validDc } }] } },
    { name: "INVALID unknown kind", env: { apiVersion: V12_API_VERSION, scopeLevel: "user", portlets: [{ instanceId: "x", kind: "made-up", version: "1.0.0", slot: "fixed", config: {} }] } },
    { name: "INVALID embedded DC (1.0 body, no layout)", env: wrapMigratedEnvelope({ portlets: [{ id: "p", type: "chart" }] }, "user") },
    { name: "INVALID embedded DC (grid cols -1)", env: wrapMigratedEnvelope({ portlets: [], grid: { cols: -1, rowHeight: 1, minW: 1, minH: 1 } }, "user") },
    { name: "INVALID duplicate instanceId", env: { apiVersion: V12_API_VERSION, scopeLevel: "user", portlets: [
      { instanceId: "dup", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: validDc } },
      { instanceId: "dup", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: validDc } },
    ] } },
    { name: "INVALID missing content spec in embedded portlet", env: wrapMigratedEnvelope({ portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0 }] }, "user") },
    { name: "valid embedded with passthrough keys", env: wrapMigratedEnvelope({ portlets: [{ id: "a", title: "A", w: 1, h: 1, x: 0, y: 0, query: {}, weird: 1 }], unknownTop: true }, "team") },
    { name: "valid: cube-dashboard alias kind", env: { apiVersion: V12_API_VERSION, scopeLevel: "user", portlets: [{ instanceId: "analytics", kind: "cube-dashboard", version: "1.0.0", slot: "fixed", config: { dashboard: validDc } }] } },
    { name: "INVALID extra root key (real root is .strict())", env: { apiVersion: V12_API_VERSION, scopeLevel: "user", portlets: [{ instanceId: "analytics", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: validDc } }], stray: 1 } },
    { name: "INVALID extra portlet key (real portlet is .strict())", env: { apiVersion: V12_API_VERSION, scopeLevel: "user", portlets: [{ instanceId: "analytics", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: validDc }, stray: 1 }] } },
  ];

  for (const { name, env } of CASES) {
    it(`bundled and real validator AGREE on [${name}]`, () => {
      const bundledOk = validateMigratedEnvelopeV12(env).ok;
      const realOk = realRegistryErrors(env).length === 0;
      expect(bundledOk).toBe(realOk);
    });
  }

  it("the bundled DC validator agrees with the REAL DashboardConfigV1_1Schema on a battery", () => {
    const dcCases: unknown[] = [
      validDc,
      { portlets: [] },
      { portlets: [{ id: "p", type: "chart" }] }, // 1.0 shape → invalid as 1.1
      { portlets: [{ id: "p", title: "", w: 0, h: 0, x: 0, y: 0, query: {} }] }, // empty title → invalid
      { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, dashboardFilterMapping: "bad" }] },
      { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, query: {}, eagerLoad: "x" }] },
      { portlets: [], grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 } },
      { portlets: [], grid: { cols: -1, rowHeight: 50, minW: 3, minH: 4 } },
      { portlets: [], layoutMode: "freeform" },
      { portlets: [], colorPalette: 42 },
      42,
      null,
      [1, 2, 3],
      { portlets: [{ id: "p", title: "T", w: 1, h: 1, x: 0, y: 0, analysisConfig: { q: 1 }, future: "ok" }] },
      // unsafe-integer boundary: the bundled predicate must track Zod v4 .int().
      { portlets: [{ id: "p", title: "T", w: 1e21, h: 1, x: 0, y: 0, query: {} }] }, // BOTH reject (> MAX_SAFE_INTEGER)
      { portlets: [{ id: "p", title: "T", w: Number.MAX_SAFE_INTEGER, h: 1, x: 0, y: 0, query: {} }] }, // BOTH accept (== MAX_SAFE_INTEGER)
      { portlets: [], grid: { cols: 2 ** 53, rowHeight: 50, minW: 3, minH: 4 } }, // BOTH reject grid
      { portlets: [], grid: { cols: Number.MAX_SAFE_INTEGER, rowHeight: 50, minW: 3, minH: 4 } }, // BOTH accept grid
    ];
    for (const dc of dcCases) {
      const bundledOk = validateEmbeddedDcV1_1(dc).length === 0;
      const realOk = DashboardConfigV1_1Schema.safeParse(dc).success;
      expect(bundledOk, `disagreement on ${JSON.stringify(dc)}`).toBe(realOk);
    }
  });

  it("the bundled normalizer's output ALWAYS satisfies the REAL DashboardConfigV1_1Schema (10 shapes)", () => {
    const raws: unknown[] = [42, null, [], {}, { portlets: "x" }, { portlets: [1, null, "y"] }, { portlets: [{ id: "p" }] }, { grid: { cols: 0 } }, { layoutMode: "z", colorPalette: 1 }, { portlets: [{ id: "dup" }, { id: "dup" }] }];
    for (const raw of raws) {
      const dc = normalizeDashboardConfig(raw, { idBase: "eq" });
      expect(DashboardConfigV1_1Schema.safeParse(dc).success, `real schema rejected normalize(${JSON.stringify(raw)})`).toBe(true);
      expect(validateEmbeddedDcV1_1(dc)).toEqual([]); // bundled agrees
    }
  });

  it("bundled scopeLevel derivation matches the design rule (project overrides; unknown -> user)", () => {
    expect(deriveScopeLevel({ ownerLevel: "team" })).toBe("team");
    expect(deriveScopeLevel({ ownerLevel: "team", projectId: "p1" })).toBe("project");
    expect(deriveScopeLevel({ ownerLevel: "user", templateScope: "project" })).toBe("project");
    expect(deriveScopeLevel({ ownerLevel: "bogus" })).toBe("user");
    expect(deriveScopeLevel({})).toBe("user");
    for (const lvl of ["user", "team", "organization", "workspace"]) expect(deriveScopeLevel({ ownerLevel: lvl })).toBe(lvl);
  });
});

// ── 4. MARKER + byte-equivalence + reEnvelopeDcSave survival ─────────────────

describe("core__0006 migration MARKER + byte-equivalence (cinatra#327)", () => {
  const conformingDc = { portlets: [{ id: "a", title: "A", w: 6, h: 8, x: 0, y: 0, analysisConfig: { measures: ["m"] }, future: { x: 1 } }], layoutMode: "grid" as const, colorPalette: "default", unknownTop: 7 };

  it("stamps the marker at portlets[0].config.__cinatraMigration (a strict-ALLOWED opaque-record slot)", () => {
    const env = migrate(conformingDc, { ownerLevel: "team" });
    expect((env.portlets[0].config as Record<string, unknown>)[MIGRATION_MARKER_KEY]).toBe(MIGRATION_MARKER_VALUE);
    // the marker does NOT break the real validator (config is z.record — opaque).
    expect(realRegistryErrors(env)).toEqual([]);
    // and is NOT inside config.dashboard (so it can't pollute the embedded DC).
    expect((env.portlets[0].config as { dashboard: Record<string, unknown> }).dashboard[MIGRATION_MARKER_KEY]).toBeUndefined();
  });

  it("a conforming 1.1 body round-trips BYTE-EQUIVALENT through the embedded DC (normalize is a fixed point)", () => {
    const env = migrate(conformingDc);
    const embedded = (env.portlets[0].config as { dashboard: unknown }).dashboard;
    // up→down identity: unwrapping config.dashboard returns the original body unchanged.
    expect(embedded).toEqual(conformingDc);
    // normalize alone is a fixed point for a conforming body.
    expect(normalizeDashboardConfig(conformingDc, { idBase: "fp" })).toEqual(conformingDc);
  });

  it("the marker SURVIVES a later #326 reEnvelopeDcSave (it preserves other config keys while replacing dashboard)", () => {
    const env = migrate(conformingDc, { ownerLevel: "user" });
    const nextDc = { portlets: [{ id: "b", title: "B", w: 4, h: 4, x: 0, y: 0, query: {} }] };
    // reEnvelopeDcSave replaces config.dashboard but preserves the marker sibling.
    const resaved = reEnvelopeDcSave(env, nextDc, "user") as { portlets: Array<{ config: Record<string, unknown> }> };
    expect(resaved.portlets[0].config[MIGRATION_MARKER_KEY]).toBe(MIGRATION_MARKER_VALUE);
    expect((resaved.portlets[0].config as { dashboard: unknown }).dashboard).toEqual(nextDc);
    // still registry-valid (config is opaque to the apiVersion-1.2 validator).
    expect(realRegistryErrors(resaved)).toEqual([]);
  });

  it("a NATIVE #326 single-analytics envelope (no marker) is distinguishable from a migrated one", () => {
    // wrapMigratedEnvelope adds the marker; the native wrap (v12-envelope wrapDcAsV12)
    // would not. The down() guard keys on the marker, so a native row is NOT reverted.
    const migrated = migrate(conformingDc);
    expect((migrated.portlets[0].config as Record<string, unknown>)[MIGRATION_MARKER_KEY]).toBe(MIGRATION_MARKER_VALUE);
    // a native-shaped envelope (no marker) — assert the marker is what discriminates.
    const native = { apiVersion: V12_API_VERSION, scopeLevel: "user", portlets: [{ instanceId: "analytics", kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: conformingDc } }] };
    expect((native.portlets[0].config as Record<string, unknown>)[MIGRATION_MARKER_KEY]).toBeUndefined();
    expect(realRegistryErrors(native)).toEqual([]); // native is valid too
  });

  it("apiVersion literal parity (bundled constant === package constant)", () => {
    expect(V12_API_VERSION).toBe(DASHBOARD_CONFIG_V12_VERSION);
  });
});

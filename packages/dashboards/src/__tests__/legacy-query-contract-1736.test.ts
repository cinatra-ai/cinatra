/**
 * cinatra#1736 — the legacy portlet `query` contract, end to end.
 *
 * drizzle-cube's `LegacyPortlet.query` is a JSON STRING of a CubeQuery/
 * MultiQuery. Before this fix an object-shaped `query` passed the MCP tool
 * schema (`config: z.unknown()`), passed the registry validator
 * (`query: z.unknown()`), was persisted, and died only in the browser —
 * `configMigration`'s `JSON.parse` fails and the portlet spins forever.
 *
 * Four boundaries are asserted here:
 *   1. SCHEMA — `DashboardConfigV1_1Schema` normalizes object queries to their
 *      JSON string, treats `null` as absent, and rejects unparseable values
 *      with the actionable contract message.
 *   2. WRITE — the mutation-service path (`normalizeDcBodyForWrite` +
 *      `reEnvelopeDcSave`) persists the NORMALIZED body: the envelope that
 *      would land in the row carries string queries only.
 *   3. RENDER — `parseAnalyticsDashboardForRender` salvages per portlet: the
 *      persisted-shape repro (6 object-query portlets, mirroring dashboard
 *      c9b24648) all normalize and render; a truly broken portlet is excluded
 *      and reported instead of reaching the grid (where it would spin).
 *   4. MCP — `dashboardsCreateSchema` documents + enforces the shape at the
 *      tool boundary for both bare configs and apiVersion 1.2 envelopes.
 *
 * The full-chain test (MCP parse → write normalization → registry validation →
 * render parse) drives the same pure functions the runtime uses; the
 * DB-landing equivalent lives in the DASH_DB_IT-gated integration suite.
 */
import { describe, expect, it } from "vitest";

import {
  DashboardConfigV1_1Schema,
  LEGACY_QUERY_CONTRACT_MESSAGE,
} from "../store/dashboard-config";
import {
  normalizeDcBodyForWrite,
  normalizeV12AnalyticsForWrite,
  parseAnalyticsDashboardForRender,
  reEnvelopeDcSave,
  unwrapV12ToDc,
} from "../v12-envelope";
import { getPortletKindDescriptor } from "../portlets/registry";
import { registerCorePortletKinds } from "../portlets/kinds";
import { dashboardsCreateSchema } from "../mcp/schemas";
import {
  DASHBOARD_CONFIG_V12_VERSION,
  validateDashboardConfigV12,
} from "../extension/dashboard-config-v12";

/** A CubeQuery-ish object, the shape the #1736 agent actually emitted. */
const CUBE_QUERY = {
  measures: ["AgentRuns.count"],
  dimensions: ["AgentRuns.status"],
  timeDimensions: [{ dimension: "AgentRuns.startedAt", granularity: "day" }],
};

function portlet(id: string, over: Record<string, unknown> = {}) {
  return { id, title: `Portlet ${id}`, w: 6, h: 4, x: 0, y: 0, ...over };
}

/** Mirrors the repro dashboard: 6 portlets, every `query` an OBJECT. */
function reproDashboard() {
  return {
    portlets: [1, 2, 3, 4, 5, 6].map((n) =>
      portlet(`p${n}`, { query: { ...CUBE_QUERY, limit: n }, chartType: "bar" }),
    ),
    layoutMode: "grid",
    grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
  };
}

describe("1. schema — legacy query normalization/enforcement", () => {
  it("normalizes an object query to its JSON string", () => {
    const r = DashboardConfigV1_1Schema.safeParse({
      portlets: [portlet("a", { query: CUBE_QUERY })],
    });
    expect(r.success).toBe(true);
    const q = r.success ? (r.data.portlets[0] as { query?: unknown }).query : undefined;
    expect(typeof q).toBe("string");
    expect(JSON.parse(q as string)).toEqual(CUBE_QUERY);
  });

  it("keeps a valid JSON-string query untouched", () => {
    const s = JSON.stringify(CUBE_QUERY);
    const r = DashboardConfigV1_1Schema.safeParse({
      portlets: [portlet("a", { query: s })],
    });
    expect(r.success).toBe(true);
    expect(r.success ? (r.data.portlets[0] as { query?: unknown }).query : null).toBe(s);
  });

  it("treats query: null as absent (old rows) — analysisConfig still satisfies content", () => {
    const r = DashboardConfigV1_1Schema.safeParse({
      portlets: [portlet("a", { query: null, analysisConfig: { some: "config" } })],
    });
    expect(r.success).toBe(true);
    expect(r.success ? (r.data.portlets[0] as { query?: unknown }).query : "x").toBeUndefined();
  });

  it("rejects a non-JSON string query with the contract message", () => {
    const r = DashboardConfigV1_1Schema.safeParse({
      portlets: [portlet("a", { query: "[object Object]" })],
    });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join(" ")).toContain(
      LEGACY_QUERY_CONTRACT_MESSAGE,
    );
  });

  it("rejects a numeric query with the contract message", () => {
    const r = DashboardConfigV1_1Schema.safeParse({
      portlets: [portlet("a", { query: 42 })],
    });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join(" ")).toContain(
      LEGACY_QUERY_CONTRACT_MESSAGE,
    );
  });
});

describe("2. write — the persisted envelope carries string queries only", () => {
  it("normalizeDcBodyForWrite + reEnvelopeDcSave stringify object queries before the row", () => {
    const wrapped = reEnvelopeDcSave(undefined, normalizeDcBodyForWrite(reproDashboard()), "user");
    const embedded = unwrapV12ToDc(wrapped) as { portlets: { query?: unknown }[] };
    expect(embedded.portlets).toHaveLength(6);
    for (const p of embedded.portlets) expect(typeof p.query).toBe("string");
  });

  it("normalizeV12AnalyticsForWrite normalizes inside a supplied envelope, siblings untouched", () => {
    const sibling = { instanceId: "other", kind: "entity-count", version: "1.0.0", slot: "fixed", config: { of: "x" } };
    const envelope = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "user",
      portlets: [
        sibling,
        {
          instanceId: "analytics",
          kind: "analytics",
          version: "1.0.0",
          slot: "fixed",
          config: { dashboard: reproDashboard() },
        },
      ],
    };
    const out = normalizeV12AnalyticsForWrite(envelope) as { portlets: unknown[] };
    expect(out.portlets[0]).toEqual(sibling);
    const embedded = unwrapV12ToDc(out) as { portlets: { query?: unknown }[] };
    for (const p of embedded.portlets) expect(typeof p.query).toBe("string");
  });
});

describe("3. render — per-portlet salvage, never a spinner for broken portlets", () => {
  it("the persisted-shape repro (6 object queries) fully renders after normalization", () => {
    const parsed = parseAnalyticsDashboardForRender(reproDashboard());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.broken).toHaveLength(0);
    expect(parsed.config.portlets).toHaveLength(6);
    for (const p of parsed.config.portlets as { query?: unknown }[]) {
      expect(typeof p.query).toBe("string");
    }
  });

  it("a broken portlet is excluded + reported; siblings survive; its layout entries drop", () => {
    const parsed = parseAnalyticsDashboardForRender({
      portlets: [
        portlet("good", { query: CUBE_QUERY }),
        portlet("bad", { query: "[object Object]" }),
      ],
      layouts: { lg: [{ i: "good", x: 0 }, { i: "bad", x: 6 }] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.portlets.map((p) => (p as { id: string }).id)).toEqual(["good"]);
    expect(parsed.broken).toHaveLength(1);
    expect(parsed.broken[0]).toMatchObject({ id: "bad", title: "Portlet bad" });
    expect(parsed.broken[0]!.reason).toContain(LEGACY_QUERY_CONTRACT_MESSAGE);
    const lg = (parsed.config as { layouts?: Record<string, { i: string }[]> }).layouts?.lg ?? [];
    expect(lg.map((l) => l.i)).toEqual(["good"]);
  });

  it("everything broken → ok with zero renderable portlets (caller shows the error card only)", () => {
    const parsed = parseAnalyticsDashboardForRender({
      portlets: [portlet("bad1", { query: 1 }), portlet("bad2", { query: "not json" })],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.portlets).toHaveLength(0);
    expect(parsed.broken).toHaveLength(2);
  });

  it("unreadable top-level structure → ok:false with a reason", () => {
    const parsed = parseAnalyticsDashboardForRender("garbage");
    expect(parsed.ok).toBe(false);
  });
});

describe("4. MCP boundary + full chain (create → validate → persist-shape → render)", () => {
  const baseInput = {
    name: "Team Agent Operations",
    ownerLevel: "user" as const,
    ownerId: "u-1",
  };

  it("dashboards_create accepts the bare repro config and NORMALIZES its queries at parse", () => {
    const parsed = dashboardsCreateSchema.parse({ ...baseInput, config: reproDashboard() });
    const cfg = parsed.config as { portlets: { query?: unknown }[] };
    for (const p of cfg.portlets) expect(typeof p.query).toBe("string");
  });

  it("dashboards_create rejects an unparseable query with the contract message", () => {
    const r = dashboardsCreateSchema.safeParse({
      ...baseInput,
      config: { portlets: [portlet("a", { query: "not json at all" })] },
    });
    expect(r.success).toBe(false);
    expect(r.success ? "" : JSON.stringify(r.error.issues)).toContain(
      "must be a JSON string",
    );
  });

  it("dashboards_create accepts an apiVersion 1.2 envelope and normalizes the embedded dashboard", () => {
    const parsed = dashboardsCreateSchema.parse({
      ...baseInput,
      config: {
        apiVersion: DASHBOARD_CONFIG_V12_VERSION,
        scopeLevel: "user",
        portlets: [
          {
            instanceId: "analytics",
            kind: "analytics",
            version: "1.0.0",
            slot: "fixed",
            config: { dashboard: reproDashboard() },
          },
        ],
      },
    });
    const embedded = unwrapV12ToDc(parsed.config) as { portlets: { query?: unknown }[] };
    for (const p of embedded.portlets) expect(typeof p.query).toBe("string");
  });

  it("FULL CHAIN: MCP parse → write normalization → registry validation → render parse", () => {
    // 1. the agent's tool call (object queries — the #1736 shape).
    const input = dashboardsCreateSchema.parse({ ...baseInput, config: reproDashboard() });
    // 2. the mutation-service write path (normalize + wrap), as persisted.
    const persisted = reEnvelopeDcSave(undefined, normalizeDcBodyForWrite(input.config), "user");
    // 3. the registry validation the mutation service runs before the row
    //    lands (same pieces `assertConfigV12` wires: registered core kinds +
    //    the envelope validator with the real descriptor lookup).
    registerCorePortletKinds();
    const validated = validateDashboardConfigV12(persisted, {
      getPortletKind: getPortletKindDescriptor,
    });
    expect(validated.ok).toBe(true);
    // 4. what /dashboards/[id] renders from the persisted row.
    const render = parseAnalyticsDashboardForRender(
      (unwrapV12ToDc(persisted) as object)!,
    );
    expect(render.ok).toBe(true);
    if (!render.ok) return;
    expect(render.broken).toHaveLength(0);
    expect(render.config.portlets).toHaveLength(6);
  });
});

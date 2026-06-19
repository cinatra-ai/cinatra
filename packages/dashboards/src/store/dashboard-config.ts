/**
 * DashboardConfig — opaque JSON to the DB; Zod-validated at every write site.
 *
 * Two schema versions ship today:
 *
 *   Version 1.0.0. Portlets keyed by `type` discriminator; `query` is a flat
 *   record. Kept for backward read-compat — existing rows that wrote schema
 *   version 1.0.0 still parse.
 *
 *   Version 1.1.0. Portlets have w/h/x/y at the root + `analysisConfig`
 *   (canonical) or the legacy DC `query?: string` shape. All fields pass
 *   through so DC internals (`migrations`, `colorPalette`, `thumbnailData`)
 *   round-trip cleanly. This is the embedded drizzle-cube shape an apiVersion
 *   1.2 `analytics` portlet wraps at `config.dashboard`.
 *
 * As of cinatra#326, NEW operator/agent dashboards are persisted as the
 * apiVersion 1.2 envelope (`CURRENT_CONFIG_VERSION`, validated by the registry
 * validator, NOT this dispatcher) carrying that 1.1 config as an `analytics`
 * portlet. `parseDashboardConfig` stays the legacy (1.0.0/1.1.0) dispatcher —
 * it deliberately does NOT know apiVersion 1.2; the mutation service routes
 * apiVersion 1.2 to the registry validator.
 */
import { z } from "zod";

import { DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";

// ─────────────────────────────────────────────────────────────────────────
// Schema version 1.0.0 — permissive baseline.
// ─────────────────────────────────────────────────────────────────────────
const PortletBaseSchemaV1 = z.object({
  id: z.string().min(1),
  type: z.string().min(1), // 'kpi' | 'list' | 'chart' | 'table'
  title: z.string().optional(),
  cubeId: z.string().optional(),
  query: z.record(z.string(), z.unknown()).optional(),
});

export const DashboardConfigV1Schema = z.object({
  portlets: z.array(PortletBaseSchemaV1),
  layout: z
    .object({
      columns: z.number().int().positive().optional(),
      gap: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type DashboardConfigV1 = z.infer<typeof DashboardConfigV1Schema>;

// ─────────────────────────────────────────────────────────────────────────
// Schema version 1.1.0 — drizzle-cube DashboardConfig shape.
//
// Mirrors drizzle-cube's exported `DashboardConfig` + `PortletConfig` types
// without IMPORTING them (sdk-dashboard boundary — drizzle-cube types live
// behind the adapter). `.passthrough()` tolerates future DC fields so we
// don't have to re-ship the schema every minor DC release. `.superRefine()`
// enforces finite layout, non-empty id/title, and at least one usable content
// spec.
// ─────────────────────────────────────────────────────────────────────────
const PortletConfigV1_1 = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    w: z.number().int().nonnegative().refine(Number.isFinite),
    h: z.number().int().nonnegative().refine(Number.isFinite),
    x: z.number().int().nonnegative().refine(Number.isFinite),
    y: z.number().int().nonnegative().refine(Number.isFinite),
    // Canonical drizzle-cube portlet content — opaque to us; DC validates.
    analysisConfig: z.unknown().optional(),
    // Legacy DC portlet fields (passthrough; we don't validate).
    query: z.unknown().optional(),
    chartType: z.unknown().optional(),
    chartConfig: z.unknown().optional(),
    displayConfig: z.unknown().optional(),
    dashboardFilterMapping: z.array(z.string()).optional(),
    eagerLoad: z.boolean().optional(),
    analysisType: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((p, ctx) => {
    if (p.analysisConfig === undefined && p.query === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `Portlet ${p.id}: requires either analysisConfig or query`,
      });
    }
  });

const DashboardGridSettingsV1_1 = z.object({
  cols: z.number().int().positive(),
  rowHeight: z.number().int().positive(),
  minW: z.number().int().positive(),
  minH: z.number().int().positive(),
});

export const DashboardConfigV1_1Schema = z
  .object({
    portlets: z.array(PortletConfigV1_1),
    layoutMode: z.enum(["grid", "rows"]).optional(),
    grid: DashboardGridSettingsV1_1.optional(),
    rows: z.unknown().optional(),
    layouts: z.record(z.string(), z.unknown()).optional(),
    colorPalette: z.string().optional(),
    filters: z.unknown().optional(),
    eagerLoad: z.boolean().optional(),
    thumbnailData: z.string().optional(),
    thumbnailUrl: z.string().optional(),
  })
  .passthrough();

export type DashboardConfigV1_1 = z.infer<typeof DashboardConfigV1_1Schema>;

/** The canonical DashboardConfig union — extended as new versions ship. */
export type DashboardConfig = DashboardConfigV1 | DashboardConfigV1_1;

/**
 * Current `config_version` for NEW operator/agent dashboard writes (cinatra#326).
 *
 * Flipped from the legacy semver `1.1.0` to the apiVersion 1.2 literal: the
 * create/save paths now persist NEW dashboards as an apiVersion 1.2 envelope
 * carrying a single `analytics` portlet (the bare drizzle-cube config the
 * caller emits is wrapped server-side in the mutation service), so
 * `/dashboards/[id]` renders them through the one `PortletHost` path instead of
 * the legacy read-only branch. Re-exported from the apiVersion 1.2 module so
 * there is a SINGLE source for the literal (no duplicated string). Existing rows
 * written under schema versions 1.0.0/1.1.0 still parse via the dispatcher below
 * until the one-time migration (cinatra#327) rewrites them.
 */
export const CURRENT_CONFIG_VERSION = DASHBOARD_CONFIG_V12_VERSION;

/**
 * Validate a DashboardConfig payload against the schema for the given version.
 * Throws ZodError on failure — the mutation service catches and converts to
 * a 400 with structured detail.
 */
export function parseDashboardConfig(version: string, payload: unknown): DashboardConfig {
  switch (version) {
    case "1.0.0":
      return DashboardConfigV1Schema.parse(payload);
    case "1.1.0":
      return DashboardConfigV1_1Schema.parse(payload);
    default:
      throw new Error(
        `Unsupported DashboardConfig version: ${version}. ` +
          `Known versions: 1.0.0, 1.1.0.`,
      );
  }
}

/** Boolean variant — handy in MCP handlers that want a typed bool result. */
export function isValidDashboardConfig(version: string, payload: unknown): boolean {
  try {
    parseDashboardConfig(version, payload);
    return true;
  } catch {
    return false;
  }
}

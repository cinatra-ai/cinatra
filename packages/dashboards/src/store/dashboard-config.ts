/**
 * DashboardConfig — the embedded drizzle-cube shape an apiVersion 1.2
 * `analytics` portlet wraps at `config.dashboard`.
 *
 * Portlets have w/h/x/y at the root + `analysisConfig` (canonical) or the
 * legacy DC `query?: string` shape. All fields pass through so DC internals
 * (`migrations`, `colorPalette`, `thumbnailData`) round-trip cleanly.
 *
 * As of cinatra#326, NEW operator/agent dashboards are persisted as the
 * apiVersion 1.2 envelope (`CURRENT_CONFIG_VERSION`, validated by the registry
 * validator) carrying this config as an `analytics` portlet, and cinatra#327
 * migrated all pre-existing rows to that envelope. cinatra#329 removed the
 * legacy 1.0.0/1.1.0 read/write/render path; this module now only ships the
 * embedded analytics body schema the apiVersion 1.2 envelope wraps + reads back.
 */
import { z } from "zod";

import { DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";

// ─────────────────────────────────────────────────────────────────────────
// The embedded analytics body — drizzle-cube DashboardConfig shape.
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

/**
 * Current `config_version` for NEW operator/agent dashboard writes (cinatra#326).
 *
 * Flipped from the legacy semver `1.1.0` to the apiVersion 1.2 literal: the
 * create/save paths now persist NEW dashboards as an apiVersion 1.2 envelope
 * carrying a single `analytics` portlet (the bare drizzle-cube config the
 * caller emits is wrapped server-side in the mutation service), so
 * `/dashboards/[id]` renders them through the one `PortletHost` path. Re-exported
 * from the apiVersion 1.2 module so there is a SINGLE source for the literal (no
 * duplicated string). cinatra#327 migrated all pre-existing 1.0.0/1.1.0 rows to
 * this envelope, and cinatra#329 removed the legacy parse path.
 */
export const CURRENT_CONFIG_VERSION = DASHBOARD_CONFIG_V12_VERSION;

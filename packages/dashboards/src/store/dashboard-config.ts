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
 *   round-trip cleanly. New writes use schema version 1.1.0.
 *
 * `parseDashboardConfig(version, payload)` is the single entry point —
 * dispatches by `config_version` so future versions can coexist.
 */
import { z } from "zod";

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
 * Current version for NEW writes. Dashboards saved by `<DashboardGrid onSave>`
 * validate cleanly against this shape. Existing rows written under schema
 * version 1.0.0 still parse via the dispatcher below.
 */
export const CURRENT_CONFIG_VERSION = "1.1.0" as const;

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

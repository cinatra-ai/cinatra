// ---------------------------------------------------------------------------
// chart — the host-owned `chart` renderable-view payload contract
// (cinatra#1626, epic #1620 "artifact extensions own their UI", S9/M4).
//
// The `chart` view is the FIRST renderable view whose COMPONENT is owned by an
// EXTENSION (`@cinatra-ai/chart-artifact`, resolved through the generated
// `cinatra.views` map) rather than a host card. Per epic AC2 the PAYLOAD schema
// + the detector stay HOST-SIDE permanently: this module is the host-owned
// schema, and `packages/chat/src/markdown-render.ts#detectCharts` is the
// host-side detector. Neither imports the extension.
//
// This is the faithful move of the former `packages/chat/src/chart-schema.ts`
// into the shared protocol contract so BOTH chat surfaces (/chat + the CMS
// embed) validate the exact same wire payload against one source of truth — the
// cross-surface identical-render invariant of the unified-stream program
// (#1216). The extension's own `chart-schema.ts` is a documented port of THIS
// schema; the two must stay in step (the extension re-validates defensively).
//
// Deliberately NOT registered in `RENDERABLE_VIEW_SCHEMAS` (the host-CARD
// registry that `RenderableViewCard` dispatches exhaustively): `chart` is
// dispatched through the extension `cinatra.views` map, not a host component,
// so registering it there would demand a host card that does not exist.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** The `chart` renderable-view payload schema version (this contract's own,
 * distinct from the host-card `schemaVersion`s and the `cinatra.views` ABI). */
export const CHART_VIEW_SCHEMA_VERSION = 1 as const;

/** The wire `viewType` discriminator the host chart detector emits and the
 * chart-artifact extension binds its renderer to. */
export const CHART_VIEW_TYPE = "chart" as const;

export const chartSeriesSchema = z.object({
  name: z.string().min(1).max(120),
  data: z.array(z.number().finite()),
});

/**
 * The chart spec — untrusted LLM output. Strict Zod bounds (≤ 12 series, ≤ 366
 * x-points, finite numbers) cap DoS from a hostile input; every string field is
 * rendered as a React text node by the renderer (never innerHTML), so an
 * LLM-controlled title/label cannot inject markup.
 */
export const chartSpecSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(["bar", "line", "area"]),
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).optional(),
    x: z.array(z.string().max(120)).min(1).max(366),
    series: z.array(chartSeriesSchema).min(1).max(12),
    stacked: z.boolean().optional(),
    legend: z.boolean().optional(),
    yFormat: z.enum(["currency_usd", "number", "percent"]).optional(),
  })
  .refine((c) => c.series.every((s) => s.data.length === c.x.length), {
    message: "Each series.data length must equal x length",
  });

export type ChartSpec = z.infer<typeof chartSpecSchema>;

/**
 * The stable `chart` renderable-view payload the host detector emits and the
 * extension component receives: the flat carrier form `{ viewType: "chart",
 * ...chartSpec }` (the chart-artifact view tolerates both flat and nested
 * `{ viewType, spec }` shapes). The spec fields are re-validated by the renderer.
 */
export type ChartView = { viewType: typeof CHART_VIEW_TYPE } & ChartSpec;

/**
 * Normalizes LLM-generated chart specs that may use ECharts-style structure
 * (`xAxis.data`, per-series `type`) to the internal cinatra format (`x`, series
 * without `type`). Also injects `version: 1` when omitted. Pure; never throws.
 */
export function normalizeChartInput(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;

  // Already in our format — has the `x` field directly.
  if ("x" in obj) {
    if (!("version" in obj)) return { version: 1, ...obj };
    return raw;
  }

  const out: Record<string, unknown> = { version: 1 };
  if ("type" in obj) out.type = obj.type;
  if ("title" in obj) out.title = obj.title;
  if ("subtitle" in obj) out.subtitle = obj.subtitle;
  if ("stacked" in obj) out.stacked = obj.stacked;
  if ("legend" in obj) out.legend = obj.legend;
  if ("yFormat" in obj) out.yFormat = obj.yFormat;

  // ECharts xAxis.data → x
  if (typeof obj.xAxis === "object" && obj.xAxis !== null) {
    const xAxis = obj.xAxis as Record<string, unknown>;
    if (Array.isArray(xAxis.data)) out.x = xAxis.data;
  }

  // ECharts series — strip the per-series `type` field (not in our schema).
  if (Array.isArray(obj.series)) {
    out.series = obj.series.map((s: unknown) => {
      if (typeof s !== "object" || s === null) return s;
      const { type: _t, ...rest } = s as Record<string, unknown>;
      return rest;
    });
  }

  return out;
}

/** Returns a valid `ChartSpec` or `null` on any failure. Never throws. */
export function validateChart(raw: unknown): ChartSpec | null {
  const parsed = chartSpecSchema.safeParse(normalizeChartInput(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * Wrap a validated spec into the stable `chart` renderable-view payload the host
 * dispatch hands to the extension component. Kept tiny + pure so the detector
 * and the tests build the identical shape.
 */
export function buildChartView(spec: ChartSpec): ChartView {
  return { viewType: CHART_VIEW_TYPE, ...spec };
}

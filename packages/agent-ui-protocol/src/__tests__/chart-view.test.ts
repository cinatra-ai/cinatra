// Host-owned `chart` renderable-view payload contract (cinatra#1626, S9-b).
//
// The `chart` viewType is the first renderable view whose COMPONENT is owned by
// an extension (@cinatra-ai/chart-artifact); the PAYLOAD schema + validation
// stay host-side here (epic AC2). This pins that contract: the detector emits a
// payload this schema validates, and the extension re-validates the same shape.

import { describe, expect, it } from "vitest";

import {
  CHART_VIEW_SCHEMA_VERSION,
  CHART_VIEW_TYPE,
  buildChartView,
  chartSpecSchema,
  normalizeChartInput,
  validateChart,
  type ChartSpec,
} from "../renderable-views/chart";

const validSpec = {
  version: 1,
  type: "bar",
  title: "Revenue",
  x: ["Q1", "Q2"],
  series: [{ name: "US", data: [10, 20] }],
} as const;

describe("chart renderable-view payload contract (#1626 S9-b)", () => {
  it("pins the viewType discriminator + schema version", () => {
    expect(CHART_VIEW_TYPE).toBe("chart");
    expect(CHART_VIEW_SCHEMA_VERSION).toBe(1);
  });

  it("validates a well-formed spec and rejects malformed ones", () => {
    expect(validateChart(validSpec)).not.toBeNull();
    // Missing series.
    expect(validateChart({ version: 1, type: "bar", title: "T", x: ["a"] })).toBeNull();
    // series/x length mismatch (the cross-field refine).
    expect(
      validateChart({ version: 1, type: "line", title: "T", x: ["a", "b"], series: [{ name: "s", data: [1] }] }),
    ).toBeNull();
    // Unknown chart type.
    expect(validateChart({ ...validSpec, type: "pie" })).toBeNull();
    // Never throws on hostile input.
    expect(validateChart(null)).toBeNull();
    expect(validateChart("nope")).toBeNull();
    expect(validateChart(undefined)).toBeNull();
  });

  it("caps DoS vectors (series/x-point bounds)", () => {
    const tooManySeries = {
      version: 1,
      type: "bar",
      title: "T",
      x: ["a"],
      series: Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, data: [1] })),
    };
    expect(validateChart(tooManySeries)).toBeNull();
    const tooManyX = {
      version: 1,
      type: "bar",
      title: "T",
      x: Array.from({ length: 367 }, (_, i) => `x${i}`),
      series: [{ name: "s", data: Array.from({ length: 367 }, () => 1) }],
    };
    expect(validateChart(tooManyX)).toBeNull();
  });

  it("normalizes ECharts-shaped input (xAxis.data + per-series type) and injects version", () => {
    const echarts = {
      type: "line",
      title: "T",
      xAxis: { data: ["a", "b"] },
      series: [{ type: "line", name: "s", data: [1, 2] }],
    };
    const normalized = normalizeChartInput(echarts) as Record<string, unknown>;
    expect(normalized.version).toBe(1);
    expect(normalized.x).toEqual(["a", "b"]);
    // per-series `type` stripped (not in our schema).
    expect((normalized.series as Array<Record<string, unknown>>)[0]).not.toHaveProperty("type");
    // …and the normalized shape validates.
    expect(validateChart(echarts)).not.toBeNull();
  });

  it("builds the stable flat `chart` payload the extension component receives", () => {
    const spec = chartSpecSchema.parse(validSpec) as ChartSpec;
    const view = buildChartView(spec);
    expect(view.viewType).toBe("chart");
    // Flat carrier form: spec fields live alongside the discriminator.
    expect(view.title).toBe("Revenue");
    expect(view.series).toEqual(spec.series);
    // The payload round-trips back through validation (extension re-validates it).
    const { viewType: _vt, ...rest } = view;
    expect(validateChart(rest)).not.toBeNull();
  });
});

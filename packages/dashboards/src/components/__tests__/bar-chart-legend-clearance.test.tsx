// @vitest-environment jsdom
/**
 * The rotated x-axis labels of the executions bar chart clear the legend
 * (cinatra#2773).
 *
 * WHAT IS MEASURED. The test mounts the real vendored bar chart (through the
 * host wrapper, and — for the defect baseline — on its own) with the
 * executions portlet's own axis config, then reads the geometry recharts
 * actually rendered:
 *
 *   - the x-axis line's `y1` and its band `height`;
 *   - each tick label's own origin (`translate(x,y)` on its group) and the
 *     `text` attributes the vendored `AngledXAxisTick` writes (`dy`,
 *     `font-size`, `text-anchor`, `transform`);
 *   - the legend wrapper's `bottom` offset and `padding-top`, and the
 *     recharts wrapper's own height.
 *
 * From those it builds the label's axis-aligned box (the rotated em box) and
 * the legend's content box and asserts the two do not intersect.
 *
 * jsdom runs no layout engine, so two browser text metrics are supplied
 * here and nowhere else: the legend content's line height
 * (`LEGEND_CONTENT_HEIGHT_PX`) and the advance width of a string (the
 * component's own canvas-free fallback, forced by stubbing the 2d context
 * away). EVERYTHING that decides the collision — the axis band, the tick
 * offset, the rotation, the legend padding, and recharts' own offset
 * arithmetic that turns the injected band into a taller bottom offset — is
 * the real rendered output.
 *
 *   pnpm --filter @cinatra-ai/dashboards exec vitest run \
 *     src/components/__tests__/bar-chart-legend-clearance.test.tsx
 */
import "./jsdom-shims";
import React, { type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CubeProvider, chartPluginRegistry } from "drizzle-cube/client";
import {
  LazyChart,
  RechartsBarChart,
  getChartConfigAsync,
  type LazyChartProps,
} from "drizzle-cube/client/charts";

import { registerBarChartLegendClearance } from "../bar-chart-legend-clearance-plugin";
import {
  BarChartWithLegendClearance,
  FONT_DESCENT_RATIO,
  LABEL_LEGEND_GAP_PX,
  MEASURED_PASS_MAX_ROUNDS,
  VENDORED_LEGEND_PADDING_TOP_PX,
  VENDORED_TICK_BASELINE_DY_PX,
  VENDORED_TICK_FONT_SIZE_PX,
  VENDORED_TICK_LINE_OFFSET_PX,
  VENDORED_TICK_ROTATION_DEGREES,
  VENDORED_X_AXIS_BAND_PX,
  WIDTH_MEASUREMENT_SAFETY_RATIO,
  legendClearancePx,
  measureLabelWidthPx,
  measureLegendClearanceDeficitPx,
  resetLabelMeasurement,
} from "../bar-chart-legend-clearance";

/** The legend row's rendered line height in a browser (icon + 12px text). */
const LEGEND_CONTENT_HEIGHT_PX = 18;

const CHART_BOX = { width: 640, height: 360 };

/** The executions portlet's own axis config (AGENTS_DEFAULT_CONFIG). */
const X_FIELD = "agent_runs.agent_name";
const Y_FIELD = "agent_runs.count";

type Box = { top: number; bottom: number };

class ImmediateResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(): void {
    this.callback(
      [{ contentRect: CHART_BOX } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

const ZERO_RECT: DOMRect = {
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON: () => ({}),
} as DOMRect;

/** The clearance the mounted component declared for this legend, in px. */
function declaredClearancePx(legendWrapper: Element): number {
  const host = legendWrapper.closest("[data-cinatra-bar-legend-clearance]");
  const declared = host?.getAttribute("data-cinatra-bar-legend-clearance");
  return declared ? Number(declared) : 0;
}

let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ImmediateResizeObserver;

  // No canvas metrics in jsdom -> the component's deterministic fallback.
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof originalGetContext;
  resetLabelMeasurement();

  // jsdom has no layout. Give recharts the ONE box its offset arithmetic
  // reads — the legend wrapper's — built from what the DOM actually
  // declares: the injected top border, the cube's own top padding and the
  // legend row's line height.
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function boundingRect(this: Element): DOMRect {
    if (this.classList?.contains("recharts-legend-wrapper")) {
      const height =
        declaredClearancePx(this) +
        VENDORED_LEGEND_PADDING_TOP_PX +
        LEGEND_CONTENT_HEIGHT_PX;
      return { ...ZERO_RECT, width: CHART_BOX.width, height, toJSON: () => ({}) } as DOMRect;
    }
    return ZERO_RECT;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  resetLabelMeasurement();
  cleanup();
});

function rows(names: readonly string[]): Array<Record<string, unknown>> {
  return names.map((name, index) => ({ [X_FIELD]: name, [Y_FIELD]: index + 3 }));
}

async function mountChart(
  Chart: ComponentType<Record<string, unknown>>,
  names: readonly string[],
): Promise<HTMLElement> {
  const queryClient = new QueryClient();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <CubeProvider apiOptions={{ apiUrl: "/api/dashboards/cubejs-api/v1" }} features={{ enableAI: false }}>
        <Chart
          data={rows(names)}
          chartConfig={{ xAxis: [X_FIELD], yAxis: [Y_FIELD] }}
          displayConfig={{}}
          height={CHART_BOX.height}
        />
      </CubeProvider>
    </QueryClientProvider>,
  );
  // ChartContainer measures, then recharts lays out; a chart reached
  // through the registry additionally resolves a dynamic import first.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (container.querySelector(".recharts-xAxis .recharts-cartesian-axis-line")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  return container;
}

/** `translate(x,y)` off a rendered group. */
function readTranslate(group: Element): { x: number; y: number } {
  const match = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(
    group.getAttribute("transform") ?? "",
  );
  if (!match) throw new Error(`no translate on ${group.outerHTML.slice(0, 80)}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** `rotate(deg)` off a rendered text node. */
function readRotation(text: Element): number {
  const match = /rotate\(\s*([-\d.]+)\s*\)/.exec(text.getAttribute("transform") ?? "");
  if (!match) throw new Error("no rotation on the tick label");
  return Number(match[1]);
}

/** The rendered chart's geometry, read back off the DOM. */
function readGeometry(container: HTMLElement) {
  const axisLine = container.querySelector(
    ".recharts-xAxis .recharts-cartesian-axis-line",
  );
  if (!axisLine) throw new Error("no x-axis line rendered");
  const axisLineY = Number(axisLine.getAttribute("y1"));
  const axisBandPx = Number(axisLine.getAttribute("height"));

  const wrapper = container.querySelector<HTMLElement>(".recharts-wrapper");
  const legendWrapper = container.querySelector<HTMLElement>(".recharts-legend-wrapper");
  if (!wrapper || !legendWrapper) throw new Error("no chart/legend wrapper rendered");
  const wrapperHeight = Number.parseFloat(wrapper.style.height);
  const legendBottomOffset = Number.parseFloat(legendWrapper.style.bottom);
  const legendPaddingTop = Number.parseFloat(legendWrapper.style.paddingTop);

  // The legend's CONTENT sits at the bottom of its wrapper: the injected
  // band and the cube's padding both grow the box upward.
  const legendContentBottom = wrapperHeight - legendBottomOffset;
  const legend: Box = {
    top: legendContentBottom - LEGEND_CONTENT_HEIGHT_PX,
    bottom: legendContentBottom,
  };

  const labels = [
    ...container.querySelectorAll(".recharts-xAxis-tick-labels text"),
  ].map((text) => {
    const origin = readTranslate(text.parentElement as unknown as Element);
    const dy = Number(text.getAttribute("dy"));
    const fontSize = Number(text.getAttribute("font-size"));
    const value = text.textContent ?? "";
    const width = measureLabelWidthPx(value);
    const descent = fontSize * FONT_DESCENT_RATIO;
    // Anchored at its end and rotated -45 degrees: the lowest point of the
    // em box is the START of the text, at sin(45deg) * (width + dy + descent)
    // below the label's own origin.
    const box: Box = {
      top: origin.y + Math.SQRT1_2 * (dy - fontSize + descent),
      bottom: origin.y + Math.SQRT1_2 * (width + dy + descent),
    };
    return {
      value,
      box,
      dy,
      fontSize,
      rotation: readRotation(text),
      anchor: text.getAttribute("text-anchor"),
      tickOffset: origin.y - axisLineY,
    };
  });

  if (labels.length === 0) throw new Error("no x-axis tick labels rendered");

  return {
    axisLineY,
    axisBandPx,
    wrapperHeight,
    legendPaddingTop,
    legend,
    labels,
    clearancePx: declaredClearancePx(legendWrapper),
    /** Distance from the lowest label pixel to the top of the legend. */
    gapPx: Math.min(...labels.map((label) => legend.top - label.box.bottom)),
  };
}

const ONE_AGENT = ["acme/release-notes-writer"];
const FIVE_AGENTS = [
  "acme/release-notes-writer",
  "acme/changelog-summariser",
  "acme/triage",
  "acme/pull-request-reviewer",
  "acme/docs",
];

describe("the vendored bar chart's rotated labels land on the legend (the defect)", () => {
  test("a single long label overruns the axis band and intersects the legend", async () => {
    const container = await mountChart(
      RechartsBarChart as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const geometry = readGeometry(container);

    // The vendored geometry this fix is measured against.
    expect(geometry.axisBandPx).toBe(VENDORED_X_AXIS_BAND_PX);
    expect(geometry.legendPaddingTop).toBe(VENDORED_LEGEND_PADDING_TOP_PX);
    expect(geometry.labels[0].tickOffset).toBe(VENDORED_TICK_LINE_OFFSET_PX);
    expect(geometry.labels[0].dy).toBe(VENDORED_TICK_BASELINE_DY_PX);
    expect(geometry.labels[0].fontSize).toBe(VENDORED_TICK_FONT_SIZE_PX);
    expect(geometry.labels[0].rotation).toBe(VENDORED_TICK_ROTATION_DEGREES);
    expect(geometry.labels[0].anchor).toBe("end");

    // No clearance is injected, and the label runs into the legend.
    expect(geometry.clearancePx).toBe(0);
    expect(geometry.gapPx).toBeLessThan(0);
  });
});

describe("CELL1 — one bar: the rotated label clears the 'Run count' legend", () => {
  test("the label's box and the legend's box do not intersect", async () => {
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const geometry = readGeometry(container);

    expect(geometry.labels).toHaveLength(1);
    expect(geometry.labels[0].value).toBe(ONE_AGENT[0]);
    expect(geometry.labels[0].rotation).toBe(VENDORED_TICK_ROTATION_DEGREES);
    expect(geometry.clearancePx).toBeGreaterThan(0);
    expect(geometry.gapPx).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX - 1);
  });

  test("the label is not clipped by the chart's own box", async () => {
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const geometry = readGeometry(container);

    for (const label of geometry.labels) {
      expect(label.box.bottom).toBeLessThanOrEqual(geometry.wrapperHeight);
      expect(label.box.top).toBeGreaterThan(geometry.axisLineY);
    }
  });
});

describe("CELL2 — several bars: every rotated label still clears the legend", () => {
  test("no label's box intersects the legend's box", async () => {
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      FIVE_AGENTS,
    );
    const geometry = readGeometry(container);

    expect(geometry.labels).toHaveLength(FIVE_AGENTS.length);
    expect(geometry.labels.map((label) => label.value)).toEqual([...FIVE_AGENTS]);
    expect(geometry.gapPx).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX - 1);
  });

  test("no label is clipped, and the band is sized by the WIDEST label", async () => {
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      FIVE_AGENTS,
    );
    const geometry = readGeometry(container);

    for (const label of geometry.labels) {
      expect(label.box.bottom).toBeLessThanOrEqual(geometry.wrapperHeight);
    }

    // The band answers the WIDEST label, not the label count: the same
    // name on its own asks for exactly the same clearance.
    const widest = [...FIVE_AGENTS].sort(
      (a, b) => measureLabelWidthPx(b) - measureLabelWidthPx(a),
    )[0];
    const widestAlone = readGeometry(
      await mountChart(
        BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
        [widest],
      ),
    );
    expect(geometry.clearancePx).toBe(widestAlone.clearancePx);
  });
});

describe("the band survives an under-measuring text metric", () => {
  // An offscreen 2d context is not the SVG text layout: on the live chart
  // the rotated label's real box sat ~4 % wider than the canvas reported,
  // which spent nearly the whole LABEL_LEGEND_GAP_PX band before a pixel of
  // it reached the reader. The component therefore reserves against a
  // WIDENED label, and this test asserts exactly that: the label's box is
  // rebuilt at WIDTH_MEASUREMENT_SAFETY_RATIO times the measured width and
  // must still clear the legend's box.
  test("a label whose real box is the safety ratio wider still clears", async () => {
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const geometry = readGeometry(container);

    const label = geometry.labels[0];
    const measured = measureLabelWidthPx(label.value);
    const descent = label.fontSize * FONT_DESCENT_RATIO;
    // The label's own origin, recovered from the box readGeometry built.
    const originY =
      label.box.bottom - Math.SQRT1_2 * (measured + label.dy + descent);
    const widenedBottom =
      originY +
      Math.SQRT1_2 *
        (measured * WIDTH_MEASUREMENT_SAFETY_RATIO + label.dy + descent);

    expect(geometry.legend.top - widenedBottom).toBeGreaterThanOrEqual(0);
  });
});

describe("short labels leave the vendored layout untouched", () => {
  test("no band is injected when nothing overruns the axis band", async () => {
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ["triage", "docs"],
    );
    const geometry = readGeometry(container);

    expect(geometry.clearancePx).toBe(0);
    expect(geometry.gapPx).toBeGreaterThan(0);
  });
});

describe("the override is what the dashboard's own \"bar\" chart type mounts", () => {
  test("registering swaps the component and keeps the built-in config", async () => {
    const builtInConfig = await getChartConfigAsync("bar");
    expect(builtInConfig).not.toBeNull();

    registerBarChartLegendClearance();
    // The registration resolves the built-in config before replacing it.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(chartPluginRegistry.isCustom("bar")).toBe(true);
    const afterConfig = await getChartConfigAsync("bar");
    expect(afterConfig?.dropZones).toEqual(builtInConfig?.dropZones);
    expect(afterConfig?.displayOptions).toEqual(builtInConfig?.displayOptions);
    expect(afterConfig?.displayOptionsConfig).toEqual(builtInConfig?.displayOptionsConfig);

    // The chart-type picker reads its strings off this same config, so the
    // override has to carry them through: the built-in's i18n keys and its
    // availability predicate, not invented replacements.
    expect(builtInConfig?.label).toBe("chart.bar.label");
    expect(afterConfig?.label).toBe(builtInConfig?.label);
    expect(afterConfig?.description).toBe(builtInConfig?.description);
    expect(afterConfig?.useCase).toBe(builtInConfig?.useCase);
    expect(afterConfig?.isAvailable).toBe(builtInConfig?.isAvailable);

    // Exactly the path the seed config takes: chartType "bar", resolved
    // through the registry.
    function BarThroughTheRegistry(props: Record<string, unknown>) {
      const chartProps = props as unknown as Omit<LazyChartProps, "chartType">;
      return <LazyChart chartType="bar" {...chartProps} />;
    }

    const container = await mountChart(BarThroughTheRegistry, ONE_AGENT);
    const geometry = readGeometry(container);
    expect(geometry.clearancePx).toBeGreaterThan(0);
    expect(geometry.gapPx).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX - 1);
  });
});

describe("the measured pass closes the residual the text metric leaves", () => {
  // On the live boot the rotated label's REAL box came out wider than the
  // offscreen canvas reported: the single-bar label's box still overlapped
  // the legend row's box by about 2.8 px even with the analytic band in
  // place. jsdom has no layout, so the browser's answer is supplied here as
  // rendered boxes: the legend row sits at a fixed top (its content is
  // pinned to the bottom of its wrapper, so the band never moves it), and
  // the label's bottom rides UP one-for-one with the band the component
  // publishes. With no measured pass the component stops at the analytic
  // band and the boxes stay 2.8 px into each other.
  const LEGEND_ROW_TOP_PX = 300;
  const LEGEND_ROW_HEIGHT_PX = 18;
  const LIVE_RESIDUAL_OVERLAP_PX = 2.8;
  const LABEL_BOX_HEIGHT_PX = 40;

  function rect(top: number, height: number, width = 120): DOMRect {
    return {
      ...ZERO_RECT,
      top,
      bottom: top + height,
      height,
      width,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /**
   * Boxes as a browser would report them for the live residual: the label's
   * bottom sits `LIVE_RESIDUAL_OVERLAP_PX` INTO the legend row while the
   * published band is still the analytic one, less any `headroomPx` a case
   * wants the labels to start with.
   */
  function stubLiveBoxes(analyticBandPx: number, headroomPx = 0): void {
    const previous = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function liveRect(this: Element): DOMRect {
      if (this.classList?.contains("recharts-legend-item")) {
        return rect(LEGEND_ROW_TOP_PX, LEGEND_ROW_HEIGHT_PX);
      }
      if (
        this.tagName?.toLowerCase() === "text" &&
        this.closest(".recharts-xAxis-tick-labels")
      ) {
        const band = declaredClearancePx(
          this.closest("[data-cinatra-bar-legend-clearance]") ?? this,
        );
        const bottom =
          LEGEND_ROW_TOP_PX +
          LIVE_RESIDUAL_OVERLAP_PX -
          (band - analyticBandPx) -
          headroomPx;
        return rect(bottom - LABEL_BOX_HEIGHT_PX, LABEL_BOX_HEIGHT_PX);
      }
      return previous.call(this);
    };
  }

  /** The published band, once it stops moving. */
  async function settledClearancePx(container: HTMLElement): Promise<number> {
    let last = -1;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const host = container.querySelector("[data-cinatra-bar-legend-clearance]");
      const current = host ? declaredClearancePx(host) : -1;
      if (current === last && current >= 0) return current;
      last = current;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return last;
  }

  test("the band grows by the measured shortfall, so the boxes no longer touch", async () => {
    const analyticBandPx = legendClearancePx(ONE_AGENT);
    expect(analyticBandPx).toBeGreaterThan(0);
    stubLiveBoxes(analyticBandPx);

    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const settled = await settledClearancePx(container);

    // The shortfall is the overlap plus the whole gap the band owes.
    const shortfall = Math.ceil(LIVE_RESIDUAL_OVERLAP_PX + LABEL_LEGEND_GAP_PX);
    expect(settled).toBe(analyticBandPx + shortfall);

    // Read back off the rendered boxes: nothing is owed any more.
    const root = container.querySelector("[data-cinatra-bar-legend-clearance]");
    expect(root).not.toBeNull();
    const deficit = measureLegendClearanceDeficitPx(root as Element);
    expect(deficit).not.toBeNull();
    expect(deficit as number).toBeLessThanOrEqual(0);

    // ...which is the same statement as the graded one: the label's box and
    // the legend row's box keep a gap of at least LABEL_LEGEND_GAP_PX.
    const label = container.querySelector(".recharts-xAxis-tick-labels text");
    expect(label).not.toBeNull();
    const gapPx =
      LEGEND_ROW_TOP_PX - (label as Element).getBoundingClientRect().bottom;
    expect(gapPx).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX);
  });

  test("a chart that already clears the legend is left at its analytic band", async () => {
    // Same boxes, but the labels start a comfortable distance above the
    // legend row: the measured pass finds nothing owed and adds nothing.
    const analyticBandPx = legendClearancePx(ONE_AGENT);
    stubLiveBoxes(
      analyticBandPx,
      LABEL_LEGEND_GAP_PX + LIVE_RESIDUAL_OVERLAP_PX + 5,
    );

    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );

    expect(await settledClearancePx(container)).toBe(analyticBandPx);
  });

  test("a DOM with no layout is never mistaken for a measurement", async () => {
    // Every box reads zero (jsdom's own answer), so the measured pass
    // reports nothing and the analytic band stands on its own.
    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const root = container.querySelector("[data-cinatra-bar-legend-clearance]");
    expect(measureLegendClearanceDeficitPx(root as Element)).toBeNull();
    expect(await settledClearancePx(container)).toBe(legendClearancePx(ONE_AGENT));
  });
});

describe("the band answers the box the reader ends up with, not the first one read", () => {
  // WHAT THE LIVE BOOT SHOWED. With the analytic band in place and a single
  // measured correction, the rotated label's real box still sat about 2.8 px
  // INSIDE the legend row's box, in both palettes, on every reload — the
  // published band had settled and never moved again. The label's box is
  // simply not final when the first correction reads it: the tick is laid
  // out in the fallback face and grows when the page's webfont swaps in, so
  // a correction sized against the earlier box under-delivers.
  //
  // jsdom runs no layout and loads no font, so the browser's answer is
  // supplied here as rendered boxes with the one property that matters: the
  // legend row is pinned (the band grows the wrapper upward, never moving
  // the legend's content), the label's bottom rides UP one-for-one with the
  // published band, and a late face pushes it back DOWN by the width the
  // wider glyphs add.
  const LEGEND_ROW_TOP_PX = 300;
  const LEGEND_ROW_HEIGHT_PX = 18;
  const LABEL_BOX_HEIGHT_PX = 40;
  /** What the swapped-in face adds to the rotated label's box. */
  const WEBFONT_GROWTH_PX = 6;

  function rect(top: number, height: number, width = 120): DOMRect {
    return {
      ...ZERO_RECT,
      top,
      bottom: top + height,
      height,
      width,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /**
   * Rendered boxes for a chart whose label grows by `growthPx()` at the
   * moment that function starts answering non-zero: the label's bottom is
   * the legend row's top, moved up by every pixel of band published beyond
   * the analytic one and down by the growth.
   */
  function stubGrowingLabel(analyticBandPx: number, growthPx: () => number): void {
    const previous = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function grownRect(this: Element): DOMRect {
      if (this.classList?.contains("recharts-legend-item")) {
        return rect(LEGEND_ROW_TOP_PX, LEGEND_ROW_HEIGHT_PX);
      }
      if (
        this.tagName?.toLowerCase() === "text" &&
        this.closest(".recharts-xAxis-tick-labels")
      ) {
        const band = declaredClearancePx(
          this.closest("[data-cinatra-bar-legend-clearance]") ?? this,
        );
        const bottom =
          LEGEND_ROW_TOP_PX - (band - analyticBandPx) + growthPx();
        return rect(bottom - LABEL_BOX_HEIGHT_PX, LABEL_BOX_HEIGHT_PX);
      }
      return previous.call(this);
    };
  }

  /** The published band, once it stops moving. */
  async function settledClearancePx(container: HTMLElement): Promise<number> {
    let last = -1;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const host = container.querySelector("[data-cinatra-bar-legend-clearance]");
      const current = host ? declaredClearancePx(host) : -1;
      if (current === last && current >= 0) return current;
      last = current;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return last;
  }

  /**
   * Growth that appears only once the first correction has been published —
   * a face swapping in while the chart re-lays out, which is what the live
   * boot did: the pass sized the band against the fallback glyphs and the
   * label came back wider than the band it had just been given.
   */
  function growthAfterTheFirstCorrection(analyticBandPx: number): () => number {
    return () => {
      const host = document.querySelector("[data-cinatra-bar-legend-clearance]");
      const band = host ? declaredClearancePx(host) : analyticBandPx;
      return band > analyticBandPx ? WEBFONT_GROWTH_PX : 0;
    };
  }

  /** The gap the reader is left with, off the rendered boxes. */
  function renderedGapPx(container: HTMLElement): number {
    const label = container.querySelector(".recharts-xAxis-tick-labels text");
    if (!label) throw new Error("no tick label rendered");
    return LEGEND_ROW_TOP_PX - label.getBoundingClientRect().bottom;
  }

  /** A document font set that reports faces landing when the test says so. */
  function installFontSet(): { landed: () => void; restore: () => void } {
    const listeners = new Set<() => void>();
    const had = Object.prototype.hasOwnProperty.call(document, "fonts");
    const original = (document as unknown as { fonts?: unknown }).fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        addEventListener: (type: string, listener: () => void) => {
          if (type === "loadingdone") listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener);
        },
        // The pass must not depend on a promise that never settles.
        ready: new Promise<void>(() => {}),
      },
    });
    return {
      landed: () => {
        for (const listener of [...listeners]) listener();
      },
      restore: () => {
        if (had) {
          Object.defineProperty(document, "fonts", {
            configurable: true,
            value: original,
          });
        } else {
          delete (document as unknown as { fonts?: unknown }).fonts;
        }
      },
    };
  }

  test("a correction that under-delivers is confirmed and topped up", async () => {
    // The label grows the moment the first correction lands, exactly as a
    // face swapping in mid-layout does. A single pass stops here,
    // WEBFONT_GROWTH_PX short of the gap it just paid for.
    const analyticBandPx = legendClearancePx(ONE_AGENT);
    expect(analyticBandPx).toBeGreaterThan(0);
    stubGrowingLabel(analyticBandPx, growthAfterTheFirstCorrection(analyticBandPx));
    const initial = LABEL_LEGEND_GAP_PX + WEBFONT_GROWTH_PX;

    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );

    expect(await settledClearancePx(container)).toBe(analyticBandPx + initial);
    expect(renderedGapPx(container)).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX);
  });

  test("a face that lands after the band settled puts no label back on the legend", async () => {
    const analyticBandPx = legendClearancePx(ONE_AGENT);
    const fonts = installFontSet();
    let growthPx = 0;
    stubGrowingLabel(analyticBandPx, () => growthPx);

    try {
      const container = await mountChart(
        BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
        ONE_AGENT,
      );
      // The band the fallback face asked for: the whole gap, no more.
      expect(await settledClearancePx(container)).toBe(
        analyticBandPx + LABEL_LEGEND_GAP_PX,
      );
      expect(renderedGapPx(container)).toBe(LABEL_LEGEND_GAP_PX);

      // The webfont arrives and widens the rotated label: it is back on the
      // legend, and nothing about the chart's data or props has changed.
      growthPx = WEBFONT_GROWTH_PX;
      expect(renderedGapPx(container)).toBeLessThan(LABEL_LEGEND_GAP_PX);
      fonts.landed();

      expect(await settledClearancePx(container)).toBe(
        analyticBandPx + LABEL_LEGEND_GAP_PX + WEBFONT_GROWTH_PX,
      );
      expect(renderedGapPx(container)).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX);
    } finally {
      fonts.restore();
    }
  });

  test("the passes are bounded: a band that cannot settle stops asking", async () => {
    // A pathological page whose label grows by the same amount every time
    // the band does: no band can ever satisfy it. The component must spend
    // its rounds and stop, rather than growing the band frame after frame.
    const analyticBandPx = legendClearancePx(ONE_AGENT);
    stubGrowingLabel(analyticBandPx, () => {
      const host = document.querySelector("[data-cinatra-bar-legend-clearance]");
      return host ? declaredClearancePx(host) - analyticBandPx : 0;
    });

    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      ONE_AGENT,
    );
    const settled = await settledClearancePx(container);

    expect(settled).toBeGreaterThan(analyticBandPx);
    expect(settled).toBeLessThanOrEqual(
      analyticBandPx + MEASURED_PASS_MAX_ROUNDS * LABEL_LEGEND_GAP_PX,
    );
  });

  test("several bars are confirmed too: no label is left on the legend", async () => {
    const analyticBandPx = legendClearancePx(FIVE_AGENTS);
    stubGrowingLabel(analyticBandPx, growthAfterTheFirstCorrection(analyticBandPx));

    const container = await mountChart(
      BarChartWithLegendClearance as unknown as ComponentType<Record<string, unknown>>,
      FIVE_AGENTS,
    );
    await settledClearancePx(container);

    const labels = [...container.querySelectorAll(".recharts-xAxis-tick-labels text")];
    expect(labels).toHaveLength(FIVE_AGENTS.length);
    for (const label of labels) {
      const gapPx = LEGEND_ROW_TOP_PX - label.getBoundingClientRect().bottom;
      expect(gapPx).toBeGreaterThanOrEqual(LABEL_LEGEND_GAP_PX);
    }
  });
});

"use client";
/**
 * `BarChartWithLegendClearance` — the host-side clearance wrapper around
 * drizzle-cube's built-in `bar` chart (cinatra#2773).
 *
 * THE DEFECT. The vendored bar chart draws every x-axis tick label rotated
 * -45 degrees (`AngledXAxisTick`: `text` at `dy=16`, `text-anchor="end"`,
 * `font-size=12`, `transform="rotate(-45)"`) inside an x-axis band of a
 * FIXED `height={60}`, and puts the "Run count" legend directly under that
 * band (`renderHoverLegend` -> recharts `Legend` with
 * `wrapperStyle={{ paddingTop: "25px" }}`, `verticalAlign="bottom"`). A
 * rotated label descends `sin(45deg) * (its advance width + the baseline
 * offset)` below the axis line, so any label longer than ~16 characters
 * runs out of the band and lands on the legend. With a single bar the
 * collision is unmissable: one long agent name straight through the legend
 * row.
 *
 * WHY A WRAPPER AND NOT A DISPLAY OPTION. Read off the vendored client the
 * dashboards SDK pins (`drizzle-cube` 0.6.6, `packages/sdk-dashboard`): the
 * `bar` chart type's `displayOptions` are exactly `showLegend`, `showGrid`,
 * `showTooltip`, `showAllXLabels`, `hideHeader` (`displayOptionsConfig` is
 * the descriptor list for those same five); `ChartDisplayConfig` carries no
 * bottom-margin / legend-position / label-height key, and `ChartProps` has
 * no `margin` prop (the bar chart's margins come from the package-internal
 * `CHART_MARGINS`). There is no display option to set, so this takes the
 * issue's second road — wrap the chart and inject the band — and NOTHING
 * under `node_modules/drizzle-cube` is edited.
 *
 * THE MECHANISM. Recharts sizes the plot area from the MEASURED height of
 * the legend wrapper (`useElementOffset` -> `setLegendSize` ->
 * `offset.bottom`). The wrapper is positioned `bottom: <margin.bottom>` and
 * `height: auto`, so growing it upward pushes the axis band (and with it
 * the rotated labels) up while the legend's own content stays exactly where
 * it was. This component measures the labels it is about to render, works
 * out how far they overrun the band, and publishes that number as
 * `--cinatra-bar-legend-clearance` on a wrapper element; one rule in
 * `dashboard-theme.css` spends it as a TRANSPARENT TOP BORDER on the legend
 * wrapper inside this subtree. A top border grows the measured box upward
 * without moving the legend content and without fighting the inline
 * `padding-top` the cube sets, so no `!important` is needed.
 *
 * The band is data-driven: a short label needs none (the clearance is 0 and
 * the chart lays out exactly as before), a long one gets exactly the pixels
 * it overruns plus `LABEL_LEGEND_GAP_PX`.
 *
 * TWO TERMS. The band is estimated before the first paint from a text
 * metric, and then CORRECTED from the boxes the browser actually rendered.
 * The correction is why the second term exists at all: an offscreen canvas
 * is not the SVG text layout, and on the live chart it under-measured the
 * label enough to leave the label's box a couple of pixels inside the
 * legend's box with the estimate alone. The measured pass
 * (`measureLegendClearanceDeficitPx`) reads the two boxes the fix is graded
 * on and asks for exactly the shortfall; it only ever adds pixels, so the
 * estimate stays the floor and a chart that already clears keeps its
 * layout.
 *
 * THE CORRECTION IS CONFIRMED, NOT ASSUMED. A measurement is only final if
 * the label's box is final when it is read, and on the live boot it is not:
 * the rotated label is first laid out in the fallback face and grows when
 * the webfont swaps in. A single pass therefore settled a couple of pixels
 * INTO the legend and never looked again. So every correction is read back
 * on the boxes it produced (`MEASURED_PASS_MAX_ROUNDS`), and the document's
 * own font-loading notifier re-arms the pass when a face lands late.
 *
 * Registered over the built-in `bar` type in
 * `bar-chart-legend-clearance-plugin.ts`.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { RechartsBarChart } from "drizzle-cube/client/charts";
import type { ChartProps } from "drizzle-cube/client";

/** The rotation `AngledXAxisTick` applies to every x-axis tick label. */
export const VENDORED_TICK_ROTATION_DEGREES = -45;
/** `font-size` on that tick's `text` element. */
export const VENDORED_TICK_FONT_SIZE_PX = 12;
/** `dy` on that tick's `text` element (baseline offset before rotation). */
export const VENDORED_TICK_BASELINE_DY_PX = 16;
/** `<XAxis height={60}>` — the band reserved for the x-axis. */
export const VENDORED_X_AXIS_BAND_PX = 60;
/** `renderHoverLegend`'s `wrapperStyle.paddingTop`. */
export const VENDORED_LEGEND_PADDING_TOP_PX = 25;
/** Distance from the axis line down to the tick label's own origin. */
export const VENDORED_TICK_LINE_OFFSET_PX = 8;
/**
 * Room the vendored layout leaves between a tick label's origin and the top
 * of the legend's content: the axis band plus the legend's own top padding,
 * less the tick offset the label starts at.
 */
export const VENDORED_LABEL_FREE_SPACE_PX =
  VENDORED_X_AXIS_BAND_PX +
  VENDORED_LEGEND_PADDING_TOP_PX -
  VENDORED_TICK_LINE_OFFSET_PX;

/** Empty band kept between the lowest label pixel and the legend. */
export const LABEL_LEGEND_GAP_PX = 8;
/**
 * Ceiling on the ESTIMATED band. A pathological label would otherwise eat
 * the plot area; past this the chart keeps its bars readable and the tail of
 * the longest label is the thing that gives.
 */
export const MAX_LEGEND_CLEARANCE_PX = 96;
/**
 * Ceiling on the band once the rendered boxes have been measured.
 *
 * An estimate can be wrong in either direction, so it is held on a short
 * leash; a MEASURED overlap is a collision the reader can see, so the band
 * is allowed further before the plot area is defended instead.
 */
export const MAX_MEASURED_LEGEND_CLEARANCE_PX = 144;
/**
 * Fallback advance width per character, as a fraction of the font size, used
 * when no text-measuring canvas is available (server render, or a DOM with
 * no 2d context). Deliberately generous: over-reserving costs a few pixels
 * of plot height, under-reserving puts the label back on the legend.
 */
export const FALLBACK_GLYPH_WIDTH_RATIO = 0.62;
/** Em-box descent below the baseline, as a fraction of the font size. */
export const FONT_DESCENT_RATIO = 0.2;
/**
 * Safety factor on the measured advance width.
 *
 * An offscreen 2d context is not the SVG text layout: it is given the font
 * SHORTHAND read off `document.body`, so it misses the tick text’s own
 * inherited weight, `letter-spacing` and any face the canvas has not
 * loaded, and it returns the advance width rather than the rendered box.
 * Measured live on the executions chart, the rotated tick label’s real
 * box sat ~4 % wider than the canvas said, which spent most of the
 * `LABEL_LEGEND_GAP_PX` band before a pixel of it reached the reader. The
 * factor buys that difference back with headroom; it costs a handful of
 * plot-area pixels and never turns a fitting label into a banded one on its
 * own (a label short enough to fit still overruns by nothing).
 */
export const WIDTH_MEASUREMENT_SAFETY_RATIO = 1.08;

type MeasureContext = { font: string; measureText: (text: string) => { width: number } };

let cachedMeasureContext: MeasureContext | null | undefined;

/**
 * A 2d context configured with the tick's font, or `null` when the platform
 * has none (SSR, or jsdom without a canvas implementation) — callers then
 * fall back to `estimateLabelWidthPx`.
 */
function getMeasureContext(): MeasureContext | null {
  if (cachedMeasureContext !== undefined) return cachedMeasureContext;
  cachedMeasureContext = null;
  if (typeof document === "undefined") return cachedMeasureContext;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      const family =
        typeof window !== "undefined" && document.body
          ? window.getComputedStyle(document.body).fontFamily
          : "";
      context.font = `${VENDORED_TICK_FONT_SIZE_PX}px ${family || "sans-serif"}`;
      cachedMeasureContext = context as unknown as MeasureContext;
    }
  } catch {
    cachedMeasureContext = null;
  }
  return cachedMeasureContext;
}

/** Test seam: drop the cached measuring context. */
export function resetLabelMeasurement(): void {
  cachedMeasureContext = undefined;
}

/** Advance width of `label` when no canvas can measure it. */
export function estimateLabelWidthPx(label: string): number {
  return label.length * VENDORED_TICK_FONT_SIZE_PX * FALLBACK_GLYPH_WIDTH_RATIO;
}

/** Advance width of `label` at the tick's font size. */
export function measureLabelWidthPx(label: string): number {
  const context = getMeasureContext();
  if (!context) return estimateLabelWidthPx(label);
  try {
    return context.measureText(label).width;
  } catch {
    return estimateLabelWidthPx(label);
  }
}

/**
 * How far a rotated tick label reaches BELOW its own origin.
 *
 * The label is anchored at its end, so before rotation it spans
 * `x in [-width, 0]` and its em box bottom sits at
 * `dy + descent`. Rotating by -45 degrees maps `(x, y)` to
 * `y' = sin(45deg) * (y - x)`, so the lowest corner is the start of the
 * text: `sin(45deg) * (width + dy + descent)`.
 */
export function rotatedLabelDepthPx(labelWidthPx: number): number {
  const descent = VENDORED_TICK_FONT_SIZE_PX * FONT_DESCENT_RATIO;
  return (
    Math.SQRT1_2 * (labelWidthPx + VENDORED_TICK_BASELINE_DY_PX + descent)
  );
}

/** The x-axis values the vendored chart is about to draw as tick labels. */
export function readXAxisLabels(
  data: ChartProps["data"],
  chartConfig: ChartProps["chartConfig"],
): string[] {
  const field = chartConfig?.xAxis?.[0] ?? chartConfig?.x;
  if (!field || !Array.isArray(data)) return [];
  return data.map((row) => {
    const value = (row as Record<string, unknown> | null | undefined)?.[field];
    return value === null || value === undefined ? "" : String(value);
  });
}

/**
 * Pixels of clearance to inject above the legend so the rotated labels stop
 * short of it. `0` when nothing overruns the vendored band (the chart then
 * lays out byte-for-byte as before) or when the legend is hidden.
 */
export function legendClearancePx(
  labels: readonly string[],
  showLegend: boolean = true,
): number {
  if (!showLegend || labels.length === 0) return 0;
  let widest = 0;
  for (const label of labels) {
    const width = measureLabelWidthPx(label);
    if (width > widest) widest = width;
  }
  const overrun =
    rotatedLabelDepthPx(widest * WIDTH_MEASUREMENT_SAFETY_RATIO) +
    LABEL_LEGEND_GAP_PX -
    VENDORED_LABEL_FREE_SPACE_PX;
  if (overrun <= 0) return 0;
  return Math.min(MAX_LEGEND_CLEARANCE_PX, Math.ceil(overrun));
}

/**
 * Frames to wait for the chart to reach the DOM before the measured pass
 * gives up. The chart arrives through a dynamic import and recharts lays
 * out after its own resize observation, so the first frames after mount
 * carry no axis to measure.
 */
export const MEASURED_PASS_MAX_FRAMES = 30;

/**
 * Measured passes spent on one label set under one font state: the first
 * reads the rendered boxes and asks for the shortfall, the ones after it
 * CONFIRM the band on the boxes that correction produced. A pass may only
 * ADD pixels and the loop stops the moment nothing is owed, so a chart that
 * was already right costs exactly one extra frame.
 */
export const MEASURED_PASS_MAX_ROUNDS = 4;
/**
 * Shortfall that counts as owed, in pixels. Sub-pixel box arithmetic
 * (device pixel ratios, fractional font metrics) must not start a round.
 */
export const MEASURED_PASS_TOLERANCE_PX = 0.5;

/** What the platform offers to say that font faces have finished loading. */
type FontLoadNotifier = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  ready?: Promise<unknown>;
};

/**
 * The document's font-loading notifier, or `null` on a platform without one
 * (a server render, or a DOM that implements no font set) — the band then
 * rests on its confirmed rounds alone.
 */
export function readFontLoadNotifier(): FontLoadNotifier | null {
  if (typeof document === "undefined") return null;
  const fonts = (document as unknown as { fonts?: FontLoadNotifier }).fonts;
  return fonts ?? null;
}

/** One measurable band of the rendered chart, in client pixels. */
type MeasuredBand = { legendTopPx: number; labelBottomPx: number };

/** What the measured passes have established for the labels on screen. */
type MeasuredCorrection = {
  /** The label set and analytic band this correction answers. */
  key: string;
  /** Pixels added on top of the analytic band; never decreases for a key. */
  px: number;
  /** Passes already spent under the current font state. */
  rounds: number;
  /** The font state the last pass measured under. */
  fontEpoch: number;
  /** The last pass found nothing owed. */
  settled: boolean;
};

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(callback, 16);
  return () => clearTimeout(handle);
}

/**
 * The top of the legend's own CONTENT inside `root`, in client pixels.
 *
 * The legend items are read first: they sit below the wrapper's injected
 * border and the cube's inline `padding-top`, so their box IS the content
 * box. A legend rendered without items falls back to the wrapper's box plus
 * exactly those two offsets.
 */
function readLegendContentTopPx(root: Element): number | null {
  const wrapper = root.querySelector(".recharts-legend-wrapper");
  if (!wrapper) return null;
  const items = [...wrapper.querySelectorAll(".recharts-legend-item")];
  let top = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (rect.height > 0 && rect.top < top) top = rect.top;
  }
  if (Number.isFinite(top)) return top;

  const rect = wrapper.getBoundingClientRect();
  if (rect.height <= 0) return null;
  if (typeof window === "undefined") return null;
  const style = window.getComputedStyle(wrapper);
  const border = Number.parseFloat(style.borderTopWidth) || 0;
  const padding = Number.parseFloat(style.paddingTop) || 0;
  return rect.top + border + padding;
}

/** The lowest pixel any rotated x-axis tick label reaches, in client pixels. */
function readLowestLabelBottomPx(root: Element): number | null {
  const labels = root.querySelectorAll(".recharts-xAxis-tick-labels text");
  let bottom = Number.NEGATIVE_INFINITY;
  for (const label of labels) {
    const rect = label.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bottom) bottom = rect.bottom;
  }
  return Number.isFinite(bottom) ? bottom : null;
}

/** Both bands, or `null` while the chart is not laid out yet. */
export function readClearanceBands(root: Element): MeasuredBand | null {
  const legendTopPx = readLegendContentTopPx(root);
  if (legendTopPx === null) return null;
  const labelBottomPx = readLowestLabelBottomPx(root);
  if (labelBottomPx === null) return null;
  return { legendTopPx, labelBottomPx };
}

/**
 * Pixels still missing between the rotated labels and the legend, measured
 * on the RENDERED boxes rather than estimated from a text metric.
 *
 * `null` while the chart has not been laid out (no legend, no tick labels,
 * or a DOM with no layout at all: jsdom answers every box with zeros, and a
 * zero box is never mistaken for a measurement).
 *
 * WHY THIS PASS EXISTS. The analytic band above reserves against an
 * offscreen canvas metric, which is not the SVG text layout: on the live
 * chart the rotated label's real box came out wider than the canvas said
 * and ate the whole `LABEL_LEGEND_GAP_PX` band, leaving the label's box
 * touching the legend's box by a couple of pixels. This pass reads the two
 * boxes the checklist grades and asks for exactly the shortfall.
 *
 * THE BAND MOVES THE LABELS, NOT THE LEGEND. The legend's content is pinned
 * to the bottom of its wrapper (the band grows the wrapper UPWARD), so
 * adding `d` pixels of band moves the axis, and every label with it, up by
 * `d` while the legend's content stays put: the gap grows by exactly `d`.
 * One pass would therefore be final if the label's own box were final when
 * it was read — a webfont landing after the read widens the label and walks
 * it back down, so the caller confirms the band on the boxes the correction
 * produced and re-reads when the fonts report in.
 */
export function measureLegendClearanceDeficitPx(root: Element): number | null {
  const bands = readClearanceBands(root);
  if (!bands) return null;
  return LABEL_LEGEND_GAP_PX - (bands.legendTopPx - bands.labelBottomPx);
}

/** Identity of the band a measurement belongs to. */
function clearanceKey(labels: readonly string[], basePx: number): string {
  return `${basePx}|${labels.join(" ")}`;
}

/**
 * The vendored bar chart, with the clearance band published to the CSS rule
 * that spends it. Every prop is forwarded untouched: this component adds a
 * wrapper element and nothing else.
 *
 * The band is the sum of two terms: the analytic reserve computed before
 * the first paint (so the very first frame is already close), and a
 * measured correction read back off the rendered boxes — confirmed on the
 * boxes it produced, and re-read when a font face lands late. Both terms
 * only ever add pixels: the analytic term stays the floor.
 */
export const BarChartWithLegendClearance = memo(
  function BarChartWithLegendClearance(props: ChartProps) {
    const { data, chartConfig, displayConfig, height = "100%" } = props;
    const showLegend = displayConfig?.showLegend ?? true;
    const labels = useMemo(
      () => readXAxisLabels(data, chartConfig),
      [data, chartConfig],
    );
    const basePx = useMemo(
      () => legendClearancePx(labels, showLegend),
      [labels, showLegend],
    );
    const key = clearanceKey(labels, basePx);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const [measured, setMeasured] = useState<MeasuredCorrection>({
      key: "",
      px: 0,
      rounds: 0,
      fontEpoch: 0,
      settled: false,
    });
    /**
     * Font faces that landed after a pass. A late face changes the label's
     * box, so a band settled under the previous state is measured again.
     */
    const [fontEpoch, setFontEpoch] = useState(0);
    const keyRef = useRef(key);
    keyRef.current = key;
    const correctionPx = measured.key === key ? measured.px : 0;
    const clearancePx = Math.min(
      MAX_MEASURED_LEGEND_CLEARANCE_PX,
      basePx + correctionPx,
    );

    useEffect(() => {
      if (!showLegend) return;
      const sameLabels = measured.key === key;
      const sameFonts = sameLabels && measured.fontEpoch === fontEpoch;
      // Pixels already reserved stay reserved across a font change: the pass
      // only ever adds, so the band never flickers back down.
      const appliedPx = sameLabels ? measured.px : 0;
      const round = sameFonts ? measured.rounds : 0;
      if (sameFonts && (measured.settled || round >= MEASURED_PASS_MAX_ROUNDS)) {
        return;
      }
      let cancelled = false;
      let cancelFrame: (() => void) | null = null;

      const attempt = (frame: number) => {
        if (cancelled) return;
        const root = rootRef.current;
        const deficit = root ? measureLegendClearanceDeficitPx(root) : null;
        if (deficit === null) {
          if (frame >= MEASURED_PASS_MAX_FRAMES) return;
          cancelFrame = scheduleFrame(() => attempt(frame + 1));
          return;
        }
        const owedPx =
          deficit > MEASURED_PASS_TOLERANCE_PX ? Math.ceil(deficit) : 0;
        setMeasured({
          key,
          px: appliedPx + owedPx,
          rounds: round + 1,
          fontEpoch,
          settled: owedPx === 0,
        });
      };

      cancelFrame = scheduleFrame(() => attempt(0));
      return () => {
        cancelled = true;
        cancelFrame?.();
      };
    }, [key, measured, fontEpoch, showLegend]);

    // A face that swaps in after the pass widens the rotated label and can
    // walk it back onto the legend. The document says when that happened.
    useEffect(() => {
      if (!showLegend) return;
      const fonts = readFontLoadNotifier();
      if (!fonts) return;
      let cancelled = false;
      const onFontsLanded = () => {
        if (!cancelled) setFontEpoch((epoch) => epoch + 1);
      };
      fonts.addEventListener?.("loadingdone", onFontsLanded);
      void fonts.ready?.then?.(onFontsLanded, () => {});
      return () => {
        cancelled = true;
        fonts.removeEventListener?.("loadingdone", onFontsLanded);
      };
    }, [showLegend]);

    return (
      <div
        ref={rootRef}
        data-cinatra-bar-legend-clearance={String(clearancePx)}
        style={
          {
            height,
            width: "100%",
            "--cinatra-bar-legend-clearance": `${clearancePx}px`,
          } as CSSProperties
        }
      >
        <RechartsBarChart {...props} />
      </div>
    );
  },
);

export default BarChartWithLegendClearance;

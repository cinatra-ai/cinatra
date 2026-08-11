/**
 * cinatra#2669 — the Daily Cost chart draws an unknown cost as unknown.
 *
 * The area is `SUM(cost_usd)`, which skips unpriced rows. The store no longer
 * coalesces that sum, so the chart receives `cost: null` for a bucket with
 * nothing priced and has to DRAW the difference:
 *
 *   - an unpriced-only bucket is a GAP (`null` reaches recharts unclamped, with
 *     `connectNulls` off), never a point sitting on the zero line;
 *   - a mixed bucket is drawn at its known subtotal AND ringed, because that
 *     height is a part of the day's spend and not the whole of it;
 *   - the tooltip names each bucket's unpriced-row count, including for a bucket
 *     recharts would have dropped from its payload entirely;
 *   - an EMPTY day still draws at 0 — nothing happened, and zero is true.
 *
 * Both decisions are PURE functions — `buildDailyCostChartRows` (what reaches
 * recharts) and `shouldRingBucket` (which points are qualified) — so they are
 * asserted on their real output. Only the WIRING is pinned against the component
 * source: mounting a ResponsiveContainer headless measures 0x0 and would assert
 * nothing. The rendered result is proved by the Playwright capture on the PR.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  buildDailyCostChartRows,
  describeBucketCost,
  shouldRingBucket,
  unknownCostNote,
  unknownRowsPhrase,
  type DailyCostBucket,
} from "../src/components/cost-by-provider-table";

const chartSource = readFileSync(
  path.join(__dirname, "..", "src", "components", "cost-time-series-chart.tsx"),
  "utf8",
);

describe("a bucket's tooltip line states exactly what is known", () => {
  it("keeps a measured zero apart from an empty day", () => {
    // Both used to be drawn at 0 and described identically.
    expect(describeBucketCost(0, 0)).toBe("$0.0000");
    expect(describeBucketCost(null, 0)).toBe("no events");
  });

  it("names the count for an unpriced-only bucket rather than a bare word", () => {
    // A chart has no Calls column to lean on, so "unknown" alone would leave an
    // operator unable to tell one unpriced call from fifty.
    expect(describeBucketCost(null, 3)).toBe("unknown (3 unknown-cost rows)");
    expect(describeBucketCost(null, 1)).toBe("unknown (1 unknown-cost row)");
  });

  it("states the remainder for a mixed bucket", () => {
    expect(describeBucketCost(1.2345, 2)).toBe("$1.2345 + 2 unknown-cost rows");
    expect(describeBucketCost(1.2345, 1)).toBe("$1.2345 + 1 unknown-cost row");
  });

  it("leaves a complete subtotal alone", () => {
    expect(describeBucketCost(1.2345, 0)).toBe("$1.2345");
  });

  it("uses the one shared noun phrase, so no surface can soften it", () => {
    expect(unknownRowsPhrase(1)).toBe("1 unknown-cost row");
    expect(unknownRowsPhrase(2)).toBe("2 unknown-cost rows");
    expect(describeBucketCost(1, 2)).toContain(unknownRowsPhrase(2));
    expect(describeBucketCost(null, 2)).toContain(unknownRowsPhrase(2));
  });
});

describe("the pivot decides what the chart can draw", () => {
  const bucket = (
    day: string,
    provider: string,
    cost: number | null,
    unknownCostCount: number,
  ): DailyCostBucket => ({ day, provider, cost, unknownCostCount });

  it("plots an EMPTY bucket at zero and an UNPRICED-ONLY one as a hole", () => {
    const { chartRows } = buildDailyCostChartRows([
      bucket("2026-08-01", "openai", null, 0), // empty
      bucket("2026-08-02", "openai", 0, 0), // measured zero
      bucket("2026-08-03", "openai", null, 3), // unpriced only
      bucket("2026-08-04", "openai", 1.25, 2), // mixed
    ]);
    // Nothing happened → zero is the true height.
    expect(chartRows[0]!.openai).toBe(0);
    // A measured zero is the same height for a different reason — and the
    // tooltip, not the plot, is where those two are told apart.
    expect(chartRows[1]!.openai).toBe(0);
    // Nothing priced → NO height. `null` is what breaks the area.
    expect(chartRows[2]!.openai).toBeNull();
    // A partial subtotal is still a real number and is still drawn.
    expect(chartRows[3]!.openai).toBe(1.25);
  });

  it("keeps the plotted row a pure day + one key per provider", () => {
    // The unpriced counts live in `bucketsByDay`, never as a
    // `"<provider>__unknown"` sidecar inside the plotted row: provider (and, on
    // other groupings, agent and model) names are DATABASE values, so a bucket
    // genuinely called `openai__unknown` would overwrite openai's count.
    const { chartRows } = buildDailyCostChartRows([
      bucket("2026-08-03", "openai", 1, 3),
      bucket("2026-08-03", "openai__unknown", 0.5, 0),
    ]);
    expect(Object.keys(chartRows[0]!).sort()).toEqual([
      "day",
      "openai",
      "openai__unknown",
    ]);
    expect(chartRows[0]!.openai).toBe(1);
    expect(chartRows[0]!["openai__unknown"]).toBe(0.5);
  });

  it("keeps every provider of a day reachable for the tooltip", () => {
    // recharts DROPS null-valued series from the payload it hands a tooltip —
    // exactly the bucket that most needs explaining would vanish from the hover
    // card and leave the gap unexplained. The pivot hands the rows back whole.
    const { bucketsByDay, providers } = buildDailyCostChartRows([
      bucket("2026-08-03", "openai", null, 3),
      bucket("2026-08-03", "gemini", 0.5, 0),
    ]);
    expect(providers).toEqual(["gemini", "openai"]);
    const day = bucketsByDay.get("2026-08-03")!;
    expect(day.get("openai")).toMatchObject({ cost: null, unknownCostCount: 3 });
    expect(day.get("gemini")).toMatchObject({ cost: 0.5, unknownCostCount: 0 });
  });

  it("counts the range's unpriced rows and the days they fall on", () => {
    const { unknownRowTotal, unknownDayCount } = buildDailyCostChartRows([
      bucket("2026-08-01", "openai", 1, 0),
      bucket("2026-08-02", "openai", null, 3),
      bucket("2026-08-02", "gemini", 1, 1),
      bucket("2026-08-03", "openai", 2, 2),
    ]);
    expect(unknownRowTotal).toBe(6);
    expect(unknownDayCount).toBe(2);
    expect(unknownCostNote(unknownRowTotal, unknownDayCount)).toContain(
      "6 unknown-cost rows on 2 days",
    );
  });

  it("survives a provider named after an Object.prototype member", () => {
    // Bucket names are DATABASE values. On an object literal,
    // `rows["constructor"] ?? 0` starts from the Object constructor, and
    // assigning `__proto__` mutates the prototype instead of adding a key.
    const { chartRows, providers } = buildDailyCostChartRows([
      bucket("2026-08-01", "constructor", null, 2),
      bucket("2026-08-01", "__proto__", 1.5, 0),
      bucket("2026-08-01", "toString", 0, 0),
    ]);
    expect(providers).toEqual(["__proto__", "constructor", "toString"]);
    const row = chartRows[0]!;
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
    expect(row["constructor"]).toBeNull();
    expect(row["toString"]).toBe(0);

    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});

describe("only a PARTIAL point is ringed", () => {
  const b = (cost: number | null, unknownCostCount: number): DailyCostBucket => ({
    day: "2026-08-01",
    provider: "openai",
    cost,
    unknownCostCount,
  });

  it("rings a mixed bucket and leaves a complete one bare", () => {
    expect(shouldRingBucket(b(1.25, 2))).toBe(true);
    expect(shouldRingBucket(b(1.25, 0))).toBe(false);
    // A measured zero is complete: nothing to qualify.
    expect(shouldRingBucket(b(0, 0))).toBe(false);
    // …and a measured zero that ALSO hides unpriced rows is partial.
    expect(shouldRingBucket(b(0, 1))).toBe(true);
  });

  it("does NOT ring an unpriced-only bucket — a gap has no point to ring", () => {
    // The rule checks BOTH halves. Testing only the count would mark the very
    // bucket the chart deliberately refuses to plot.
    expect(shouldRingBucket(b(null, 3))).toBe(false);
  });

  it("never rings on a missing or non-numeric value", () => {
    expect(shouldRingBucket(undefined)).toBe(false);
    expect(shouldRingBucket(b(Number.NaN, 2))).toBe(false);
    expect(shouldRingBucket({ ...b(1, 0), unknownCostCount: "2" as unknown as number })).toBe(false);
  });
});

describe("the chart's drawing decisions", () => {
  it("lets a null bucket break the area instead of connecting through it", () => {
    // `connectNulls` defaults to false, but stating it is the point: a future
    // edit that turns it on would silently draw a straight line ACROSS a day
    // whose cost nobody knows.
    expect(chartSource).toContain("connectNulls={false}");
  });

  it("plots the pivot's own rows, with no second zero-fill on the way in", () => {
    expect(chartSource).toContain("buildDailyCostChartRows(data)");
    expect(chartSource).toContain("<AreaChart data={chartRows}>");
    expect(chartSource).not.toMatch(/row\.cost\s*\?\?\s*0/);
  });

  it("marks a mixed bucket through the tested predicate, off the store row", () => {
    expect(chartSource).toContain("shouldRingBucket(bucket)");
    expect(chartSource).toContain("buckets.get(String(payload?.day ?? \"\"))?.get(provider)");
    expect(chartSource).toContain("data-unknown-cost-marker");
    // No sidecar key namespace inside the plotted row (the prose above the
    // renderer names the shape it refuses, so match the CODE, not the comment).
    expect(chartSource).not.toMatch(/\$\{provider\}__unknown/);
    expect(chartSource).not.toMatch(/UNKNOWN_SUFFIX/);
  });

  it("builds the tooltip from the store rows, not from recharts' payload", () => {
    expect(chartSource).toContain("bucketsByDay");
    expect(chartSource).toContain("describeBucketCost(row.cost, row.unknownCostCount)");
  });

  it("captions the range so the gaps and rings are legible without hovering", () => {
    expect(chartSource).toContain("unknownCostNote(unknownRowTotal, unknownDayCount)");
    expect(chartSource).toContain("daily-cost-unknown-note");
  });
});

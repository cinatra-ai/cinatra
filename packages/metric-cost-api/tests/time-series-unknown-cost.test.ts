/**
 * cinatra#2669 — the time series stops laundering "unknown" into "$0.00".
 *
 * `COALESCE(SUM(ue.cost_usd), 0)` was doing two different jobs at once. The
 * COALESCE existed for the date spine: an outer-joined day with no events has no
 * sum, and a chart wants a number. But `SUM` also skips rows whose `cost_usd` is
 * NULL — an image call, a knowledge-graph episode, a model with no rate card —
 * so the SAME coalesce turned "we do not know what this day cost" into a
 * confident zero, and drew it at exactly the height of a day that cost nothing.
 *
 * Four bucket states have to stay apart, and three of them used to collapse:
 *
 *   empty (spine)   cost null,   unknown 0
 *   measured zero   cost 0,      unknown 0
 *   unpriced only   cost null,   unknown > 0
 *   mixed           cost number, unknown > 0
 *
 * The SQL assertions here are negative controls by construction: they demand the
 * absence of the coalesce and the presence of the companion count, so they RED
 * against the pre-#2669 query. The pivot assertions run the real pivot over rows
 * shaped like each of the four states plus a priced-only one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Only the DB CONNECTION is mocked. The real drizzle schema stays loaded so the
// emitted SQL is the SQL production sends, rendered through the real dialect.
// ---------------------------------------------------------------------------
const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock("../src/db", async () => {
  const { pgSchema, text } = await import("drizzle-orm/pg-core");
  const s = pgSchema("cinatra");
  return {
    db: { execute: mockExecute },
    metadataTable: s.table("metadata", {
      key: text("key").primaryKey(),
      value: text("value").notNull(),
    }),
  };
});

import {
  readCostSummary,
  readCostTimeSeries,
  readCostTimeseriesForChart,
} from "../src/store";

const dialect = new PgDialect();

/** The SQL text of the most recent `db.execute`, rendered as Postgres sees it. */
function lastSql(): string {
  const call = mockExecute.mock.calls.at(-1);
  expect(call, "db.execute was never called").toBeDefined();
  return dialect.sqlToQuery(call![0]).sql;
}

/** Whitespace-insensitive haystack for readability of the assertions below. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

beforeEach(() => {
  mockExecute.mockReset();
});

describe("readCostTimeSeries — the query reports what it could not price", () => {
  it("does NOT coalesce the cost subtotal to zero", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await readCostTimeSeries({ days: 30 });
    const sql = flat(lastSql()).toLowerCase();
    // The exact pre-#2669 expression. Its presence IS the defect.
    expect(sql).not.toContain("coalesce(sum(ue.cost_usd), 0)");
    expect(sql).toContain("sum(ue.cost_usd)::float as cost");
  });

  it("counts the unpriced rows per (day, provider) bucket", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await readCostTimeSeries({ days: 7 });
    const sql = flat(lastSql()).toLowerCase();
    expect(sql).toContain(
      `count(ue.id) filter (where ue.cost_usd is null)::int as "unknowncostcount"`,
    );
  });

  it("counts ue.id, not *, so an EMPTY spine bucket reports zero unpriced rows", async () => {
    // The trap: on a spine-only row every ue.* column is NULL, so
    // `cost_usd IS NULL` is TRUE and COUNT(*) would report one unpriced row for
    // every day nothing happened — the chart would claim unknown spend on an
    // empty ledger.
    mockExecute.mockResolvedValue({ rows: [] });
    await readCostTimeSeries({ days: 30 });
    const sql = flat(lastSql()).toLowerCase();
    expect(sql).not.toContain("count(*) filter (where ue.cost_usd is null)");
  });

  // NOT a regression pin — `db.execute` is mocked, so this documents the row
  // CONTRACT (both halves present, four states reconstructible) and would pass
  // against any query. The behavioural pin is the real-Postgres tier in
  // src/__tests__/integration/unknown-cost-aggregation.integration.test.ts.
  it("documents the row contract: cost + count reconstruct all four states", async () => {
    const rows = [
      { day: "2026-08-01", provider: "openai", cost: null, unknownCostCount: 0 },
      { day: "2026-08-02", provider: "openai", cost: 0, unknownCostCount: 0 },
      { day: "2026-08-03", provider: "openai", cost: null, unknownCostCount: 3 },
      { day: "2026-08-04", provider: "openai", cost: 1.25, unknownCostCount: 2 },
      { day: "2026-08-05", provider: "openai", cost: 1.25, unknownCostCount: 0 },
    ];
    mockExecute.mockResolvedValue({ rows });
    const result = await readCostTimeSeries({ days: 7 });
    expect(result).toEqual(rows);
    // Every state is reconstructible from the pair, which is the whole contract.
    const state = (r: { cost: number | null; unknownCostCount: number }) =>
      r.cost === null
        ? r.unknownCostCount === 0
          ? "empty"
          : "unpriced-only"
        : r.unknownCostCount === 0
          ? "priced"
          : "mixed";
    expect(result.map(state)).toEqual([
      "empty",
      "priced",
      "unpriced-only",
      "mixed",
      "priced",
    ]);
    // …and "measured zero" is a PRICED state whose amount happens to be zero.
    expect(result[1]!.cost).toBe(0);
  });
});

describe("readCostTimeseriesForChart — counts per bucket and per day", () => {
  /** One SQL row as the query returns it. */
  function row(
    day: string,
    bucket: string,
    rowCount: number,
    cost: number | null,
    unknownCostCount: number,
  ) {
    return { day, bucket, rowCount, cost, unknownCostCount };
  }

  it("emits the row count and the unpriced count, and no coalesced subtotal", async () => {
    mockExecute.mockResolvedValue({ rows: [] });
    await readCostTimeseriesForChart({ days: 14, groupBy: "provider" });
    const sql = flat(lastSql()).toLowerCase();
    expect(sql).not.toContain("coalesce(sum(ue.cost_usd), 0)");
    expect(sql).toContain(`count(ue.id)::int as "rowcount"`);
    expect(sql).toContain(
      `count(ue.id) filter (where ue.cost_usd is null)::int as "unknowncostcount"`,
    );
  });

  it("keeps every bucket state distinguishable and totals only what is known", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        // priced only
        row("2026-08-01", "openai", 2, 1.5, 0),
        // measured zero — real rows, real $0
        row("2026-08-02", "openai", 1, 0, 0),
        // unpriced only
        row("2026-08-03", "openai", 3, null, 3),
        // mixed, next to a clean bucket on the same day
        row("2026-08-04", "openai", 4, 2.0, 1),
        row("2026-08-04", "gemini", 1, 0.5, 0),
        // empty day: the outer join's fabricated group
        row("2026-08-05", "unknown", 0, null, 0),
      ],
    });
    const result = await readCostTimeseriesForChart({ days: 5, groupBy: "provider" });
    const byDate = new Map(result.points.map((p) => [p.date, p]));

    // priced only
    expect(byDate.get("2026-08-01")).toMatchObject({
      buckets: { openai: 1.5 },
      unknownCostCounts: { openai: 0 },
      total: 1.5,
      unknownCostCount: 0,
    });
    // measured zero — a real amount, not a gap
    expect(byDate.get("2026-08-02")).toMatchObject({
      buckets: { openai: 0 },
      total: 0,
      unknownCostCount: 0,
    });
    // unpriced only — NO subtotal, and the count says how much is missing
    expect(byDate.get("2026-08-03")).toMatchObject({
      buckets: { openai: null },
      unknownCostCounts: { openai: 3 },
      total: null,
      unknownCostCount: 3,
    });
    // mixed — a real partial subtotal, per bucket AND for the day
    expect(byDate.get("2026-08-04")).toMatchObject({
      buckets: { openai: 2.0, gemini: 0.5 },
      unknownCostCounts: { openai: 1, gemini: 0 },
      total: 2.5,
      unknownCostCount: 1,
    });
  });

  it("keeps the date spine dense but drops the outer join's phantom bucket", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        row("2026-08-01", "openai", 1, 1.5, 0),
        row("2026-08-02", "unknown", 0, null, 0),
        row("2026-08-03", "unknown", 0, null, 0),
      ],
    });
    const result = await readCostTimeseriesForChart({ days: 3, groupBy: "provider" });
    // Dense: one point per spine day, in order.
    expect(result.points.map((p) => p.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    // The empty days carry NO bucket. A fabricated bucket literally named
    // "unknown" holding 0 would be indistinguishable from a real
    // `agent_label IS NULL` group that genuinely cost nothing — which is the
    // exact confusion this issue exists to remove.
    expect(result.points[1]!.buckets).toEqual({});
    expect(result.points[1]!.unknownCostCounts).toEqual({});
    // …and a day where NOTHING happened still has a known total of zero. `null`
    // is reserved for the day that held rows nobody could price; `buckets: {}`
    // already says which case this is, so nulling it here would only make an
    // agent consult a second field to learn something it can already see.
    expect(result.points[1]!.total).toBe(0);
    expect(result.points[1]!.unknownCostCount).toBe(0);
  });

  it("keeps a bucket named after an Object.prototype member", async () => {
    // Bucket names are DATABASE values: an agent or model may be called
    // `constructor` or `__proto__`. On a plain object, `buckets[name] ?? 0`
    // starts from the inherited member and `name in buckets` is true before
    // anything is written — the unpriced-only branch would DROP the bucket.
    mockExecute.mockResolvedValue({
      rows: [
        row("2026-08-01", "constructor", 2, null, 2),
        row("2026-08-01", "__proto__", 1, 1.5, 0),
        row("2026-08-01", "toString", 1, 0, 0),
      ],
    });
    const result = await readCostTimeseriesForChart({ days: 1, groupBy: "model" });
    const point = result.points[0]!;
    expect(Object.hasOwn(point.buckets, "__proto__")).toBe(true);
    expect(point.buckets["constructor"]).toBeNull();
    expect(point.buckets["__proto__"]).toBe(1.5);
    expect(point.buckets["toString"]).toBe(0);
    expect(point.unknownCostCounts["constructor"]).toBe(2);
    expect(point.total).toBe(1.5);
    expect(point.unknownCostCount).toBe(2);
  });

  it("totals only the priced buckets when a day mixes several", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        row("2026-08-01", "gpt-4o", 3, 2.0, 0),
        row("2026-08-01", "unknown", 4, null, 4),
        row("2026-08-01", "gemini-2.5-pro", 1, 0, 0),
      ],
    });
    const result = await readCostTimeseriesForChart({ days: 1, groupBy: "model" });
    const point = result.points[0]!;
    expect(point.total).toBe(2.0);
    expect(point.unknownCostCount).toBe(4);
    expect(point.buckets).toEqual({
      "gpt-4o": 2.0,
      unknown: null,
      "gemini-2.5-pro": 0,
    });
  });

  it("a real NULL-labelled group survives, phantom-looking name and all", async () => {
    // Grouping by agent puts real rows in a bucket named "unknown" (the
    // COALESCE of a NULL agent_label). rowCount is what tells it apart from the
    // spine's phantom, so it must NOT be dropped.
    mockExecute.mockResolvedValue({
      rows: [row("2026-08-01", "unknown", 2, null, 2)],
    });
    const result = await readCostTimeseriesForChart({ days: 1, groupBy: "agent" });
    expect(result.points[0]!.buckets).toEqual({ unknown: null });
    expect(result.points[0]!.unknownCostCounts).toEqual({ unknown: 2 });
    expect(result.points[0]!.unknownCostCount).toBe(2);
  });
});

describe("readCostSummary — the month's unpriced rows, on the month's window", () => {
  it("counts unpriced rows over the SAME window the monthly amount is summed over", async () => {
    mockExecute.mockResolvedValue({ rows: [{}] });
    await readCostSummary();
    const sql = flat(lastSql());
    const window =
      "occurred_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') " +
      "AND occurred_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')";
    // Both the amount and its qualifier carry the window — literally the same
    // expression, embedded twice, so they cannot drift apart.
    expect(sql).toContain(`SUM(cost_usd) FILTER (WHERE ${window} )`);
    expect(sql).toContain(
      `COUNT(*) FILTER (WHERE cost_usd IS NULL AND ${window} )::int AS null_cost_count_this_month`,
    );
    expect(sql.split(window).length - 1).toBe(2);
  });

  it("bounds the month at both ends, on an explicit UTC instant", async () => {
    mockExecute.mockResolvedValue({ rows: [{}] });
    await readCostSummary();
    const sql = flat(lastSql());
    // Upper bound: a future-dated row (producer clock skew) must not count
    // toward a figure the budget alert calls a FLOOR of this month's spend.
    expect(sql).toContain("+ interval '1 month'");
    // Both boundaries are cast BACK to timestamptz. A bare
    // `date_trunc('month', now() AT TIME ZONE 'UTC')` is a timestamp WITHOUT
    // time zone, which Postgres compares against `occurred_at` in the SESSION's
    // timezone — so on a non-UTC session the month began at the wrong instant.
    expect(sql.split("AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("reports the month-scoped count independently of the all-time one", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        {
          total_all_time: 12.5,
          total_this_month: 2.5,
          total_this_week: 1,
          event_count: 40,
          null_cost_count: 9,
          null_cost_count_this_month: 2,
        },
      ],
    });
    const summary = await readCostSummary();
    expect(summary.nullCostCount).toBe(9);
    expect(summary.nullCostCountThisMonth).toBe(2);
  });

  it("reads a month with no unpriced rows as exactly zero, not as the all-time count", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        {
          total_all_time: 12.5,
          total_this_month: 2.5,
          total_this_week: 1,
          event_count: 40,
          null_cost_count: 9,
          null_cost_count_this_month: 0,
        },
      ],
    });
    const summary = await readCostSummary();
    expect(summary.nullCostCountThisMonth).toBe(0);
  });
});

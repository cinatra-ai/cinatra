/**
 * cinatra#2669 — the aggregations that still turned "unknown" into "$0.00",
 * proved against a REAL `usage_events` table.
 *
 * WHY THIS TIER. The defect is a property of SQL, not of TypeScript: `SUM`
 * ignores NULLs, `COUNT(*)` counts an outer join's fabricated rows, `COUNT(col)`
 * does not, and a `COALESCE` around a `SUM` decides whether "nobody priced this"
 * arrives as `null` or as a confident `0`. Every one of those is invisible to a
 * mocked `db.execute` — a unit test can assert the query TEXT, but only Postgres
 * can say what the query MEANS. cinatra#2667 established the pattern (real
 * subscriber, real table, fake adapter, no provider); this file extends it from
 * the three breakdown tables to the two time series, the monthly budget window,
 * and the `llm_usage` cube.
 *
 * WHAT IS REAL HERE. The metering seam's emitter, the in-process usage bus, the
 * real cost subscriber and its pricing decision, `insertUsageEvent`, a real
 * Postgres table with the real unique index, the four store read functions
 * `/analytics/llm` calls, and the cube's own generated SQL executed by Postgres.
 * NOTHING on the read path is stubbed and NO provider is contacted: the rows are
 * driven through the seam's emitter with a chosen `occurredAt`, which is the one
 * thing a backdated fixture has to choose (the capture path itself is pinned by
 * the cinatra#2578 tier and is not re-proved here).
 *
 * WHAT IS PINNED — the four bucket states, kept apart:
 *
 *   | state          | cost     | unknownCostCount |
 *   |----------------|----------|------------------|
 *   | empty (spine)  | null     | 0                |
 *   | measured zero  | 0        | 0                |
 *   | unpriced only  | null     | > 0              |
 *   | mixed          | a number | > 0              |
 *
 * NEGATIVE CONTROL. Against the pre-#2669 queries the unpriced-only and
 * measured-zero rows are the SAME row (`cost: 0`), the mixed bucket reports a
 * complete-looking subtotal, the month count does not exist, and the cube prices
 * unpriced rows at zero. Every assertion below that names `null` or a count reds
 * on the old code.
 *
 * RUNNER (real DB required — the suite self-skips without one):
 *   SUPABASE_DB_URL=postgres://…@127.0.0.1:5434/postgres SUPABASE_SCHEMA=lane_2669x \
 *     pnpm exec vitest run --config vitest/integration/2669.config.ts
 * The schema is CREATED in beforeAll and DROPPED in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { integer, numeric, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

// ---------------------------------------------------------------------------
// Fail-closed real-DB fence (same three fences as the cinatra#2578 tier: an
// identifier-safe LANE-OWNED name, ownership by creation rather than by naming,
// and a skip on anything unresolvable).
// ---------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "").trim();

const SAFE_LANE_SCHEMA = /^lane_2669[a-z0-9_]*$/;
const SHARED_SCHEMAS = new Set([
  "public",
  "cinatra",
  "information_schema",
  "pg_catalog",
  "pg_toast",
]);
const HAS_REAL_DB =
  DB_URL !== "" &&
  !isPlaceholderDbUrl(DB_URL) &&
  SAFE_LANE_SCHEMA.test(SCHEMA) &&
  !SHARED_SCHEMAS.has(SCHEMA.toLowerCase());

/**
 * Set by `vitest/integration/2669.config.ts` and by nothing else. A suite whose
 * only failure mode is "skipped" reports success by doing nothing — the same
 * shape of silence this issue is about — so the DEDICATED lane refuses to skip.
 */
const IN_DEDICATED_LANE = process.env.CINATRA_UNKNOWN_COST_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_REAL_DB) {
  throw new Error(
    "the unknown-cost aggregation lane needs a live Postgres and a lane-owned " +
      "schema: set SUPABASE_DB_URL to a real connection and SUPABASE_SCHEMA to a " +
      "name matching /^lane_2669[a-z0-9_]*$/ that does NOT already exist. " +
      "Refusing to skip — a skipped aggregation proof proves nothing.",
  );
}

// ---------------------------------------------------------------------------
// The REAL modules under proof
// ---------------------------------------------------------------------------

import { emitLlmUsage } from "../../../packages/llm/src/usage-metering";
import { startUsageEventSubscriber } from "../../../packages/metric-cost-api/src/event-subscriber";
import {
  readCostSummary,
  readCostTimeSeries,
  readCostTimeseriesForChart,
} from "../../../packages/metric-cost-api/src/store";
// Through the package's own seam, never `drizzle-cube/*` directly: that
// directory is the ONLY place in the repository allowed to import it (ESLint
// no-restricted-imports, pinned by src/__tests__/eslint-boundary.test.ts).
// `executeQuery` also RUNS the cube's SQL, which is the point — Postgres, not a
// string comparison, is the judge of whether the measures are legal.
import {
  createDrizzleCubeAdapter,
  createLlmUsageCube,
} from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const USAGE_EVENTS_DDL = `
  CREATE TABLE "%SCHEMA%"."usage_events" (
    id                      text PRIMARY KEY,
    occurred_at             timestamptz NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    source                  text NOT NULL,
    provider                text NOT NULL,
    requested_provider      text,
    effective_provider      text,
    model                   text,
    operation               text,
    agent_label             text,
    skill_label             text,
    input_tokens            integer NOT NULL DEFAULT 0,
    output_tokens           integer NOT NULL DEFAULT 0,
    cached_input_tokens     integer NOT NULL DEFAULT 0,
    reasoning_output_tokens integer NOT NULL DEFAULT 0,
    credits_consumed        integer NOT NULL DEFAULT 0,
    cost_usd                numeric(12,8),
    idempotency_key         text NOT NULL
  )`;

const IDEMPOTENCY_INDEX_DDL = `
  CREATE UNIQUE INDEX usage_events_idempotency_key_idx
    ON "%SCHEMA%"."usage_events" (idempotency_key)`;

/** Pricing is read from this table first, then the in-code card. Empty ⇒ card. */
const MODEL_PRICING_DDL = `
  CREATE TABLE "%SCHEMA%"."model_pricing" (
    id                      text PRIMARY KEY,
    provider                text NOT NULL,
    model_name              text NOT NULL,
    input_cost_per_million  numeric(20,8) NOT NULL,
    output_cost_per_million numeric(20,8) NOT NULL,
    cache_read_per_million  numeric(20,8),
    source                  text NOT NULL DEFAULT 'litellm',
    updated_at              timestamptz NOT NULL DEFAULT now()
  )`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A PRICED row: gpt-4o is on the in-code rate card, so 100k input tokens price
 * to exactly $0.25 and the row lands with a real number.
 */
const PRICED_INPUT_TOKENS = 100_000;
const PRICED_COST_USD = 0.25;

let keySeq = 0;
function nextKey(tag: string): string {
  return `cinatra-2669-${tag}-${++keySeq}`;
}

/** Midday UTC `daysAgo` days back — far from any day or month boundary. */
function daysAgoIso(daysAgo: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#2669 — an unpriced row stays unpriced through every aggregation",
  () => {
    let admin: Client;
    /** Only a schema this process CREATED may be dropped. */
    let createdSchema = false;

    async function rowCount(): Promise<number> {
      const res = await admin.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM "${SCHEMA}"."usage_events"`,
      );
      return Number(res.rows[0]!.n);
    }

    /**
     * Wait until the ledger holds exactly `expected` rows AND stops changing.
     * The bus handler is async and deliberately un-awaited by the call path, so
     * a settle is the only way a caller observes the write — and stopping at the
     * expected count would go blind to a LATE extra row.
     */
    async function settle(expected: number, timeoutMs = 20_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      let n = await rowCount();
      while (n < expected && Date.now() < deadline) {
        await sleep(20);
        n = await rowCount();
      }
      let last = n;
      let stableSince = Date.now();
      while (Date.now() - stableSince < 300 && Date.now() < deadline + 300) {
        await sleep(25);
        n = await rowCount();
        if (n !== last) {
          last = n;
          stableSince = Date.now();
        }
      }
      expect(n, "the ledger did not settle at the driven row count").toBe(expected);
    }

    // -----------------------------------------------------------------------
    // Seeds. Every row goes through the seam's emitter → the real bus → the
    // real subscriber (which makes the pricing decision) → the real table.
    // -----------------------------------------------------------------------

    /** A row the rate card CAN price. */
    function seedPriced(occurredAt: string, agentLabel = "content-writer"): void {
      emitLlmUsage({
        provider: "openai",
        model: "gpt-4o",
        operation: "generate",
        logLabel: agentLabel,
        usage: {
          inputTokens: PRICED_INPUT_TOKENS,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        idempotencyKey: nextKey("priced"),
        occurredAt,
      });
    }

    /**
     * A row that genuinely cost NOTHING: the key-validation catalog read is
     * priced EXPLICITLY at zero, so it lands as `0.00000000` — a measurement,
     * not a gap. This is the row an unpriced one must never be confused with.
     */
    function seedMeasuredZero(occurredAt: string): void {
      emitLlmUsage({
        provider: "openai",
        model: "models.list",
        operation: "validate",
        logLabel: "key-probe",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        idempotencyKey: nextKey("zero"),
        occurredAt,
      });
    }

    /**
     * A row the ledger COUNTS but cannot price: an image call. The subscriber
     * refuses to run the per-token card over it, so `cost_usd` is NULL.
     */
    function seedUnpriced(occurredAt: string, agentLabel = "blog-post-image"): void {
      emitLlmUsage({
        provider: "openai",
        // The image response names no model — the seam records what it knows.
        model: null,
        operation: "image",
        logLabel: agentLabel,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        idempotencyKey: nextKey("image"),
        occurredAt,
      });
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();

      // Ownership, not naming: CREATE SCHEMA without IF NOT EXISTS throws on an
      // existing schema rather than dropping someone else's data.
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
      createdSchema = true;
      await admin.query(USAGE_EVENTS_DDL.replaceAll("%SCHEMA%", SCHEMA));
      await admin.query(IDEMPOTENCY_INDEX_DDL.replaceAll("%SCHEMA%", SCHEMA));
      await admin.query(MODEL_PRICING_DDL.replaceAll("%SCHEMA%", SCHEMA));

      startUsageEventSubscriber();

      // WIRING PRECONDITION. Under a config that stubs the usage bus every
      // assertion below fails one at a time with nothing naming the cause.
      seedPriced(daysAgoIso(0));
      await settle(1, 5_000).catch(() => {
        throw new Error(
          "the usage bus does not reach this schema — the emitter is stubbed or " +
            "SUPABASE_SCHEMA is not the schema this suite created. Run it with " +
            "`--config vitest/integration/2669.config.ts`.",
        );
      });
      await admin.query(`TRUNCATE "${SCHEMA}"."usage_events"`);
    });

    afterAll(async () => {
      if (admin) {
        if (createdSchema) await admin.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
        await admin.end();
      }
    });

    beforeEach(async () => {
      // Drain before truncating: a subscriber still pricing when the next test
      // truncates would land its insert afterwards and contaminate the count.
      await settle(await rowCount(), 5_000).catch(() => undefined);
      await admin.query(`TRUNCATE "${SCHEMA}"."usage_events"`);
    });

    // =======================================================================
    // 1. readCostTimeSeries — the Daily Cost chart's own query
    // =======================================================================

    describe("readCostTimeSeries keeps four bucket states apart", () => {
      it("distinguishes empty, measured-zero, unpriced-only and mixed days", async () => {
        // D-4 is left EMPTY on purpose — the spine has to produce it anyway.
        seedMeasuredZero(daysAgoIso(3));
        seedUnpriced(daysAgoIso(2));
        seedUnpriced(daysAgoIso(2));
        seedPriced(daysAgoIso(1));
        seedPriced(daysAgoIso(0));
        seedUnpriced(daysAgoIso(0));
        await settle(6);

        const rows = await readCostTimeSeries({ days: 7 });
        const byDay = new Map(rows.map((r) => [r.day, r]));
        const day = (n: number) => byDay.get(daysAgoIso(n).slice(0, 10));

        // EMPTY — nothing joined. No subtotal to state, and NOTHING unpriced:
        // the counter must not mistake the outer join's fabricated row for a
        // real unpriced one (that is the COUNT(ue.id) vs COUNT(*) trap).
        expect(day(4)).toMatchObject({ cost: null, unknownCostCount: 0 });

        // MEASURED ZERO — a real row, priced explicitly at zero.
        expect(day(3)).toMatchObject({ cost: 0, unknownCostCount: 0 });

        // UNPRICED ONLY — two image calls. Pre-#2669 this bucket arrived as
        // `cost: 0` and was drawn at the SAME height as the day above it.
        expect(day(2)).toMatchObject({ cost: null, unknownCostCount: 2 });

        // PRICED ONLY — an ordinary complete subtotal, untouched.
        expect(day(1)).toMatchObject({ cost: PRICED_COST_USD, unknownCostCount: 0 });

        // MIXED — a real subtotal that is only PART of the day's spend.
        expect(day(0)).toMatchObject({ cost: PRICED_COST_USD, unknownCostCount: 1 });
      });

      it("keeps the date spine dense across the whole requested range", async () => {
        seedUnpriced(daysAgoIso(0));
        await settle(1);
        const rows = await readCostTimeSeries({ days: 30 });
        // One provider in the ledger ⇒ 30 (day, provider) buckets.
        expect(rows).toHaveLength(30);
        expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(["openai"]));
        // …and 29 of them are EMPTY, not "unknown".
        expect(rows.filter((r) => r.unknownCostCount > 0)).toHaveLength(1);
        expect(rows.filter((r) => r.cost === null && r.unknownCostCount === 0)).toHaveLength(29);
      });
    });

    // =======================================================================
    // 2. readCostTimeseriesForChart — the MCP tool's shape
    // =======================================================================

    describe("readCostTimeseriesForChart counts per bucket and per day", () => {
      it("reports the unpriced rows of each bucket and of the day's total", async () => {
        seedPriced(daysAgoIso(0), "content-writer");
        seedUnpriced(daysAgoIso(0), "content-writer");
        seedUnpriced(daysAgoIso(0), "blog-post-image");
        await settle(3);

        const result = await readCostTimeseriesForChart({ days: 3, groupBy: "agent" });
        const today = result.points.find((p) => p.date === daysAgoIso(0).slice(0, 10));
        expect(today, "today is missing from the dense spine").toBeDefined();

        // MIXED bucket: a real subtotal AND what it leaves out.
        expect(today!.buckets["content-writer"]).toBe(PRICED_COST_USD);
        expect(today!.unknownCostCounts["content-writer"]).toBe(1);
        // UNPRICED-ONLY bucket: no subtotal at all.
        expect(today!.buckets["blog-post-image"]).toBeNull();
        expect(today!.unknownCostCounts["blog-post-image"]).toBe(1);
        // The DAY's total is the known part, with its own remainder.
        expect(today!.total).toBe(PRICED_COST_USD);
        expect(today!.unknownCostCount).toBe(2);
      });

      it("keeps a dense spine whose empty days carry no fabricated bucket", async () => {
        seedPriced(daysAgoIso(0));
        await settle(1);

        const result = await readCostTimeseriesForChart({ days: 5, groupBy: "provider" });
        expect(result.points).toHaveLength(5);
        expect(result.points.map((p) => p.date)).toEqual(
          [4, 3, 2, 1, 0].map((n) => daysAgoIso(n).slice(0, 10)),
        );
        for (const point of result.points.slice(0, 4)) {
          // The outer join's all-NULL row used to pivot into a bucket literally
          // named "unknown" holding 0 — indistinguishable from a real
          // NULL-labelled group that genuinely cost nothing.
          expect(point.buckets).toEqual({});
          expect(point.unknownCostCounts).toEqual({});
          // A day where nothing happened still has a KNOWN total of zero;
          // `buckets: {}` is what says it was empty. `null` stays reserved for
          // a day that HELD rows nobody could price.
          expect(point.total).toBe(0);
          expect(point.unknownCostCount).toBe(0);
        }
        expect(result.points[4]!.buckets).toEqual({ openai: PRICED_COST_USD });
      });

      it("a REAL null-labelled group survives, phantom-looking name and all", async () => {
        // An image row carries no agent label, so grouping by agent puts it in a
        // bucket named "unknown" — the same name the spine's phantom would use.
        emitLlmUsage({
          provider: "openai",
          model: null,
          operation: "image",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          idempotencyKey: nextKey("unlabelled"),
          occurredAt: daysAgoIso(0),
        });
        await settle(1);

        const result = await readCostTimeseriesForChart({ days: 1, groupBy: "agent" });
        expect(result.points).toHaveLength(1);
        expect(result.points[0]!.buckets).toEqual({ unknown: null });
        expect(result.points[0]!.unknownCostCounts).toEqual({ unknown: 1 });
      });
    });

    // =======================================================================
    // 3. readCostSummary — the budget alert's month-scoped counter
    // =======================================================================

    describe("readCostSummary counts this month's unpriced rows on the month's window", () => {
      /** Midday UTC on the 15th of the PREVIOUS month — safely outside. */
      function lastMonthIso(): string {
        const now = new Date();
        return new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12),
        ).toISOString();
      }
      /** Midday UTC on the 1st of THIS month — safely inside. */
      function monthStartIso(): string {
        const now = new Date();
        return new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12),
        ).toISOString();
      }

      it("excludes an unpriced row from a PREVIOUS month", async () => {
        seedUnpriced(lastMonthIso());
        seedUnpriced(lastMonthIso());
        seedPriced(monthStartIso());
        await settle(3);

        const summary = await readCostSummary();
        // All-time sees all three; the month sees only what happened in it.
        expect(summary.eventCount).toBe(3);
        expect(summary.nullCostCount).toBe(2);
        expect(summary.nullCostCountThisMonth).toBe(0);
        // The amount the alert compares against the budget is complete here —
        // which is exactly why an ALL-TIME count would mislabel it.
        expect(summary.totalThisMonth).toBe(PRICED_COST_USD);
      });

      it("counts an unpriced row that landed INSIDE the current month", async () => {
        seedUnpriced(lastMonthIso());
        seedPriced(monthStartIso());
        seedUnpriced(monthStartIso());
        seedUnpriced(daysAgoIso(0));
        await settle(4);

        const summary = await readCostSummary();
        expect(summary.nullCostCount).toBe(3);
        expect(summary.nullCostCountThisMonth).toBe(2);
        // The monthly amount is a FLOOR: two of this month's rows are missing
        // from it, which is the whole reason the alert now says "at least".
        expect(summary.totalThisMonth).toBe(PRICED_COST_USD);
      });

      it("reports zero for a month whose rows are all priced", async () => {
        seedPriced(monthStartIso());
        seedMeasuredZero(daysAgoIso(0));
        await settle(2);

        const summary = await readCostSummary();
        expect(summary.nullCostCountThisMonth).toBe(0);
        // A measured zero is NOT an unpriced row — it is a priced row worth $0.
        expect(summary.totalThisMonth).toBe(PRICED_COST_USD);
      });

      it("excludes a FUTURE-dated row from both halves of the month figure", async () => {
        // A producer with a skewed clock can book next month. The old predicate
        // had no upper bound, so that row counted toward "this month" — and a
        // figure the alert now calls a FLOOR of this month's spend must not
        // carry spend that has not happened.
        const nextMonth = (() => {
          const now = new Date();
          return new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5, 12),
          ).toISOString();
        })();
        seedPriced(monthStartIso());
        seedPriced(nextMonth);
        seedUnpriced(nextMonth);
        await settle(3);

        const summary = await readCostSummary();
        expect(summary.eventCount).toBe(3);
        // All-time sees everything the ledger holds…
        expect(summary.totalAllTime).toBeCloseTo(PRICED_COST_USD * 2, 8);
        expect(summary.nullCostCount).toBe(1);
        // …the month sees only what happened inside it.
        expect(summary.totalThisMonth).toBe(PRICED_COST_USD);
        expect(summary.nullCostCountThisMonth).toBe(0);
      });
    });

    // =======================================================================
    // 4. The llm_usage cube — its own SQL, executed by Postgres
    // =======================================================================

    describe("the llm_usage cube separates unknown cost from measured zero", () => {
      // The cube reads whatever table it is bound to; bind it to this lane's.
      const laneSchema = pgSchema(SCHEMA);
      const laneUsageEvents = laneSchema.table("usage_events", {
        id: text("id").primaryKey(),
        costUsd: numeric("cost_usd", { precision: 12, scale: 8 }),
        inputTokens: integer("input_tokens").notNull().default(0),
        outputTokens: integer("output_tokens").notNull().default(0),
        cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
        reasoningOutputTokens: integer("reasoning_output_tokens").notNull().default(0),
        model: text("model"),
        provider: text("provider").notNull(),
        agentLabel: text("agent_label"),
        skillLabel: text("skill_label"),
        operation: text("operation"),
        occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
      });

      async function cubeRows(): Promise<ReadonlyArray<Record<string, unknown>>> {
        const pool = new Pool({ connectionString: DB_URL });
        const cube = createLlmUsageCube({
          tableRef: laneUsageEvents,
          columns: {
            id: laneUsageEvents.id,
            costUsd: laneUsageEvents.costUsd,
            inputTokens: laneUsageEvents.inputTokens,
            outputTokens: laneUsageEvents.outputTokens,
            cachedInputTokens: laneUsageEvents.cachedInputTokens,
            reasoningOutputTokens: laneUsageEvents.reasoningOutputTokens,
            model: laneUsageEvents.model,
            provider: laneUsageEvents.provider,
            agentLabel: laneUsageEvents.agentLabel,
            skillLabel: laneUsageEvents.skillLabel,
            operation: laneUsageEvents.operation,
            occurredAt: laneUsageEvents.occurredAt,
          },
        });
        const adapter = createDrizzleCubeAdapter({
          drizzle: drizzle(pool, { schema: { usageEventsForCube: laneUsageEvents } }),
          schema: { usageEventsForCube: laneUsageEvents },
          cubes: [cube],
        });
        try {
          // A pre-aggregated base expression would be wrapped a second time and
          // Postgres would reject the query with "aggregate function calls
          // cannot be nested" — which is why this runs rather than compares.
          const result = await adapter.executeQuery(
            "llm_usage",
            {
              measures: ["total_cost_usd", "event_count", "unknown_cost_count"],
              dimensions: ["agent_label"],
            },
            {
              userId: "u1",
              organizationId: "org_acme",
              workspaceId: "ws_acme",
              teamIds: [],
              ownerLevel: "organization",
              accessibleOrgIds: ["org_acme"],
              // The cube's SOLE visibility gate. Without it the predicate is a
              // constant `false` and every assertion below would read zero rows
              // as "the measures are broken".
              isPlatformAdmin: true,
            },
          );
          return result.rows as ReadonlyArray<Record<string, unknown>>;
        } finally {
          await pool.end();
        }
      }

      it("reports a null cost and a count for a group with nothing priced", async () => {
        seedUnpriced(daysAgoIso(0), "blog-post-image");
        seedUnpriced(daysAgoIso(0), "blog-post-image");
        seedPriced(daysAgoIso(0), "content-writer");
        seedUnpriced(daysAgoIso(0), "content-writer");
        seedMeasuredZero(daysAgoIso(0));
        await settle(5);

        const rows = await cubeRows();
        const byAgent = new Map(
          rows.map((r) => [String(r.agent_label ?? r["llm_usage.agent_label"] ?? ""), r]),
        );
        const pick = (agent: string) => {
          const row = byAgent.get(agent);
          expect(row, `the cube lost the ${agent} group`).toBeDefined();
          const value = (suffix: string) => {
            const key = Object.keys(row!).find((k) => k.endsWith(suffix));
            return key ? row![key] : undefined;
          };
          return {
            cost: value("total_cost_usd"),
            events: Number(value("event_count")),
            unknown: Number(value("unknown_cost_count")),
          };
        };

        // UNPRICED ONLY — the measure has nothing to sum. Pre-#2669 the
        // coalesce made this group report `0`: a confident "these images were
        // free" about spend nobody has measured.
        const images = pick("blog-post-image");
        expect(images.cost).toBeNull();
        expect(images.events).toBe(2);
        expect(images.unknown).toBe(2);

        // MIXED — a real subtotal, and the count that qualifies it.
        const writer = pick("content-writer");
        expect(Number(writer.cost)).toBeCloseTo(PRICED_COST_USD, 8);
        expect(writer.events).toBe(2);
        expect(writer.unknown).toBe(1);

        // MEASURED ZERO — $0 that was actually measured, and NOT counted as
        // unknown. This is the row the coalesce made indistinguishable from the
        // image group.
        const probe = pick("key-probe");
        expect(Number(probe.cost)).toBe(0);
        expect(probe.unknown).toBe(0);
      });
    });
  },
);

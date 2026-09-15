/**
 * cinatra#2691 — "This Week" stops drifting with the database session's
 * timezone, proved against a REAL `usage_events` table under a NON-UTC session.
 *
 * WHY THIS TIER EXISTS. The defect is a property of how Postgres compares a
 * `timestamp WITHOUT time zone` against a `timestamptz`: a bare
 * `date_trunc('week', now() AT TIME ZONE 'UTC')` is read in the SESSION's
 * timezone, not UTC. A mocked `db.execute` can only assert the query TEXT
 * (see the SQL-shape tests beside this issue's month-window sibling, in
 * packages/metric-cost-api/tests/time-series-unknown-cost.test.ts) — it
 * cannot observe what a non-UTC session actually RETURNS. Only a real
 * Postgres connection opened with a non-UTC timezone can prove the fix
 * survives contact with a session that is not UTC.
 *
 * WHAT IS REAL HERE. The store's OWN lazily-created connection pool
 * (packages/metric-cost-api/src/db.ts's `new Pool({ connectionString })`),
 * opened against a `SUPABASE_DB_URL` carrying a `-c timezone=…` STARTUP
 * option — never a `SET TIME ZONE` issued by this suite after connecting —
 * a real Postgres table, and `readCostSummary`'s real SQL, executed by
 * Postgres.
 *
 * WHAT IS PINNED. Two rows straddle the CURRENT UTC week's true boundary,
 * itself computed by Postgres with the exact expression cinatra#2691
 * installs (timezone-independent by construction — see `trueUtcWeekStart`
 * below): one exactly AT the boundary (must be INCLUDED — `>=` is inclusive)
 * and one one second BEFORE it (must be EXCLUDED under both the buggy and
 * the fixed query — it is the baseline that shows the boundary row is not
 * swept in by some unrelated wide margin). Against the pre-#2691 query,
 * under a session WEST of UTC, the boundary row is wrongly EXCLUDED: the
 * bare `date_trunc('week', ...)` is read in the session's timezone, which
 * pushes the effective boundary LATER than the true UTC instant by the
 * zone's UTC offset — so a row seeded exactly at the true boundary lands
 * before the (later) buggy one and drops out of "This Week" entirely.
 *
 * RUNNER (real DB required — the suite self-skips without one):
 *   SUPABASE_DB_URL=postgres://…@127.0.0.1:5634/postgres SUPABASE_SCHEMA=lane_2691x \
 *     pnpm exec vitest run --config vitest/integration/2691.config.ts
 * The schema is CREATED in beforeAll and DROPPED in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// Fail-closed real-DB fence (same three fences as the cinatra#2578 / #2669
// tiers: an identifier-safe LANE-OWNED name, ownership by creation rather
// than by naming, and a skip on anything unresolvable).
// ---------------------------------------------------------------------------

const RAW_DB_URL = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = (process.env.SUPABASE_SCHEMA ?? "").trim();

const SAFE_LANE_SCHEMA = /^lane_2691[a-z0-9_]*$/;
const SHARED_SCHEMAS = new Set([
  "public",
  "cinatra",
  "information_schema",
  "pg_catalog",
  "pg_toast",
]);
const HAS_REAL_DB =
  RAW_DB_URL !== "" &&
  !isPlaceholderDbUrl(RAW_DB_URL) &&
  SAFE_LANE_SCHEMA.test(SCHEMA) &&
  !SHARED_SCHEMAS.has(SCHEMA.toLowerCase());

/**
 * Set by `vitest/integration/2691.config.ts` and by nothing else. A suite
 * whose only failure mode is "skipped" reports success by doing nothing —
 * this flag turns a missing database from a silent skip into a hard,
 * self-describing failure.
 */
const IN_DEDICATED_LANE = process.env.CINATRA_WEEK_WINDOW_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_REAL_DB) {
  throw new Error(
    "the week-window timezone lane needs a live Postgres and a lane-owned " +
      "schema: set SUPABASE_DB_URL to a real connection and SUPABASE_SCHEMA to " +
      "a name matching /^lane_2691[a-z0-9_]*$/ that does NOT already exist. " +
      "Refusing to skip — a skipped timezone proof proves nothing.",
  );
}

/**
 * A zone WEST of UTC (negative offset, as the AC's own example names). Its
 * wall-clock numbers, misread as UTC by the pre-#2691 comparison, push the
 * buggy boundary LATER — the direction that excludes the AT-boundary row and
 * reds the pre-fix query. Holds for either DST state, so no daylight-saving
 * bookkeeping is needed here.
 */
const NON_UTC_TZ = "America/Los_Angeles";

/**
 * Appends a `-c timezone=…` startup option to the connection string — the
 * SAME `options` mechanism `new Pool({ connectionString })` in
 * packages/metric-cost-api/src/db.ts hands to every physical connection it
 * opens. Built with `URL`/`URLSearchParams` so the value round-trips through
 * whatever encoding `pg-connection-string` expects (it parses via `URL`
 * itself); a hand-escaped query string would be one typo from silently not
 * applying.
 */
function withStartupTimezone(connectionString: string, tz: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c timezone=${tz}`);
  return url.toString();
}

// The store's OWN pool (src/db.ts) is lazily created on its FIRST query, not
// at import — so `SUPABASE_DB_URL` only has to carry the non-UTC option
// before this suite's first `insertUsageEvent` / `readCostSummary` call, not
// before the import below. The dedicated config includes ONLY this file, so
// no earlier suite can create (and memoize) the pool against the plain URL
// first.
if (HAS_REAL_DB) {
  process.env.SUPABASE_DB_URL = withStartupTimezone(RAW_DB_URL, NON_UTC_TZ);
}

// ---------------------------------------------------------------------------
// The REAL module under proof.
// ---------------------------------------------------------------------------
import { db } from "../../../packages/metric-cost-api/src/db";
import { insertUsageEvent, readCostSummary } from "../../../packages/metric-cost-api/src/store";
import { sql } from "drizzle-orm";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

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

let keySeq = 0;
function nextKey(): string {
  return `cinatra-2691-week-${++keySeq}`;
}

/** Seeds a row directly through the store's insert path — no metering seam
 * needed: this tier proves the WINDOW COMPARISON in readCostSummary, which
 * cinatra#2578 / #2669 already proved the capture path feeds honestly. */
function seedRow(occurredAt: Date, costUsd: number): Promise<void> {
  return insertUsageEvent({
    id: randomUUID(),
    occurredAt,
    source: "llm",
    provider: "openai",
    model: "gpt-4o",
    operation: "generate",
    costUsd: costUsd.toFixed(8),
    idempotencyKey: nextKey(),
  });
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#2691 — 'This Week' survives a non-UTC session",
  () => {
    let admin: Client;
    /** Only a schema this process CREATED may be dropped. */
    let createdSchema = false;

    beforeAll(async () => {
      // Schema setup runs on the PLAIN connection — DDL is not timezone
      // sensitive, and keeping it off the non-UTC URL keeps the two
      // connections' jobs visually separate in this file.
      admin = new Client({ connectionString: RAW_DB_URL });
      await admin.connect();

      // Ownership, not naming: CREATE SCHEMA without IF NOT EXISTS throws on
      // an existing schema rather than dropping someone else's data.
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
      createdSchema = true;
      await admin.query(USAGE_EVENTS_DDL.replaceAll("%SCHEMA%", SCHEMA));
      await admin.query(IDEMPOTENCY_INDEX_DDL.replaceAll("%SCHEMA%", SCHEMA));

      // WIRING PRECONDITION. If the `options=-c timezone=…` mutation above
      // did not reach the store's OWN pool — wrong env var, a pool memoized
      // too early, a connection-string encoding the driver did not round-trip
      // — every assertion below fails on a confusing boundary mismatch
      // instead of naming the cause. Ask the pool itself what session
      // timezone it is running under.
      const tzRows = await db.execute(sql`SELECT current_setting('TIMEZONE') AS tz`);
      const actualTz = (tzRows.rows[0] as { tz: string }).tz;
      if (actualTz !== NON_UTC_TZ) {
        throw new Error(
          `the store's pool is running in "${actualTz}", not "${NON_UTC_TZ}" — the ` +
            "connection-string timezone option did not reach it. Every " +
            "assertion below would be meaningless against a UTC session.",
        );
      }
    });

    afterAll(async () => {
      if (admin) {
        if (createdSchema) await admin.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
        await admin.end();
      }
    });

    beforeEach(async () => {
      await admin.query(`TRUNCATE "${SCHEMA}"."usage_events"`);
    });

    it("includes the row seeded exactly at the UTC week boundary and excludes the one just before it", async () => {
      // The TRUE UTC week start, computed by Postgres with the exact
      // expression cinatra#2691 installs. Both `AT TIME ZONE 'UTC'` casts
      // make this timezone-independent — it answers the same absolute
      // instant no matter which session runs it — so `admin` (plain URL) is
      // as good a source of ground truth as any.
      const { rows } = await admin.query<{ week_start: Date }>(
        `SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS week_start`,
      );
      const trueUtcWeekStart = rows[0]!.week_start;

      const BEFORE_COST = 0.11;
      const AT_BOUNDARY_COST = 0.23;

      // Immediately before the boundary — last week by ANY reading of it,
      // buggy or fixed. Establishes that the boundary row is not simply
      // swept in by a wide margin.
      await seedRow(new Date(trueUtcWeekStart.getTime() - 1000), BEFORE_COST);
      // Exactly AT the boundary — `>=` makes this THIS week under the fixed
      // comparison. Under the pre-#2691 bare comparison, a session west of
      // UTC reads the boundary several hours LATER than this instant, so the
      // row falls before it and is wrongly dropped.
      await seedRow(trueUtcWeekStart, AT_BOUNDARY_COST);

      const summary = await readCostSummary();

      expect(summary.eventCount).toBe(2);
      // All-time sees both rows; only the boundary row is "this week".
      expect(summary.totalAllTime).toBeCloseTo(BEFORE_COST + AT_BOUNDARY_COST, 8);
      expect(summary.totalThisWeek).toBeCloseTo(AT_BOUNDARY_COST, 8);
    });
  },
);

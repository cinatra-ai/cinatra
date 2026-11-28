/**
 * Fast (no-DB) unit coverage for the B1c artifact-twin backfill
 * (cinatra#1894 / #2006). The substrate behaviour is proven by the gated
 * real-Postgres kill-test `twin-backfill-substrate.integration.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// A database that answers every scan with no rows: the sweep never reaches a
// real connection.
vi.mock("../store/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDashboardsDb: () => ({ execute: async () => ({ rows: [] }) }),
}));

import * as twinBackfill from "../twin-backfill";

const { backfillDashboardArtifactTwins } = twinBackfill;

describe("backfillDashboardArtifactTwins — unit (no DB)", () => {
  const orig = process.env.SUPABASE_DB_URL;
  afterEach(() => {
    if (orig === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = orig;
  });

  it("no-ops with an empty result when no database is configured (fresh install pre-setup)", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await backfillDashboardArtifactTwins();
    expect(r).toEqual({
      scanned: 0,
      paired: 0,
      alreadyTwinned: 0,
      collisions: 0,
      gone: 0,
      failed: [],
    });
  });

  // cinatra#4849: the twin's object type is passed in by the host, which reads
  // it from the dashboard pack's generated declaration; this package names none.
  it("names no dashboard pack type of its own: the host passes the twin's object type in", () => {
    expect(Object.keys(twinBackfill)).not.toContain("DASHBOARD_TWIN_OBJECT_TYPE");
  });

  it("refuses to sweep when a database is configured but no dashboard object type is passed", async () => {
    process.env.SUPABASE_DB_URL = "postgres://example.invalid/none";
    await expect(backfillDashboardArtifactTwins({ dashboardObjectType: null })).rejects.toThrow(
      /no dashboard object type passed/,
    );
  });
});

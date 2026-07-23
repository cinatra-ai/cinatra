/**
 * Fast (no-DB) unit coverage for the B1c artifact-twin backfill
 * (cinatra#1894 / #2006). The substrate behaviour is proven by the gated
 * real-Postgres kill-test `twin-backfill-substrate.integration.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillDashboardArtifactTwins,
  DASHBOARD_TWIN_OBJECT_TYPE,
} from "../twin-backfill";

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

  it("exposes the dashboard twin object type (mirrors the host DASHBOARD_OBJECT_TYPE)", () => {
    expect(DASHBOARD_TWIN_OBJECT_TYPE).toBe("@cinatra-ai/dashboard-artifact:dashboard");
  });
});

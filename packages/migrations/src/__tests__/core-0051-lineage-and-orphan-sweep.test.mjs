// core__0051 dashboardContribution lineage backfill + durable-absence orphan
// sweep (cinatra#1628, S11a) — SQL-builder shape + idempotency/durable-absence
// guards. Mirrors the core-0029 backfill test idiom (assert the SQL shape without
// a live DB; the integration path is exercised by the upgrade proof).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const mod = await import(
  path.join(
    REPO_ROOT,
    "migrations",
    "core",
    "core__0051_dashboard-contribution-lineage-and-orphan-sweep.mjs",
  )
);

describe("core__0051 — module shape", () => {
  it("exports up/down + the two SQL builders + the retired-package const", () => {
    expect(typeof mod.up).toBe("function");
    expect(typeof mod.down).toBe("function");
    expect(typeof mod.buildLineageBackfillSql).toBe("function");
    expect(typeof mod.buildOrphanSweepSql).toBe("function");
    expect(mod.RETIRED_WORKFLOW_CONTRIBUTION_PACKAGE).toBe("@cinatra-ai/blog-content-workflow");
  });
  it("down() is a NO-OP (irreversible by design; the ledger records the run)", () => {
    expect(() => mod.down()).not.toThrow();
  });
});

describe("core__0051 — lineage backfill", () => {
  const sql = mod.buildLineageBackfillSql();
  it("sets a carrier-independent lineage id derived from extension_id", () => {
    expect(sql).toMatch(/SET contribution_id = 'legacy:' \|\| extension_id/);
  });
  it("only touches extension-owned rows missing a contribution_id (idempotent guard)", () => {
    expect(sql).toMatch(/extension_id IS NOT NULL/);
    expect(sql).toMatch(/contribution_id IS NULL/);
  });
  it("qualifies the table when a schema is given (integration-test path)", () => {
    expect(mod.buildLineageBackfillSql("cinatra_wt")).toMatch(/"cinatra_wt"\."dashboards"/);
  });
});

describe("core__0051 — durable-absence orphan sweep", () => {
  const sql = mod.buildOrphanSweepSql();
  it("archives with a provenance archive_reason", () => {
    expect(sql).toMatch(/SET status = 'archived'/);
    expect(sql).toMatch(/archive_reason = 'orphaned_contribution_sweep'/);
    expect(sql).toMatch(/archived_at = now\(\)/);
  });
  it("targets only extension-owned, not-already-archived rows (idempotent)", () => {
    expect(sql).toMatch(/d\.extension_id IS NOT NULL/);
    expect(sql).toMatch(/d\.status <> 'archived'/);
  });
  it("gates on DURABLE ABSENCE — no installed_extension row for the package", () => {
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/installed_extension ie WHERE ie\.package_name = d\.extension_id/);
  });
  it("qualifies BOTH tables when a schema is given", () => {
    const q = mod.buildOrphanSweepSql("cinatra_wt");
    expect(q).toMatch(/"cinatra_wt"\."dashboards"/);
    expect(q).toMatch(/"cinatra_wt"\."installed_extension"/);
  });
});

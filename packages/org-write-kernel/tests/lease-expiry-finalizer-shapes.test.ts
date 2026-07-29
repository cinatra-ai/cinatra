/**
 * cinatra#1940 P4 — the lease-expiry finalizer's kernel SQL
 * shapes: the bounded sweep read, the atomic conditional attempts-increment,
 * the idempotent escalation stamp, and the in-fence FOR UPDATE re-verify. No
 * live DB: we assert the emitted SQL shape, parameter order, and schema
 * safety — the same discipline as leases-settle.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  sweepExpiredLeasesQuery,
  incrementLeaseFinalizeAttemptsQuery,
  escalateLeaseFinalizeQuery,
  leaseStillExpiredQuery,
  expiredLeaseForUpdateStatement,
  ORG_ARCHIVE_LEASE_TABLE,
} from "../src/index";

function sqlText(query: unknown): string {
  return JSON.stringify(query)?.replaceAll('\\"', '"') ?? "";
}

const KEY = { schema: "cinatra", orgId: "org-1", archiveEpoch: 2, runId: "run-9" };

describe("sweepExpiredLeasesQuery", () => {
  it("is a bounded, oldest-first read LEFT JOINing agent_runs, schema-qualified", () => {
    const q = sweepExpiredLeasesQuery({ schema: "cinatra", limit: 50 });
    expect(q.text).toContain(`"cinatra"."${ORG_ARCHIVE_LEASE_TABLE}" l`);
    // LEFT JOIN (not INNER JOIN): an orphaned lease
    // whose run row was deleted must still surface so finalizeExpiredLeaseRun's
    // settle-orphan (lease-only delete) path is actually reachable from the
    // sweep, instead of being silently dropped by an inner join.
    expect(q.text).toContain(`LEFT JOIN "cinatra".agent_runs r ON r.id = l.run_id`);
    expect(q.text).toContain("l.expires_at <= now()");
    expect(q.text).toContain("ORDER BY l.expires_at ASC");
    expect(q.text).toContain("LIMIT $1");
    expect(q.text).toContain("l.finalize_attempts");
    expect(q.text).toContain("r.a2a_task_id");
    expect(q.text).toContain("r.template_id");
    expect(q.values).toEqual([50]);
  });

  it("rejects an unsafe schema name (fail-closed)", () => {
    expect(() => sweepExpiredLeasesQuery({ schema: "bad; DROP", limit: 10 })).toThrow(
      /unsafe schema name/,
    );
  });
});

describe("incrementLeaseFinalizeAttemptsQuery", () => {
  it("is a single atomic conditional UPDATE re-verifying expiry, RETURNING the new count", () => {
    const q = incrementLeaseFinalizeAttemptsQuery(KEY);
    expect(q.text).toBe(
      `UPDATE "cinatra"."${ORG_ARCHIVE_LEASE_TABLE}"` +
        ` SET finalize_attempts = finalize_attempts + 1, finalize_last_attempt_at = now()` +
        ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3 AND expires_at <= now()` +
        ` RETURNING finalize_attempts`,
    );
    expect(q.values).toEqual(["org-1", 2, "run-9"]);
  });

  it("rejects an unsafe schema name (fail-closed)", () => {
    expect(() =>
      incrementLeaseFinalizeAttemptsQuery({ ...KEY, schema: 'evil"; DROP TABLE x' }),
    ).toThrow(/unsafe schema name/);
  });
});

describe("escalateLeaseFinalizeQuery", () => {
  it("is an idempotent stamp guarded by IS NULL, RETURNING the stamped value", () => {
    const q = escalateLeaseFinalizeQuery(KEY);
    expect(q.text).toBe(
      `UPDATE "cinatra"."${ORG_ARCHIVE_LEASE_TABLE}"` +
        ` SET finalize_escalated_at = now()` +
        ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3 AND finalize_escalated_at IS NULL` +
        ` RETURNING finalize_escalated_at`,
    );
    expect(q.values).toEqual(["org-1", 2, "run-9"]);
  });

  it("rejects an unsafe schema name (fail-closed)", () => {
    expect(() => escalateLeaseFinalizeQuery({ ...KEY, schema: "bad; DROP" })).toThrow(
      /unsafe schema name/,
    );
  });
});

describe("leaseStillExpiredQuery", () => {
  it("is a read-only EXISTS-style check at the exact (org, epoch, run), still expired", () => {
    const q = leaseStillExpiredQuery(KEY);
    expect(q.text).toBe(
      `SELECT 1 FROM "cinatra"."${ORG_ARCHIVE_LEASE_TABLE}"` +
        ` WHERE org_id = $1 AND archive_epoch = $2 AND run_id = $3 AND expires_at <= now()`,
    );
    expect(q.values).toEqual(["org-1", 2, "run-9"]);
  });

  it("rejects an unsafe schema name (fail-closed)", () => {
    expect(() => leaseStillExpiredQuery({ ...KEY, schema: "bad; DROP" })).toThrow(
      /unsafe schema name/,
    );
  });
});

describe("expiredLeaseForUpdateStatement", () => {
  it("locks the exact lease row FOR UPDATE at the given (org, epoch, run)", () => {
    const text = sqlText(expiredLeaseForUpdateStatement(KEY));
    expect(text).toContain("SELECT run_id, execution_attempt_id FROM");
    expect(text).toContain(ORG_ARCHIVE_LEASE_TABLE);
    expect(text).toContain("org_id");
    expect(text).toContain("archive_epoch");
    expect(text).toContain("run_id");
    expect(text).toContain("expires_at <= now()");
    expect(text).toContain("FOR UPDATE");
  });

  it("rejects an unsafe schema name (fail-closed)", () => {
    expect(() =>
      expiredLeaseForUpdateStatement({ ...KEY, schema: 'evil"; DROP TABLE x' }),
    ).toThrow(/unsafe schema name/);
  });
});

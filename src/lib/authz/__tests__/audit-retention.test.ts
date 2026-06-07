/**
 * Audit retention.
 *
 * The DB delete is mocked; we assert the cutoff math, clamping, dry-run, and
 * the configured-window override.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB layer so enforceAuditRetention doesn't open a pool.
const deleteReturning = vi.fn();
const whereMock = vi.fn(() => ({ returning: deleteReturning }));
const deleteMock = vi.fn(() => ({ where: whereMock }));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => ({ delete: deleteMock, insert: () => ({ values: () => ({ returning: () => [] }) }) }),
}));
vi.mock("pg", () => ({ Pool: class { on() {} listenerCount() { return 1; } } }));

import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  enforceAuditRetention,
  setAuditRetentionDays,
} from "../audit";

describe("audit retention", () => {
  beforeEach(() => {
    deleteReturning.mockReset();
    whereMock.mockClear();
    deleteMock.mockClear();
    deleteReturning.mockReturnValue([{ id: "a" }, { id: "b" }]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("defaults to a 12-month window", () => {
    expect(DEFAULT_AUDIT_RETENTION_DAYS).toBe(365);
  });

  it("dry-run reports the cutoff without deleting", async () => {
    const r = await enforceAuditRetention({ dryRun: true, retentionDays: 90 });
    expect(r.retentionDays).toBe(90);
    expect(r.deleted).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
    // cutoff ~90 days ago
    const ageDays = (Date.now() - new Date(r.cutoffIso).getTime()) / 86_400_000;
    expect(Math.round(ageDays)).toBe(90);
  });

  it("deletes events older than the cutoff and returns the count", async () => {
    const r = await enforceAuditRetention({ retentionDays: 30 });
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(r.deleted).toBe(2);
    expect(r.retentionDays).toBe(30);
  });

  it("clamps a sub-minimum window up to MIN_AUDIT_RETENTION_DAYS", async () => {
    const r = await enforceAuditRetention({ retentionDays: 1, dryRun: true });
    expect(r.retentionDays).toBe(MIN_AUDIT_RETENTION_DAYS);
  });

  it("setAuditRetentionDays rejects a sub-minimum value (cannot wipe recent history)", async () => {
    await expect(setAuditRetentionDays(1)).rejects.toThrow(/>= 7/);
  });
});

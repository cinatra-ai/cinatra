// cinatra#2908 — the expired-lineage sweep actually RIDES the daily retention
// pass. The DB-backed suite in @cinatra-ai/agents proves what the statement does
// to rows; this proves the periodic pass is the thing that runs it, which is the
// half a store-level test cannot see:
//
//   - AUDIT_RETENTION_ENFORCE's cycle calls the registered lineage runner, and
//     calls it AFTER the audit half so a lineage failure cannot cost a sweep
//     that already succeeded;
//   - an empty slot (boot registered nothing) skips the lineage half LOUDLY and
//     leaves the audit half untouched — a skipped cycle is safe, the same rows
//     are still expired tomorrow;
//   - a throwing runner does not kill the loop: runRecurringLoop reports it and
//     the handler still resolves.
//
// `enforceAuditRetention` is mocked because the audit half owns a real pg pool
// and this test is about the wiring, not about audit rows.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Job } from "bullmq";

vi.mock("server-only", () => ({}));

const enforceAuditRetention = vi.fn(async () => ({
  cutoffIso: "2020-01-01T00:00:00.000Z",
  retentionDays: 365,
  deleted: 0,
}));
vi.mock("@/lib/authz/audit", () => ({ enforceAuditRetention }));

import {
  BACKGROUND_JOB_REGISTRY,
  registerTriggerScheduleLineageRetentionRunner,
} from "@/lib/background-jobs-registry";
import { BACKGROUND_JOB_NAMES } from "@/lib/background-jobs-names";

/**
 * A job whose id is NOT the canonical loop id: `runRecurringLoop` then runs the
 * cycle ONCE and returns instead of re-delaying, which is exactly one cycle with
 * no BullMQ machinery to stand up.
 */
const ONE_CYCLE = {
  id: "not-the-canonical-loop-id",
  name: BACKGROUND_JOB_NAMES.AUDIT_RETENTION_ENFORCE,
  queueName: "background-jobs",
  data: {},
} as unknown as Job;

async function runOneCycle(): Promise<void> {
  await BACKGROUND_JOB_REGISTRY[BACKGROUND_JOB_NAMES.AUDIT_RETENTION_ENFORCE].handle(
    ONE_CYCLE,
    String(ONE_CYCLE.id),
  );
}

function clearSlot(): void {
  delete (globalThis as { __cinatraTriggerScheduleLineageRetentionRunner?: unknown })
    .__cinatraTriggerScheduleLineageRetentionRunner;
}

beforeEach(() => {
  clearSlot();
  enforceAuditRetention.mockClear();
});

afterEach(() => {
  clearSlot();
  vi.restoreAllMocks();
});

describe("audit-retention-enforce sweeps expired schedule-proposal lineage rows", () => {
  it("calls the registered lineage runner once per cycle, after the audit half", async () => {
    const order: string[] = [];
    enforceAuditRetention.mockImplementation(async () => {
      order.push("audit");
      return { cutoffIso: "2020-01-01T00:00:00.000Z", retentionDays: 365, deleted: 3 };
    });
    const sweep = vi.fn(async () => {
      order.push("lineage");
      return { deleted: 2, limit: 500, more: false };
    });
    registerTriggerScheduleLineageRetentionRunner({ sweep });

    await runOneCycle();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["audit", "lineage"]);
  });

  it("skips the lineage half loudly when the slot is empty, and still runs the audit half", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runOneCycle();

    expect(enforceAuditRetention).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[schedule-proposal-lineage-retention] runner slot empty"),
    );
  });

  it("survives a throwing runner — the loop reports and does not die", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sweep = vi.fn(async () => {
      throw new Error("lineage sweep exploded");
    });
    registerTriggerScheduleLineageRetentionRunner({ sweep });

    await expect(runOneCycle()).resolves.toBeUndefined();

    expect(enforceAuditRetention).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

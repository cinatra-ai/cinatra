import { describe, expect, it, vi } from "vitest";

import {
  runVendorApplicationStateReconcile,
  type ReconcileDeps,
  type VendorApplicationCompleteRecoveryResult,
} from "../reconcile-worker";

function makeDeps(
  resultsByApplicationId: Record<string, VendorApplicationCompleteRecoveryResult>,
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  const ids = Object.keys(resultsByApplicationId);
  return {
    client: {
      vendorApplicationCompleteRecovery: vi.fn(async ({ application_id }) => {
        const r = resultsByApplicationId[application_id];
        if (!r) throw new Error(`no fixture for ${application_id}`);
        return r;
      }),
    },
    getStuckApplications: async () => ids.map((application_id) => ({ application_id })),
    ...overrides,
  };
}

describe("runVendorApplicationStateReconcile — result classification", () => {
  it("counts state=approved as recovered", async () => {
    const deps = makeDeps({
      a: { state: "approved", application_id: "a", completed_at: "2026-05-27T00:00:00Z" },
    });
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ attempted: 1, recovered: 1, failed: 0, stuck: 0, skipped: 0 });
  });

  it("counts already_approved (idempotent re-run) as recovered", async () => {
    const deps = makeDeps({
      a: { state: "approved", application_id: "a", already_approved: true, completed_at: "x" },
    });
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ recovered: 1, failed: 0, stuck: 0, skipped: 0 });
  });

  it("counts state=stuck as stuck and fires onStuck with repair_stuck_at", async () => {
    const onStuck = vi.fn();
    const deps = makeDeps(
      {
        a: { state: "stuck", application_id: "a", recovery_attempts: 6, repair_stuck_at: "2026-05-27T01:00:00Z" },
      },
      { onStuck },
    );
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ stuck: 1, recovered: 0, failed: 0, skipped: 0 });
    expect(onStuck).toHaveBeenCalledExactlyOnceWith("a", "2026-05-27T01:00:00Z");
  });

  it("counts applied+retriable as failed (retry next cycle)", async () => {
    const deps = makeDeps({
      a: { state: "applied", application_id: "a", recovery_attempts: 2, retriable: true },
    });
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ failed: 1, recovered: 0, stuck: 0, skipped: 0 });
  });

  it("counts applied+recovery_not_applicable as skipped (benign, not a failure)", async () => {
    const deps = makeDeps({
      a: {
        state: "applied",
        application_id: "a",
        recovery_attempts: 0,
        recovery_not_applicable: true,
      },
    });
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ skipped: 1, failed: 0, recovered: 0, stuck: 0 });
  });

  it("classifies a mixed batch correctly", async () => {
    const onStuck = vi.fn();
    const deps = makeDeps(
      {
        ok: { state: "approved", application_id: "ok", completed_at: "x" },
        dead: { state: "stuck", application_id: "dead", recovery_attempts: 6, repair_stuck_at: "ts" },
        later: { state: "applied", application_id: "later", recovery_attempts: 1, retriable: true },
        none: {
          state: "applied",
          application_id: "none",
          recovery_attempts: 0,
          recovery_not_applicable: true,
        },
      },
      { onStuck },
    );
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({
      attempted: 4,
      recovered: 1,
      stuck: 1,
      failed: 1,
      skipped: 1,
    });
    expect(onStuck).toHaveBeenCalledOnce();
  });

  it("counts a thrown client call as failed without aborting the batch", async () => {
    const deps: ReconcileDeps = {
      client: {
        vendorApplicationCompleteRecovery: vi
          .fn()
          .mockRejectedValueOnce(new Error("network blip"))
          .mockResolvedValueOnce({ state: "approved", application_id: "b", completed_at: "x" }),
      },
      getStuckApplications: async () => [{ application_id: "a" }, { application_id: "b" }],
    };
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ attempted: 2, failed: 1, recovered: 1 });
  });

  it("does not throw when onStuck itself throws", async () => {
    const deps = makeDeps(
      { a: { state: "stuck", application_id: "a", recovery_attempts: 6, repair_stuck_at: "ts" } },
      {
        onStuck: vi.fn(() => {
          throw new Error("write failed");
        }),
      },
    );
    const summary = await runVendorApplicationStateReconcile(deps);
    expect(summary).toMatchObject({ stuck: 1 });
  });
});

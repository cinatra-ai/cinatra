import { describe, expect, it } from "vitest";

import {
  approvalStatusToPill,
  connectionStatusToPill,
  lifecycleStatusToPill,
  runStatusToPill,
  statusToPill,
  type ApprovalStatus,
  type ConnectionStatus,
  type LifecycleStatus,
  type RunStatus,
} from "@/lib/status-adapter";
import type { StatusPillStatus } from "@/components/ui/status-pill";

// Every domain enum value must map to a known StatusPillStatus.
// The list of canonical pill statuses lives in status-pill.tsx; this test asserts
// the adapter's coverage AND that every output is one of the 10 canonical states.

const CANONICAL: ReadonlySet<StatusPillStatus> = new Set<StatusPillStatus>([
  "running",
  "approved",
  "hold",
  "needs-review",
  "scheduled",
  "queued",
  "idle",
  "archived",
  "failed",
  "declined",
]);

describe("status-adapter — every domain enum value maps to a canonical StatusPillStatus", () => {
  it("runStatusToPill covers every RunStatus value", () => {
    const all: RunStatus[] = [
      "idle",
      "running",
      "succeeded",
      "completed",
      "failed",
      "stopped",
      "cancelled",
      "queued",
      "scheduled",
      "paused",
    ];
    for (const s of all) {
      const pill = runStatusToPill(s);
      expect(CANONICAL.has(pill)).toBe(true);
    }
  });

  it("runStatusToPill assigns running → running, succeeded/completed → approved", () => {
    expect(runStatusToPill("running")).toBe("running");
    expect(runStatusToPill("succeeded")).toBe("approved");
    expect(runStatusToPill("completed")).toBe("approved");
  });

  it("runStatusToPill assigns failed/cancelled → failed (red), stopped → archived", () => {
    expect(runStatusToPill("failed")).toBe("failed");
    expect(runStatusToPill("cancelled")).toBe("failed");
    expect(runStatusToPill("stopped")).toBe("archived");
  });

  it("approvalStatusToPill covers every ApprovalStatus value", () => {
    const all: ApprovalStatus[] = [
      "pending",
      "needs-review",
      "approved",
      "rejected",
      "declined",
      "expired",
    ];
    for (const s of all) {
      const pill = approvalStatusToPill(s);
      expect(CANONICAL.has(pill)).toBe(true);
    }
  });

  it("approvalStatusToPill assigns pending/needs-review → needs-review (mustard)", () => {
    expect(approvalStatusToPill("pending")).toBe("needs-review");
    expect(approvalStatusToPill("needs-review")).toBe("needs-review");
  });

  it("approvalStatusToPill distinguishes declined from rejected, both → declined", () => {
    expect(approvalStatusToPill("declined")).toBe("declined");
    expect(approvalStatusToPill("rejected")).toBe("declined");
  });

  it("lifecycleStatusToPill covers every LifecycleStatus value", () => {
    const all: LifecycleStatus[] = ["active", "archived"];
    for (const s of all) {
      const pill = lifecycleStatusToPill(s);
      expect(CANONICAL.has(pill)).toBe(true);
    }
    expect(lifecycleStatusToPill("active")).toBe("approved");
    expect(lifecycleStatusToPill("archived")).toBe("archived");
  });

  it("connectionStatusToPill covers every ConnectionStatus value", () => {
    const all: ConnectionStatus[] = [
      "connected",
      "disconnected",
      "configuring",
      "expired",
      "error",
    ];
    for (const s of all) {
      const pill = connectionStatusToPill(s);
      expect(CANONICAL.has(pill)).toBe(true);
    }
    expect(connectionStatusToPill("connected")).toBe("approved");
    expect(connectionStatusToPill("configuring")).toBe("running");
    expect(connectionStatusToPill("disconnected")).toBe("idle");
    expect(connectionStatusToPill("error")).toBe("failed");
    expect(connectionStatusToPill("expired")).toBe("failed");
  });

  it("statusToPill is the identity for canonical pill statuses", () => {
    for (const s of CANONICAL) {
      expect(statusToPill(s)).toBe(s);
    }
  });
});

describe("status-adapter — running status invariant (running = indigo, not red)", () => {
  it("never maps run 'running' to 'failed'", () => {
    expect(runStatusToPill("running")).not.toBe("failed");
    expect(runStatusToPill("running")).not.toBe("declined");
  });

  it("never maps approval 'approved' to 'failed'", () => {
    expect(approvalStatusToPill("approved")).not.toBe("failed");
  });
});

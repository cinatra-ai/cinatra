/**
 * A SPENT GATE STATUS GIVES WAY TO THE ROW'S RUNNING, AND ONLY TO IT
 * (cinatra#3739, on the run page of cinatra#3007).
 *
 * The checklist sentence the first arm pins: "the run detail draws the run
 * progress placeholder while the run works after the context gate's Continue".
 * The drawing's own sentence: "While the run works, the detail carries a
 * placeholder. A run that will ask for a review carries, in the run detail, the
 * run progress card".
 *
 * After the context gate's Continue, the stream's RESUME retires the interrupt
 * and moves no status, so the stream's last word stays the INTERRUPT's
 * `pending_approval` while the row already reads `running`. With no interrupt on
 * file that word is spent, and the row's `running` is the reading the run
 * detail draws.
 *
 * The other arms pin what must not move: "a question or gate whose interrupt is
 * still on file keeps its pending_approval reading and never draws the
 * placeholder" — and an absent input is read as on file, so the one caller that
 * passes none resolves exactly as it did.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/run-surface-status.spent-gate-status.test.ts
 */
import { describe, expect, it } from "vitest";

import { resolveRunSurfaceStatus } from "../run-surface-status";

const spent = {
  streamEnabled: true,
  streamedStatus: "pending_approval" as string | null,
  polledStatus: "pending_approval",
  rowStatus: "running" as string | null,
};

describe("resolveRunSurfaceStatus — a spent gate status after its interrupt is retired", () => {
  it("(1) a stream pending_approval with no interrupt on file gives way to the row's running", () => {
    expect(resolveRunSurfaceStatus({ ...spent, interruptOnFile: false })).toBe("running");
  });

  it("(2) with an interrupt on file the stream's pending_approval keeps its say", () => {
    expect(resolveRunSurfaceStatus({ ...spent, interruptOnFile: true })).toBe(
      "pending_approval",
    );
  });

  it("(3) with the input absent it is read as on file, and pending_approval stands", () => {
    expect(resolveRunSurfaceStatus({ ...spent })).toBe("pending_approval");
  });

  it("(4) only the row's running overrules: a row reading queued leaves pending_approval", () => {
    expect(
      resolveRunSurfaceStatus({ ...spent, rowStatus: "queued", interruptOnFile: false }),
    ).toBe("pending_approval");
  });

  it("(5) a stream that said completed keeps its word against a running row", () => {
    expect(
      resolveRunSurfaceStatus({
        ...spent,
        streamedStatus: "completed",
        polledStatus: "completed",
        interruptOnFile: false,
      }),
    ).toBe("completed");
  });
});

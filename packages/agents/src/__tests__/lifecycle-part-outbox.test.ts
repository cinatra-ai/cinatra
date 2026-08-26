// THE RUN OUTBOX'S PRODUCER (cinatra#2930, epic #2926 W3).
//
// The plan: "In a conversation the platform itself writes the card into the
// run's own turn, from an outbox the coordinator feeds when a moment opens — a
// durable part with its provenance and its place in the turn".
//
// This is the producer half — the seam, the provenance vocabulary and the one
// rule about WHICH moments feed it. The writing half is the host's and is
// proved in src/lib/lifecycle/__tests__/lifecycle-run-outbox.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_PART_PROVENANCE,
  LIFECYCLE_PLATFORM_PRODUCER_ACT,
  LIFECYCLE_PLATFORM_PRODUCER_LABEL,
  emitLifecycleMomentOpened,
  getLifecyclePartOutbox,
  isLifecyclePartProvenance,
  momentFeedsRunOutbox,
  setLifecyclePartOutbox,
  LIFECYCLE_OUTBOX_BUDGET_MS,
  type LifecycleMomentOpened,
} from "../lifecycle-part-outbox";

const ENTRY: LifecycleMomentOpened = {
  runId: "run-1",
  orgId: "org-1",
  moment: "review",
  cardKind: "artifact_review_gate",
  cardRef: "gate-ref-1",
};

afterEach(() => {
  setLifecyclePartOutbox(null);
  vi.restoreAllMocks();
});

describe("which moments feed the run outbox", () => {
  it("feeds every RUN-CARRIED moment", () => {
    expect(momentFeedsRunOutbox("recommendation")).toBe(true);
    expect(momentFeedsRunOutbox("hitl")).toBe(true);
    expect(momentFeedsRunOutbox("review")).toBe(true);
    // The audit does not park the run and still has a card — a reading the
    // person is owed just as much as a decision.
    expect(momentFeedsRunOutbox("audit")).toBe(true);
  });

  it("feeds the SCHEDULE moment, which only a run can reach", () => {
    // A schedule moment that gets this far ALWAYS has a run: the coordinator's
    // other carrier — a schedule stated in a conversation and held — never
    // reaches the outbox, because there is no run to carry it. "it never enters
    // the run outbox, because there is no run."
    expect(momentFeedsRunOutbox("schedule")).toBe(true);
  });
});

describe("the provenance vocabulary", () => {
  it("names the two deliveries and refuses anything else", () => {
    expect([...LIFECYCLE_PART_PROVENANCE]).toEqual([
      "platform_injected",
      "tool_represented",
    ]);
    expect(isLifecyclePartProvenance("platform_injected")).toBe(true);
    expect(isLifecyclePartProvenance("tool_represented")).toBe(true);
    expect(isLifecyclePartProvenance("model_decided")).toBe(false);
    expect(isLifecyclePartProvenance(undefined)).toBe(false);
  });

  it("gives the platform an identity no MCP server can present", () => {
    // The injection boundary refuses a server label carrying a colon, so this
    // tuple is unreachable from the tool surface the threat comes from.
    expect(LIFECYCLE_PLATFORM_PRODUCER_LABEL).toContain(":");
    expect(LIFECYCLE_PLATFORM_PRODUCER_ACT).toBe("lifecycle_moment_opened");
  });
});

describe("the seam", () => {
  it("hands the moment to the wired writer", async () => {
    const onMomentOpened = vi.fn().mockResolvedValue(undefined);
    setLifecyclePartOutbox({ onMomentOpened });
    expect(getLifecyclePartOutbox()).not.toBeNull();
    await emitLifecycleMomentOpened(ENTRY);
    expect(onMomentOpened).toHaveBeenCalledTimes(1);
    expect(onMomentOpened).toHaveBeenCalledWith(ENTRY);
  });

  it("does nothing at all when no host wired one", async () => {
    setLifecyclePartOutbox(null);
    await expect(emitLifecycleMomentOpened(ENTRY)).resolves.toBeUndefined();
  });

  it("SWALLOWS a writer that throws — a lifecycle record never fails a run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLifecyclePartOutbox({
      onMomentOpened: async () => {
        throw new Error("the store is down");
      },
    });
    await expect(emitLifecycleMomentOpened(ENTRY)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("never interpolates the run id into the log format string", async () => {
    // CodeQL js/tainted-format-string: a request-influenced id is an ARGUMENT.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLifecyclePartOutbox({
      onMomentOpened: async () => {
        throw new Error("boom");
      },
    });
    await emitLifecycleMomentOpened({ ...ENTRY, runId: "%s-injected" });
    const [first] = warn.mock.calls[0] ?? [];
    expect(String(first)).not.toContain("%s-injected");
  });
});

describe("the coordinator's wait on the outbox is BOUNDED", () => {
  it("goes on when the writer never settles, and says so", async () => {
    // a convergence review, finding 8. The writer is host-injected, so "how long can it
    // take" is not knowable from here — and this call sits inside a run. An
    // unbounded await would let a slow store stall the run itself.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setLifecyclePartOutbox({ onMomentOpened: () => new Promise<void>(() => {}) });
      const settled = emitLifecycleMomentOpened(ENTRY);
      let done = false;
      void settled.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(LIFECYCLE_OUTBOX_BUDGET_MS + 1);
      await settled;
      expect(done).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait out the budget when the writer answers at once", async () => {
    vi.useFakeTimers();
    try {
      setLifecyclePartOutbox({ onMomentOpened: async () => undefined });
      await expect(emitLifecycleMomentOpened(ENTRY)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

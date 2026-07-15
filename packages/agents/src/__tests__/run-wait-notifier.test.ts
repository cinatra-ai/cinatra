// cinatra #1559 / notifications epic E9 — run human-wait notifier seam.
//
// PURE: drives the transition classifier + the best-effort dispatch + the
// module-singleton port. No DB, no notifications host, no React. This pins the
// "which run status transition is a human-wait gate" contract — one assertion
// per wait reason (the AC's "Tests for each wait reason").
//
// Importing `../run-wait-notifier` does NOT pull the store/db runtime graph:
// its only `./store` import is `import type { AgentRunStatus }` (erased at
// compile). So this suite stays a fast pure unit test.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyRunWaitTransition,
  dispatchRunWaitTransition,
  getRunWaitNotifier,
  setRunWaitNotifier,
  type RunWaitNotifier,
} from "../run-wait-notifier";

afterEach(() => {
  setRunWaitNotifier(null);
  vi.restoreAllMocks();
});

describe("classifyRunWaitTransition — enter (human gate)", () => {
  it("classifies queued→pending_approval as enter (setup-interrupt gate)", () => {
    expect(classifyRunWaitTransition("queued", "pending_approval", false)).toEqual({
      kind: "enter",
      reason: "pending_approval",
    });
  });

  it("classifies running→pending_approval as enter (mid-run interrupt)", () => {
    expect(classifyRunWaitTransition("running", "pending_approval", false)).toEqual({
      kind: "enter",
      reason: "pending_approval",
    });
  });

  it("classifies queued→pending_input as enter ONLY when flagged (stop-run-hitl #1058)", () => {
    expect(classifyRunWaitTransition("queued", "pending_input", true)).toEqual({
      kind: "enter",
      reason: "pending_input",
    });
  });
});

describe("classifyRunWaitTransition — overloaded pending_input reasons do NOT enter", () => {
  it("does NOT enter on queued→pending_input without the flag (enqueue-compensation revert)", () => {
    expect(classifyRunWaitTransition("queued", "pending_input", false)).toEqual({
      kind: "none",
    });
  });

  it("does NOT enter on failed→pending_input (user-driven reset to setup)", () => {
    // from is not a wait state → NONE, not LEAVE.
    expect(classifyRunWaitTransition("failed", "pending_input", false)).toEqual({
      kind: "none",
    });
  });

  it("does NOT enter on armed→pending_input (trigger editing — remove trigger)", () => {
    expect(classifyRunWaitTransition("armed", "pending_input", false)).toEqual({
      kind: "none",
    });
  });

  it("does NOT enter on pending_trigger→pending_input (trigger form abandoned)", () => {
    expect(
      classifyRunWaitTransition("pending_trigger", "pending_input", false),
    ).toEqual({ kind: "none" });
  });
});

describe("classifyRunWaitTransition — leave (wait resolved)", () => {
  it.each([
    ["pending_approval", "running"], // resume
    ["pending_approval", "completed"], // WayFlow resume terminal-success
    ["pending_approval", "failed"], // reject
    ["pending_approval", "stopped"], // user stop
    ["pending_input", "queued"], // stop-run-hitl resume (installs deps, retries)
    ["pending_input", "stopped"], // user stop during the wait
    ["pending_input", "failed"], // reject from setup path
  ] as const)("classifies %s→%s as leave (idempotent clear)", (from, to) => {
    expect(classifyRunWaitTransition(from, to, false)).toEqual({ kind: "leave" });
  });
});

describe("classifyRunWaitTransition — ordinary transitions are none", () => {
  it.each([
    ["queued", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["queued", "failed"],
    ["armed", "queued"],
    ["pending_trigger", "armed"],
  ] as const)("classifies %s→%s as none", (from, to) => {
    expect(classifyRunWaitTransition(from, to, false)).toEqual({ kind: "none" });
  });
});

describe("setRunWaitNotifier / getRunWaitNotifier — module singleton", () => {
  it("returns null by default (no host wired)", () => {
    expect(getRunWaitNotifier()).toBeNull();
  });

  it("stores + clears the injected notifier", () => {
    const notifier: RunWaitNotifier = {
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
    };
    setRunWaitNotifier(notifier);
    expect(getRunWaitNotifier()).toBe(notifier);
    setRunWaitNotifier(null);
    expect(getRunWaitNotifier()).toBeNull();
  });
});

describe("dispatchRunWaitTransition — drives the wired notifier", () => {
  it("calls onEnterHumanWait with the reason on a gate enter", async () => {
    const notifier: RunWaitNotifier = {
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
    };
    setRunWaitNotifier(notifier);
    await dispatchRunWaitTransition({
      runId: "R1",
      from: "running",
      to: "pending_approval",
      humanWaitGate: false,
    });
    expect(notifier.onEnterHumanWait).toHaveBeenCalledWith({
      runId: "R1",
      reason: "pending_approval",
    });
    expect(notifier.onLeaveHumanWait).not.toHaveBeenCalled();
  });

  it("calls onLeaveHumanWait on a gate leave", async () => {
    const notifier: RunWaitNotifier = {
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
    };
    setRunWaitNotifier(notifier);
    await dispatchRunWaitTransition({
      runId: "R1",
      from: "pending_approval",
      to: "running",
      humanWaitGate: false,
    });
    expect(notifier.onLeaveHumanWait).toHaveBeenCalledWith({ runId: "R1" });
    expect(notifier.onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("is a no-op for an ordinary transition", async () => {
    const notifier: RunWaitNotifier = {
      onEnterHumanWait: vi.fn(),
      onLeaveHumanWait: vi.fn(),
    };
    setRunWaitNotifier(notifier);
    await dispatchRunWaitTransition({
      runId: "R1",
      from: "queued",
      to: "running",
      humanWaitGate: false,
    });
    expect(notifier.onEnterHumanWait).not.toHaveBeenCalled();
    expect(notifier.onLeaveHumanWait).not.toHaveBeenCalled();
  });

  it("is a no-op when no host wired a notifier", async () => {
    await expect(
      dispatchRunWaitTransition({
        runId: "R1",
        from: "running",
        to: "pending_approval",
        humanWaitGate: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a throwing notifier so a status transition can never fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setRunWaitNotifier({
      onEnterHumanWait: () => {
        throw new Error("boom");
      },
      onLeaveHumanWait: vi.fn(),
    });
    await expect(
      dispatchRunWaitTransition({
        runId: "R1",
        from: "queued",
        to: "pending_approval",
        humanWaitGate: false,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

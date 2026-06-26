import { describe, expect, it, vi } from "vitest";

import {
  handleFatalFault,
  installFatalErrorHandlers,
  isRecoverableFatalFault,
  type InstallFatalDeps,
} from "@/lib/boot/fatal-error-policy";

// ---------------------------------------------------------------------------
// Production fatal-error policy contract (engineering #302).
//
// The deliberate behavioral change: a truly-uncaught production fault must log,
// flush telemetry, and EXIT NON-ZERO so the orchestrator restarts a clean
// process — UNLESS it is an explicitly classified recoverable transient infra
// fault, which keeps the process alive. Development always keeps running.
// These tests pin the recoverable set + the prod-exit / dev-keep-alive split.
// ---------------------------------------------------------------------------

function devDeps(overrides: Partial<InstallFatalDeps> = {}): InstallFatalDeps {
  return {
    getMode: () => "development",
    logError: vi.fn(),
    exit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function prodDeps(overrides: Partial<InstallFatalDeps> = {}): InstallFatalDeps {
  return {
    getMode: () => "production",
    logError: vi.fn(),
    exit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("isRecoverableFatalFault", () => {
  it.each(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])(
    "classifies transient connection error code %s as recoverable",
    (code) => {
      expect(isRecoverableFatalFault(Object.assign(new Error("boom"), { code }))).toBe(true);
    },
  );

  it("treats a programming error (no transient code) as NON-recoverable", () => {
    expect(isRecoverableFatalFault(new TypeError("x is not a function"))).toBe(false);
  });

  it("treats a plain string / unknown reason as NON-recoverable", () => {
    expect(isRecoverableFatalFault("some rejection")).toBe(false);
    expect(isRecoverableFatalFault(undefined)).toBe(false);
    expect(isRecoverableFatalFault({ code: 500 })).toBe(false); // non-string code
  });
});

describe("handleFatalFault — development", () => {
  it("keeps the process alive and never exits (uncaughtException)", async () => {
    const deps = devDeps();
    const decision = await handleFatalFault("uncaughtException", new Error("typo"), deps);
    expect(decision).toBe("dev-keep-alive");
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.flush).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalled();
  });

  it("keeps alive even for a normally-fatal programming fault", async () => {
    const deps = devDeps();
    const decision = await handleFatalFault("unhandledRejection", new TypeError("nope"), deps);
    expect(decision).toBe("dev-keep-alive");
    expect(deps.exit).not.toHaveBeenCalled();
  });
});

describe("handleFatalFault — production", () => {
  it("logs, flushes telemetry, and exits non-zero for a non-recoverable fault", async () => {
    const deps = prodDeps();
    const decision = await handleFatalFault("uncaughtException", new TypeError("real bug"), deps);
    expect(decision).toBe("exit");
    expect(deps.flush).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.logError).toHaveBeenCalled();
  });

  it("flushes BEFORE exiting (spans/events reach the collector first)", async () => {
    const order: string[] = [];
    const deps = prodDeps({
      flush: vi.fn().mockImplementation(async () => {
        order.push("flush");
      }),
      exit: vi.fn().mockImplementation(() => {
        order.push("exit");
      }),
    });
    await handleFatalFault("unhandledRejection", new Error("boom"), deps);
    expect(order).toEqual(["flush", "exit"]);
  });

  it("keeps the process alive for an explicitly recoverable transient infra fault", async () => {
    const deps = prodDeps();
    const reason = Object.assign(new Error("socket gone"), { code: "ECONNRESET" });
    const decision = await handleFatalFault("uncaughtException", reason, deps);
    expect(decision).toBe("recoverable");
    expect(deps.exit).not.toHaveBeenCalled();
    expect(deps.flush).not.toHaveBeenCalled();
  });
});

describe("installFatalErrorHandlers", () => {
  it("registers a handler for both process-level faults", () => {
    const beforeUncaught = process.listeners("uncaughtException").slice();
    const beforeRejection = process.listeners("unhandledRejection").slice();
    try {
      installFatalErrorHandlers(devDeps());
      const addedUncaught = process
        .listeners("uncaughtException")
        .filter((l) => !beforeUncaught.includes(l));
      const addedRejection = process
        .listeners("unhandledRejection")
        .filter((l) => !beforeRejection.includes(l));
      expect(addedUncaught).toHaveLength(1);
      expect(addedRejection).toHaveLength(1);
    } finally {
      // Remove ONLY the listeners this test added; leave vitest's own intact.
      for (const l of process.listeners("uncaughtException")) {
        if (!beforeUncaught.includes(l)) process.off("uncaughtException", l);
      }
      for (const l of process.listeners("unhandledRejection")) {
        if (!beforeRejection.includes(l)) process.off("unhandledRejection", l);
      }
    }
  });
});

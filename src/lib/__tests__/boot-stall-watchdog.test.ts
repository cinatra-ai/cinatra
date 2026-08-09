import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// #2554 regression guard — the bounded startup deadline.
//
// The defect: a boot phase that blocks forever (the reproduced case: an awaited
// boot statement waiting on a Postgres relation lock) left the process at 0% CPU
// with NO output at all. Nothing bounded or narrated boot, so a stall was
// indistinguishable from a crash.
//
// The owner ruling on cinatra#2554 that these tests pin:
//   1. at 180 s with no readiness, a loud diagnostic fires and NAMES the exact
//      boot phase still in flight;
//   2. in DEVELOPMENT the process then exits non-zero;
//   3. in PRODUCTION the process is NOT exited — the diagnostic repeats every
//      60 s and boot keeps waiting.
//
// Fake timers throughout: no test waits three real minutes.
// ---------------------------------------------------------------------------

import {
  armBootStallWatchdog,
  BOOT_STALL_DEADLINE_MS,
  BOOT_STALL_REPEAT_MS,
} from "@/lib/boot/boot-stall-watchdog";

describe("boot stall watchdog (#2554)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function arm(opts: { dev: boolean }) {
    const logged: string[] = [];
    const exit = vi.fn();
    const watchdog = armBootStallWatchdog({
      isDevMode: () => opts.dev,
      logError: (message) => logged.push(message),
      exit,
    });
    return { watchdog, logged, exit };
  }

  it("fires at 180s and NAMES the in-flight boot phase", () => {
    const { watchdog, logged } = arm({ dev: false });

    watchdog.phaseStarted("core-migrations");
    watchdog.phaseFinished("core-migrations");
    watchdog.phaseStarted("install-op-boot-cleanup"); // never finishes — the stall

    // One tick short of the deadline: still completely silent.
    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS - 1);
    expect(logged).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(BOOT_STALL_DEADLINE_MS).toBe(180_000);
    expect(logged.length).toBeGreaterThan(0);
    const diagnostic = logged[0];
    // The whole point of the ruling: the diagnostic names the phase in flight —
    // and names it AS the in-flight one, not merely somewhere in the text.
    expect(diagnostic).toContain("STALL");
    expect(diagnostic).toMatch(/In-flight boot phase: "install-op-boot-cleanup"/);
    // The already-completed phase is reported as completed, never as in-flight.
    expect(diagnostic).toMatch(/completed 1 phase\(s\), last: "core-migrations"/);
  });

  it("exits non-zero in DEVELOPMENT once the deadline fires", () => {
    const { watchdog, logged, exit } = arm({ dev: true });

    watchdog.phaseStarted("skills-catalog-rebuild");

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);

    expect(logged.join("\n")).toContain("skills-catalog-rebuild");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    // Having exited, it must not also start repeating.
    const afterExit = logged.length;
    vi.advanceTimersByTime(BOOT_STALL_REPEAT_MS * 5);
    expect(logged.length).toBe(afterExit);
  });

  it("in PRODUCTION keeps waiting and repeats the diagnostic every 60s", () => {
    const { watchdog, logged, exit } = arm({ dev: false });

    watchdog.phaseStarted("agent-marker-backfill");

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);
    // A serving-capable process is never exited on a possibly transient stall.
    expect(exit).not.toHaveBeenCalled();
    const afterDeadline = logged.length;

    vi.advanceTimersByTime(BOOT_STALL_REPEAT_MS - 1);
    expect(logged.length).toBe(afterDeadline);

    vi.advanceTimersByTime(1);
    expect(logged.length).toBe(afterDeadline + 1);
    expect(logged[logged.length - 1]).toContain("agent-marker-backfill");

    vi.advanceTimersByTime(BOOT_STALL_REPEAT_MS * 3);
    expect(logged.length).toBe(afterDeadline + 4);
    expect(exit).not.toHaveBeenCalled();
    expect(BOOT_STALL_REPEAT_MS).toBe(60_000);
  });

  it("the repeat names the phase in flight AT THAT MOMENT, not the one at the deadline", () => {
    const { watchdog, logged } = arm({ dev: false });

    watchdog.phaseStarted("agent-mount-projection");
    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);
    expect(logged[0]).toContain("agent-mount-projection");

    // Boot inched forward, then stalled somewhere else.
    watchdog.phaseFinished("agent-mount-projection");
    watchdog.phaseStarted("system-loops");

    vi.advanceTimersByTime(BOOT_STALL_REPEAT_MS);
    expect(logged[logged.length - 1]).toContain("system-loops");
  });

  it("stays silent forever once disarmed (the normal boot-reached-ready path)", () => {
    const { watchdog, logged, exit } = arm({ dev: true });

    watchdog.phaseStarted("core-migrations");
    watchdog.phaseFinished("core-migrations");
    watchdog.disarm();

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS * 10);

    expect(logged).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("stops repeating — and stays idempotent — when disarmed AFTER the deadline fired", () => {
    const { watchdog, logged } = arm({ dev: false });

    watchdog.phaseStarted("system-loops");
    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS + BOOT_STALL_REPEAT_MS);
    const beforeDisarm = logged.length;
    expect(beforeDisarm).toBeGreaterThan(0);

    // Boot finally reached ready: the repeat interval must stop.
    watchdog.disarm();
    watchdog.disarm(); // idempotent — a second disarm is a no-op, not a throw

    vi.advanceTimersByTime(BOOT_STALL_REPEAT_MS * 10);
    expect(logged.length).toBe(beforeDisarm);
  });

  it("does NOT exit when boot reaches ready mid-diagnostic (re-entrant disarm, dev arm)", () => {
    // A disarm racing the deadline means boot became ready. Exiting a ready
    // process would be exactly the harm the prod arm exists to avoid.
    const logged: string[] = [];
    const exit = vi.fn();
    const watchdog: ReturnType<typeof armBootStallWatchdog> = armBootStallWatchdog({
      isDevMode: () => true,
      logError: (message) => {
        logged.push(message);
        watchdog.disarm(); // boot reached ready while the diagnostic was printing
      },
      exit,
    });
    watchdog.phaseStarted("core-migrations");

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);

    expect(logged.length).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("installs no repeat interval when disarmed mid-diagnostic (prod arm)", () => {
    const logged: string[] = [];
    const watchdog: ReturnType<typeof armBootStallWatchdog> = armBootStallWatchdog({
      isDevMode: () => false,
      logError: (message) => {
        logged.push(message);
        watchdog.disarm();
      },
      exit: vi.fn(),
    });
    watchdog.phaseStarted("system-loops");

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS + BOOT_STALL_REPEAT_MS * 5);

    expect(logged.length).toBe(1);
  });

  it("honours the CINATRA_BOOT_READY_TIMEOUT_MS override on a legitimately slow host", () => {
    vi.stubEnv("CINATRA_BOOT_READY_TIMEOUT_MS", "600000");
    const logged: string[] = [];
    const watchdog = armBootStallWatchdog({
      isDevMode: () => false,
      logError: (message) => logged.push(message),
      exit: vi.fn(),
    });
    watchdog.phaseStarted("required-extension-materialize");

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);
    expect(logged).toEqual([]); // the 180s default no longer applies

    vi.advanceTimersByTime(600_000 - BOOT_STALL_DEADLINE_MS);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0]).toContain("required-extension-materialize");
  });

  it("clamps an override past Node's timer ceiling instead of letting it wrap", () => {
    // A raw delay above 2^31-1 wraps in Node's timer layer and fires on the next
    // tick — turning "give me more time" into an INSTANT dev exit. The resolver
    // clamps to the ceiling, so the armed deadline is 2^31-1 ms, not 2^40.
    const MAX_TIMER_MS = 2_147_483_647;
    vi.stubEnv("CINATRA_BOOT_READY_TIMEOUT_MS", String(2 ** 40));
    const logged: string[] = [];
    const exit = vi.fn();
    const watchdog = armBootStallWatchdog({
      isDevMode: () => false,
      logError: (message) => logged.push(message),
      exit,
    });
    watchdog.phaseStarted("core-migrations");

    vi.advanceTimersByTime(MAX_TIMER_MS - 1);
    expect(logged).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(logged.length).toBeGreaterThan(0);
    // The reported deadline is the CLAMPED one, not the raw override.
    expect(logged[0]).toContain(`(deadline ${(MAX_TIMER_MS / 1000).toFixed(1)}s)`);
  });

  it("takes the dev/prod branch decided AT ARM TIME, not at fire time", () => {
    // The dev arm EXITS the process, so the decision must not be able to flip
    // mid-boot (e.g. an env mutation by a boot phase).
    let mode = true;
    const logged: string[] = [];
    const exit = vi.fn();
    const watchdog = armBootStallWatchdog({
      isDevMode: () => mode,
      logError: (message) => logged.push(message),
      exit,
    });
    watchdog.phaseStarted("core-migrations");

    mode = false; // flipped after arming — must be ignored
    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports honestly when nothing is in flight (a stall BETWEEN phases)", () => {
    const { watchdog, logged } = arm({ dev: false });

    watchdog.phaseStarted("otel-tracing");
    watchdog.phaseFinished("otel-tracing");

    vi.advanceTimersByTime(BOOT_STALL_DEADLINE_MS);

    expect(logged[0]).toContain("In-flight boot phase: <none — boot is between phases>");
    // ...and the last completed phase is still named, so the operator knows where
    // boot actually got to.
    expect(logged[0]).toMatch(/completed 1 phase\(s\), last: "otel-tracing"/);
  });
});

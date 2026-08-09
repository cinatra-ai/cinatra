// Bounded startup deadline for the boot sequence (cinatra#2554).
//
// THE DEFECT this closes: nothing bounded or narrated boot. Every awaited boot
// phase runs BEFORE the server serves anything, and several of them reach
// Postgres. A statement that blocks forever (the reproduced case: an awaited
// boot statement waiting on an ACCESS EXCLUSIVE relation lock held by another
// session) leaves the process at 0% CPU, no port bound, and — this is the actual
// defect — NO output at all. An unbounded silent wait is indistinguishable from
// a crash, which is why the incident on #2554 cost 15 minutes per attempt and
// produced no diagnostic to work from.
//
// THE REMEDY (owner ruling recorded on cinatra#2554): arm an `unref()`ed
// deadline when boot starts. If readiness is not reached within 180 s, log a
// LOUD diagnostic that NAMES the exact boot phase still in flight, then:
//   - DEVELOPMENT: exit non-zero. A stalled dev boot never serves; failing fast
//     with a named phase beats a hang that looks like a crash.
//   - PRODUCTION:  keep waiting and REPEAT the diagnostic every 60 s. A
//     serving-capable process is never exited on a possibly transient stall.
//
// This does not stop the stall — it makes every future stall SELF-DESCRIBING,
// whatever its cause. The phase markers are strings recorded at the existing
// await boundaries in the orchestrator; they change no boot behavior.
//
// Both timers are `unref()`ed, so the watchdog NEVER keeps the process alive on
// its own and never delays a clean exit.
//
// Deliberately NOT importing "server-only": vitest unit tests import this module
// directly (mirrors boot-phase.ts / boot-state.ts).

import { writeSync } from "node:fs";

/** The ruling's deadline: 180 s from the start of boot to readiness. */
export const BOOT_STALL_DEADLINE_MS = 180_000;

/** The ruling's production repeat interval for the loud diagnostic. */
export const BOOT_STALL_REPEAT_MS = 60_000;

/**
 * Escape hatch for a host that is legitimately slower than the deadline, named
 * in the #2554 diagnosis the ruling adopted. It exists because the DEV arm
 * EXITS: without it, a host whose honest boot exceeds the deadline could not
 * start the dev server at all. Unset/invalid falls back to the 180 s default.
 * Mirrors the existing `POSTGRES_SYNC_TIMEOUT_MS` ceiling override.
 */
export const BOOT_STALL_DEADLINE_ENV_KEY = "CINATRA_BOOT_READY_TIMEOUT_MS";

/** Node's timer ceiling; a larger delay wraps and fires almost immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export type BootStallWatchdogDeps = {
  /**
   * Dev-vs-prod switch, EVALUATED ONCE at arm time so the dev/prod decision is
   * immutable for this boot. The caller passes the orchestrator's own boot-mode
   * predicate — this module never re-derives the mode itself, so the deadline's
   * dev/prod split can never drift from the boot sequence's.
   */
  isDevMode: () => boolean;
  /** Injectable so the unit test can assert the exact diagnostic text. */
  logError?: (message: string) => void;
  /** Injectable so the unit test never actually kills the vitest process. */
  exit?: (code: number) => void;
};

/** The handle the orchestrator drives: phase markers + disarm on ready/abort. */
export type BootStallWatchdog = {
  /** Record that `name` is the boot phase now in flight. */
  phaseStarted: (name: string) => void;
  /** Record that `name` finished (ok, skipped, or failed). */
  phaseFinished: (name: string) => void;
  /** Stop the watchdog. Called when boot reaches ready OR aborts. Idempotent. */
  disarm: () => void;
};

function resolveDeadlineMs(): number {
  const raw = Number(process.env[BOOT_STALL_DEADLINE_ENV_KEY]);
  if (!Number.isFinite(raw) || raw <= 0) return BOOT_STALL_DEADLINE_MS;
  // Clamp: a delay past Node's timer ceiling wraps and would fire immediately,
  // turning a "give me more time" override into an instant dev exit.
  return Math.min(raw, MAX_TIMER_MS);
}

/**
 * Write the diagnostic SYNCHRONOUSLY to stderr.
 *
 * The dev arm calls `process.exit(1)` right after logging, and `process.exit()`
 * abandons pending async writes — with stderr piped (the dev server is launched
 * through a wrapper script) a `console.error` can be truncated away. Losing the
 * diagnostic would defeat the entire fix, so the default writer is `writeSync`
 * on fd 2, falling back to console on the rare platform where that throws.
 */
function writeStderrSync(message: string): void {
  try {
    writeSync(2, `${message}\n`);
  } catch {
    console.error(message);
  }
}

/** `unref()` when the host timer supports it (Node); a no-op elsewhere. */
function unref(timer: unknown): void {
  const t = timer as { unref?: () => unknown } | number | undefined;
  if (t && typeof t === "object" && typeof t.unref === "function") t.unref();
}

/**
 * Arm the startup deadline. Returns the handle the orchestrator drives.
 *
 * The returned watchdog is inert until the deadline elapses; on a normal boot
 * `disarm()` is reached long before that and nothing is ever logged.
 */
export function armBootStallWatchdog(deps: BootStallWatchdogDeps): BootStallWatchdog {
  const { isDevMode, logError = writeStderrSync, exit = (code: number) => process.exit(code) } =
    deps;

  const deadlineMs = resolveDeadlineMs();
  const dev = isDevMode();
  const startedAt = Date.now();

  let inFlight: string | null = null;
  let inFlightStartedAt: number | null = null;
  const completed: string[] = [];
  let disarmed = false;

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  const seconds = (ms: number): string => (ms / 1000).toFixed(1);

  const describeInFlight = (at: number): string => {
    if (inFlight === null) return "<none — boot is between phases>";
    const held = inFlightStartedAt === null ? null : at - inFlightStartedAt;
    return held === null ? `"${inFlight}"` : `"${inFlight}" (in flight for ${seconds(held)}s)`;
  };

  const describeCompleted = (): string =>
    completed.length === 0
      ? "no phase has completed yet"
      : `completed ${completed.length} phase(s), last: "${completed[completed.length - 1]}"`;

  const diagnostic = (at: number): string =>
    `[boot] STALL: boot has not reached ready after ${seconds(at - startedAt)}s ` +
    `(deadline ${seconds(deadlineMs)}s). In-flight boot phase: ${describeInFlight(at)}; ` +
    `${describeCompleted()}. Nothing is served until the awaited boot phases resolve, ` +
    "so this presents as a silent hang. See cinatra#2554.";

  function disarm(): void {
    if (disarmed) return;
    disarmed = true;
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (repeatTimer !== null) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  }

  const onDeadline = (): void => {
    if (disarmed) return;
    logError(diagnostic(Date.now()));
    // `logError` is caller-supplied; re-check before doing anything durable so a
    // writer that disarms us can never leave an orphaned interval behind.
    if (disarmed) return;

    if (dev) {
      // DEV: a stalled dev boot never serves. Fail fast, non-zero, with the
      // phase named above — the ruling's dev arm.
      logError(
        "[boot] STALL: exiting non-zero (development). A stalled dev boot never serves; " +
          "fix the blocked phase named above, or raise " +
          `${BOOT_STALL_DEADLINE_ENV_KEY} if this host is legitimately slower than the deadline.`,
      );
      // Same re-check as the production arm, and here it is load-bearing: a
      // disarm means boot reached ready, and a ready process must NOT be exited.
      if (disarmed) return;
      disarm();
      exit(1);
      return;
    }

    // PROD: a serving-capable process is never exited on a possibly transient
    // stall. Keep waiting; repeat the loud diagnostic on an interval.
    logError(
      "[boot] STALL: still waiting (production — the process is NOT exited on a possibly " +
        `transient stall). This diagnostic repeats every ${seconds(BOOT_STALL_REPEAT_MS)}s ` +
        "until boot reaches ready.",
    );
    if (disarmed) return;
    repeatTimer = setInterval(() => {
      if (disarmed) return;
      logError(diagnostic(Date.now()));
    }, BOOT_STALL_REPEAT_MS);
    unref(repeatTimer);
  };

  deadlineTimer = setTimeout(onDeadline, deadlineMs);
  unref(deadlineTimer);

  return {
    phaseStarted: (name: string) => {
      inFlight = name;
      inFlightStartedAt = Date.now();
    },
    phaseFinished: (name: string) => {
      completed.push(name);
      // Defensive: only clear when the finishing phase is the one recorded in
      // flight (boot phases run strictly sequentially, so this always matches).
      if (inFlight === name) {
        inFlight = null;
        inFlightStartedAt = null;
      }
    },
    disarm,
  };
}

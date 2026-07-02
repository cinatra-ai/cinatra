// Production fatal-error policy for process-level faults (engineering #302).
//
// HISTORY: `register()` installed process `uncaughtException` /
// `unhandledRejection` handlers that LOGGED and explicitly kept the process alive
// ("server will NOT exit"). Keeping a production process alive after a truly
// uncaught fault leaves it in an UNDEFINED state — half-open pools, leaked
// transactions, a worker mid-job — which the orchestrator cannot detect, so it
// never restarts the box. The process limps, serving corrupt or 500-ing traffic.
//
// THE POLICY (the deliberate behavioral change):
//   - DEVELOPMENT (default): log the fault and KEEP RUNNING — verbatim today's
//     behavior, so the dev hot-reload loop is unchanged (a typo in a route must
//     not kill the dev server).
//   - PRODUCTION: log the fault, FLUSH telemetry (Sentry + OTel) best-effort with
//     a bounded timeout, then EXIT NON-ZERO so the orchestrator restarts a clean
//     process — UNLESS the fault is EXPLICITLY classified RECOVERABLE, in which
//     case log + keep running (the old behavior, but now opt-IN per class).
//
// RECOVERABLE CLASSES (prod keeps running): the narrow set of transient,
// self-healing infrastructure faults the app already tolerates lazily — a dropped
// pg.Pool / IORedis socket surfaces as an EventEmitter 'error' whose next
// operation reconnects. These were the original motivation for the keep-alive
// handlers; they stay keep-alive. EVERYTHING ELSE (a real programming fault, an
// unhandled rejection in app code) exits. The recoverable set is intentionally
// SMALL and matched conservatively — when in doubt, exit (fail-safe = restart).
//
// Deliberately NOT importing "server-only": vitest unit tests import this module
// directly.

import { getAppRuntimeMode } from "@/lib/runtime-mode";

/** Which process-level fault fired. */
export type FatalFaultKind = "uncaughtException" | "unhandledRejection";

/** What the policy decided to do with a fault. */
export type FatalDecision = "exit" | "recoverable" | "dev-keep-alive";

/**
 * Connection-level transient infrastructure errors that the app self-heals on the
 * next operation (a reconnecting pool/socket). Matched conservatively on Node's
 * stable error `code`s. NOT a catch-all — anything outside this set exits in prod.
 */
const RECOVERABLE_ERROR_CODES = new Set<string>([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN", // transient DNS
]);

function errorCodeOf(reason: unknown): string | undefined {
  if (reason && typeof reason === "object" && "code" in reason) {
    const code = (reason as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Classify a process-level fault as recoverable (prod keeps running) or not (prod
 * exits). Recoverable = a known transient connection-level infrastructure error.
 * Pure + side-effect-free so it is directly unit-testable.
 */
export function isRecoverableFatalFault(reason: unknown): boolean {
  const code = errorCodeOf(reason);
  return code !== undefined && RECOVERABLE_ERROR_CODES.has(code);
}

/** Best-effort telemetry flush before a fatal exit. Bounded; never throws. */
async function flushTelemetry(timeoutMs: number, deps: InstallFatalDeps): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  // Sentry: dynamic import so this is a no-op when @sentry/nextjs is absent or
  // Sentry was never initialised (getClient() -> undefined -> flush resolves).
  tasks.push(
    (async () => {
      try {
        const Sentry = await import("@sentry/nextjs");
        await Sentry.flush(timeoutMs);
      } catch {
        /* best-effort */
      }
    })(),
  );
  // OTel: force-flush the BatchSpanProcessor so the spans around the crash export.
  tasks.push(
    (async () => {
      try {
        const { flushOtelTracing } = await import("@/lib/otel-bootstrap");
        await flushOtelTracing();
      } catch {
        /* best-effort */
      }
    })(),
  );

  // Cap the total flush wait so a hung exporter can never wedge the exit path.
  const scheduleTimeout = deps.setTimeout ?? globalThis.setTimeout;
  const cap = new Promise<void>((resolve) => {
    const t = scheduleTimeout(resolve, timeoutMs);
    // Do not let the timer keep the (already-dying) event loop alive.
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  });
  await Promise.race([Promise.allSettled(tasks).then(() => undefined), cap]);
}

/** Injectable side-effects so the handler is fully unit-testable. */
export type InstallFatalDeps = {
  getMode?: typeof getAppRuntimeMode;
  logError?: (msg: string, err?: unknown) => void;
  exit?: (code: number) => void;
  flush?: (timeoutMs: number, deps: InstallFatalDeps) => Promise<void>;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Max millis to wait for the telemetry flush before exiting anyway. */
  flushTimeoutMs?: number;
};

/**
 * Decide what to do with a fault, perform the flush+exit if warranted, and return
 * the decision (so the installer + tests can assert it without process death).
 *
 * The flush+exit is awaited so spans/events reach the collector BEFORE exit; the
 * exit is deferred to the next tick after flush to let the log line drain.
 */
export async function handleFatalFault(
  kind: FatalFaultKind,
  reason: unknown,
  deps: InstallFatalDeps = {},
): Promise<FatalDecision> {
  const {
    getMode = getAppRuntimeMode,
    logError = (msg, err) => console.error(msg, err ?? ""),
    exit = (code) => process.exit(code),
    flush = flushTelemetry,
    flushTimeoutMs = 2000,
  } = deps;

  const isProd = getMode() === "production";

  if (!isProd) {
    // Development: verbatim today's behavior — log and keep the process alive so
    // the hot-reload loop survives an in-flight typo.
    logError(`[CRASH] ${kind} — dev mode, server will NOT exit:`, reason);
    return "dev-keep-alive";
  }

  if (isRecoverableFatalFault(reason)) {
    // Production, but an explicitly classified transient infra fault: keep running
    // (the connection self-heals on the next operation). This is the ONLY prod
    // keep-alive path, and it is opt-IN per recoverable class.
    logError(
      `[CRASH] ${kind} — recoverable transient infrastructure fault, server will NOT exit:`,
      reason,
    );
    return "recoverable";
  }

  // Production, non-recoverable: log, flush telemetry, exit non-zero so the
  // orchestrator restarts a clean process.
  logError(
    `[CRASH] ${kind} — fatal in production, flushing telemetry and exiting non-zero so the orchestrator restarts a clean process:`,
    reason,
  );
  await flush(flushTimeoutMs, { ...deps, setTimeout: deps.setTimeout ?? globalThis.setTimeout });
  exit(1);
  return "exit";
}

/**
 * Install the process-level fatal-error handlers. Called once at the very top of
 * `register()`. The handlers route every fault through `handleFatalFault`, which
 * applies the prod/dev + recoverable policy above.
 *
 * A failure inside the async handler itself (e.g. the flush throwing despite the
 * best-effort guards) still exits in production — a fatal fault must never be
 * swallowed by a flush bug.
 */
export function installFatalErrorHandlers(deps: InstallFatalDeps = {}): void {
  const onFault = (kind: FatalFaultKind) => (reason: unknown) => {
    void handleFatalFault(kind, reason, deps).catch((handlerErr) => {
      const logError = deps.logError ?? ((msg, err) => console.error(msg, err ?? ""));
      logError(`[CRASH] fatal handler for ${kind} threw — exiting non-zero:`, handlerErr);
      const exit = deps.exit ?? ((code) => process.exit(code));
      const getMode = deps.getMode ?? getAppRuntimeMode;
      // Only force the exit in production; dev keeps the prior keep-alive contract.
      if (getMode() === "production") exit(1);
    });
  };
  process.on("uncaughtException", onFault("uncaughtException"));
  process.on("unhandledRejection", onFault("unhandledRejection"));
}

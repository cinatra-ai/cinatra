/**
 * The development server's memory, by kind, once a minute (cinatra#3758).
 *
 * WHAT IT IS FOR. The development server grows far past its heap bound: three
 * development servers of this repository held 14.1 GB of anonymous memory at 44
 * minutes, 16.4 GB at 64 and 19.6 GB at 77, while the `dev` script bounds the V8
 * heap at 8192 MB. A total that large says THAT the process grew, not WHERE.
 * This reading splits it the way Node.js does (`process.memoryUsage()`): the
 * resident set of the whole process, the V8 heap in use and reserved, the memory
 * of C++ objects bound to JavaScript objects (`external`) and the part of that
 * held by ArrayBuffers and Buffers. What the resident set holds beyond the heap
 * and `external` is native memory; in the development server that is mostly the
 * bundler, which runs inside this process.
 *
 * THE LINE. One line a minute, starting with a fixed word so a reader can
 * filter the server's log for it:
 *
 *   [dev-memory] rss=5234MB heapUsed=1234MB heapTotal=1400MB external=210MB arrayBuffers=35MB
 *
 * Five whole numbers of megabytes (1 MB = 1024 × 1024 bytes, the unit of
 * `--max-old-space-size`) and nothing else: no path, no address, no value from
 * the environment. The resident set does not count memory that was swapped out.
 *
 * DEVELOPMENT ONLY, ONE TIMER PER PROCESS, NEVER HOLDS THE PROCESS OPEN. It
 * starts only when NODE_ENV is `development`, which `next dev` sets for its
 * server, so a production server, a build and a test run never write it. The
 * framework runs the instrumentation hook again after a hot reload, and each
 * bundler compilation has its own module cache, so the timer is kept on a
 * process-wide `Symbol.for` key and a later call starts nothing. The timer is
 * `unref()`ed: it never keeps the process alive and never delays its exit.
 *
 * Deliberately NOT importing "server-only": the unit test imports this module
 * directly.
 */

/** The fixed word every reading starts with. */
export const DEV_MEMORY_LINE_PREFIX = "[dev-memory]";

/** How often the development server writes a reading: once a minute. */
export const DEV_MEMORY_READING_INTERVAL_MS = 60_000;

const BYTES_PER_MB = 1024 * 1024;

/** Where this process keeps its one timer. */
const DEV_MEMORY_TIMER_KEY = Symbol.for("cinatra.dev-memory-reading.timer");

type TimerHolder = { [key: symbol]: unknown };

/** The five kinds a reading carries, named as `process.memoryUsage()` names them. */
export type DevMemoryUsage = Pick<
  NodeJS.MemoryUsage,
  "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers"
>;

function megabytes(bytes: number): string {
  return (Math.max(0, bytes) / BYTES_PER_MB).toFixed(0);
}

/** One reading, as the line the development server writes. */
export function formatDevMemoryLine(usage: DevMemoryUsage): string {
  return [
    DEV_MEMORY_LINE_PREFIX,
    `rss=${megabytes(usage.rss)}MB`,
    `heapUsed=${megabytes(usage.heapUsed)}MB`,
    `heapTotal=${megabytes(usage.heapTotal)}MB`,
    `external=${megabytes(usage.external)}MB`,
    `arrayBuffers=${megabytes(usage.arrayBuffers)}MB`,
  ].join(" ");
}

/** Is this process the development server? Only an explicit `development` says so. */
export function isDevelopmentServer(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === "development";
}

export type DevMemoryReadingDeps = {
  env?: Record<string, string | undefined>;
  /** Injectable so a test can state the numbers. */
  memoryUsage?: () => DevMemoryUsage;
  /** Injectable so a test can read the line. The server writes it with `console.info`. */
  log?: (line: string) => void;
  /** Injectable so a test can drive the timer. */
  setIntervalFn?: (callback: () => void, ms: number) => unknown;
  /** Where the process-wide timer is kept; `globalThis` unless a test hands its own. */
  holder?: object;
};

/** `unref()` when the timer supports it (Node.js); a no-op elsewhere. */
function unref(timer: unknown): void {
  const t = timer as { unref?: () => unknown } | null | undefined;
  if (t && typeof t === "object" && typeof t.unref === "function") t.unref();
}

/**
 * Start the reading. Returns true when this call started it, false when this
 * process is not the development server or already has one.
 */
export function startDevMemoryReading(deps: DevMemoryReadingDeps = {}): boolean {
  if (!isDevelopmentServer(deps.env ?? process.env)) return false;
  const holder = (deps.holder ?? globalThis) as TimerHolder;
  if (holder[DEV_MEMORY_TIMER_KEY] !== undefined) return false;

  const memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage());
  const log = deps.log ?? ((line: string) => console.info(line));
  const setIntervalFn =
    deps.setIntervalFn ?? ((callback: () => void, ms: number) => setInterval(callback, ms));

  const timer = setIntervalFn(() => {
    try {
      log(formatDevMemoryLine(memoryUsage()));
    } catch {
      // A reading is a diagnostic: a failed one is skipped, never thrown into the server.
    }
  }, DEV_MEMORY_READING_INTERVAL_MS);
  unref(timer);
  holder[DEV_MEMORY_TIMER_KEY] = timer;
  return true;
}

/** Test seam: stop the reading kept on `holder`, so a case can start its own. */
export function stopDevMemoryReadingForTests(holder: object = globalThis): void {
  const h = holder as TimerHolder;
  const timer = h[DEV_MEMORY_TIMER_KEY];
  if (timer !== undefined) clearInterval(timer as ReturnType<typeof setInterval>);
  delete h[DEV_MEMORY_TIMER_KEY];
}

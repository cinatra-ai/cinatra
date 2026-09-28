/**
 * cinatra#3758 — the development server's memory, by kind, once a minute.
 *
 * Pins the line (a fixed prefix and exactly five whole numbers of megabytes,
 * nothing a reader could mistake for a path or an address), the mode (the
 * development server only), the timer (one per process, once a minute, never
 * holding the process open) and the wiring (the server's instrumentation hook
 * starts it after the build guard). No server is started.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEV_MEMORY_LINE_PREFIX,
  DEV_MEMORY_READING_INTERVAL_MS,
  type DevMemoryUsage,
  formatDevMemoryLine,
  isDevelopmentServer,
  startDevMemoryReading,
  stopDevMemoryReadingForTests,
} from "@/lib/dev-memory-reading";

const MB = 1024 * 1024;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The whole line, anchored: the prefix, five named whole numbers, nothing else. */
const LINE =
  /^\[dev-memory\] rss=(\d+)MB heapUsed=(\d+)MB heapTotal=(\d+)MB external=(\d+)MB arrayBuffers=(\d+)MB$/;

const STATED: DevMemoryUsage = {
  rss: 5234 * MB,
  heapUsed: 1234 * MB,
  heapTotal: 1400 * MB,
  external: 210 * MB,
  arrayBuffers: 35 * MB,
};

const holders: object[] = [];
function newHolder(): object {
  const holder = {};
  holders.push(holder);
  return holder;
}

afterEach(() => {
  for (const holder of holders.splice(0)) stopDevMemoryReadingForTests(holder);
});

describe("formatDevMemoryLine", () => {
  it("writes the fixed prefix and the five kinds in megabytes", () => {
    expect(formatDevMemoryLine(STATED)).toBe(
      "[dev-memory] rss=5234MB heapUsed=1234MB heapTotal=1400MB external=210MB arrayBuffers=35MB",
    );
  });

  it("carries exactly five numbers and nothing else after the prefix", () => {
    const line = formatDevMemoryLine(STATED);
    expect(line.startsWith(`${DEV_MEMORY_LINE_PREFIX} `)).toBe(true);
    expect(line.match(/\d+/g)).toEqual(["5234", "1234", "1400", "210", "35"]);
    expect(line).toMatch(LINE);
  });

  it("counts a megabyte as 1024 × 1024 bytes and writes whole numbers", () => {
    const line = formatDevMemoryLine({
      rss: 3 * MB + 0.6 * MB,
      heapUsed: 0.4 * MB,
      heapTotal: 1.5 * MB,
      external: 0,
      arrayBuffers: 1000 * 1000,
    });
    expect(line).toBe(
      "[dev-memory] rss=4MB heapUsed=0MB heapTotal=2MB external=0MB arrayBuffers=1MB",
    );
  });

  it("formats the real process the same way", () => {
    const match = LINE.exec(formatDevMemoryLine(process.memoryUsage()));
    expect(match).not.toBeNull();
    const [, rss, heapUsed, heapTotal] = match!.map(Number);
    expect(rss).toBeGreaterThan(0);
    expect(heapUsed).toBeLessThanOrEqual(heapTotal);
  });
});

describe("isDevelopmentServer", () => {
  it("answers yes only to an explicit development", () => {
    expect(isDevelopmentServer({ NODE_ENV: "development" })).toBe(true);
    for (const NODE_ENV of ["production", "test", "", "Development", undefined]) {
      expect(isDevelopmentServer({ NODE_ENV })).toBe(false);
    }
  });
});

describe("startDevMemoryReading", () => {
  it("starts nothing outside the development server", () => {
    for (const NODE_ENV of ["production", "test", undefined]) {
      const setIntervalFn = vi.fn();
      const log = vi.fn();
      expect(
        startDevMemoryReading({ env: { NODE_ENV }, setIntervalFn, log, holder: newHolder() }),
      ).toBe(false);
      expect(setIntervalFn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    }
  });

  it("reads once a minute on a timer that is unref()ed", () => {
    const unref = vi.fn();
    const setIntervalFn = vi.fn<(callback: () => void, ms: number) => { unref: () => void }>(
      () => ({ unref }),
    );
    expect(
      startDevMemoryReading({
        env: { NODE_ENV: "development" },
        setIntervalFn,
        log: () => {},
        holder: newHolder(),
      }),
    ).toBe(true);
    expect(DEV_MEMORY_READING_INTERVAL_MS).toBe(60_000);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0][1]).toBe(DEV_MEMORY_READING_INTERVAL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("writes exactly one line per minute, and none before the first", () => {
    const lines: string[] = [];
    let tick: () => void = () => {
      throw new Error("the timer was never set");
    };
    startDevMemoryReading({
      env: { NODE_ENV: "development" },
      memoryUsage: () => STATED,
      log: (line) => lines.push(line),
      setIntervalFn: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      holder: newHolder(),
    });
    expect(lines).toEqual([]);
    tick();
    expect(lines).toEqual([formatDevMemoryLine(STATED)]);
    tick();
    expect(lines).toHaveLength(2);
  });

  it("keeps one timer per process however often the hook runs", () => {
    const holder = newHolder();
    const setIntervalFn = vi.fn(() => ({ unref() {} }));
    const deps = { env: { NODE_ENV: "development" }, setIntervalFn, log: () => {}, holder };
    expect(startDevMemoryReading(deps)).toBe(true);
    expect(startDevMemoryReading(deps)).toBe(false);
    expect(startDevMemoryReading(deps)).toBe(false);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it("never holds the process open (a real timer)", () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    startDevMemoryReading({
      env: { NODE_ENV: "development" },
      log: () => {},
      setIntervalFn: (callback, ms) => (timer = setInterval(callback, ms)),
      holder: newHolder(),
    });
    expect(timer).toBeDefined();
    expect(timer!.hasRef()).toBe(false);
  });

  it("skips a reading that fails instead of throwing into the server", () => {
    const log = vi.fn();
    let tick: () => void = () => {};
    startDevMemoryReading({
      env: { NODE_ENV: "development" },
      memoryUsage: () => {
        throw new Error("no reading");
      },
      log,
      setIntervalFn: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      holder: newHolder(),
    });
    expect(() => tick()).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("the wiring", () => {
  it("is started by the server's instrumentation hook, after the build guard and before startBoot", () => {
    const entry = readFileSync(path.join(REPO_ROOT, "src", "instrumentation.node.ts"), "utf8");
    expect(entry).toContain('import { startDevMemoryReading } from "@/lib/dev-memory-reading";');
    const guard = entry.indexOf('process.env.NEXT_PHASE === "phase-production-build"');
    const start = entry.indexOf("  startDevMemoryReading();");
    const next = entry.indexOf("await startBoot(");
    expect(guard).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(guard);
    expect(next).toBeGreaterThan(start);
  });
});

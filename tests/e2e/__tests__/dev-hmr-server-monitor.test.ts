import assert from "node:assert/strict";
import { test } from "vitest";
import { createPeak, recordPeak, parseProcStat, selectOwned, stopOwned, firstCompile, readingUnderLimit, withServerCleanup, sameRun, readRows, publicPeak } from "../dev-hmr-smoke/server-monitor.mjs";

const row = (pid, ppid, group, start, rssBytes = 1024, hwmBytes = rssBytes) => ({ pid, ppid, group, start, rssBytes, hwmBytes, state: "S" });

test("stat parser ignores command text (including parentheses), uses correct kernel fields", () => {
  const fields = ["S", "1", "10", ...Array(16).fill("0"), "1234", "999", "5"];
  assert.deepEqual(parseProcStat(`10 (never log (this)) ${fields.join(" ")}`), { pid: 10, ppid: 1, group: 10, start: 1234, state: "S" });
  assert.equal(parseProcStat("bad or truncated"), null);
});

test("group membership survives leader exit; known escaped children retain identity", () => {
  const known = new Set(["10:1", "11:2", "12:3"]);
  const rows = [row(11, 1, 10, 2), row(12, 1, 12, 3), row(13, 12, 13, 4), row(99, 1, 99, 5)];
  assert.deepEqual(selectOwned(rows, 10, known).map((p) => p.pid), [11, 12, 13]);
  // A reused PID is unrelated even when a previous identity had been observed.
  assert.deepEqual(selectOwned([row(12, 1, 12, 8)], 10, known), []);
});

test("peak keeps samples distinct from per-process kernel high waters and counts identities", () => {
  const p = createPeak();
  recordPeak(p, [row(10, 1, 10, 1, 400, 800), row(11, 10, 10, 2, 500, 900)], 100);
  recordPeak(p, [row(10, 1, 10, 1, 200, 800), row(11, 10, 10, 3, 100, 700)], 450);
  assert.equal(p.sampledProcessTreePeakBytes, 900);
  assert.equal(p.largestObservedProcessHwmBytes, 900);
  assert.equal(p.observedProcessHwmSumBytes, 2400);
  assert.equal(p.observedProcessCount, 3);
  assert.equal(p.maxSampleGapMs, 350);
  assert.equal(p.firstSampleAtMs, 100);
  assert.equal(p.lastSampleAtMs, 450);
  assert.equal(createPeak().samples, 0);
});

test("absent readings do not masquerade as a zero-byte successful proof", () => {
  const p = createPeak();
  assert.equal(readingUnderLimit(p), null);
  recordPeak(p, [row(10, 1, 10, 1, 12_000_000_000)], 0);
  assert.equal(readingUnderLimit(p), false);
  const q = createPeak();
  recordPeak(q, [row(10, 1, 10, 1, 11_999_999_999)], 0);
  assert.equal(readingUnderLimit(q), true);
  q.readErrors++;
  assert.equal(readingUnderLimit(q), null);
});

test("kernel HWM corroborates but does not change the authorized sampled-only criterion", () => {
  const p = createPeak();
  recordPeak(p, [row(10, 1, 10, 1, 1, 12_000_000_000)], 0);
  assert.equal(readingUnderLimit(p), true);
  assert.equal(p.largestObservedProcessHwmBytes, 12_000_000_000);
});

test("first route compile parser takes only first response, converts units, strips no secrets into output", () => {
  assert.deepEqual(firstCompile("GET /connectors 200 in 2.2min (next.js: 94s, proxy.ts: 8ms, application-code: 39.1s)\nGET /connectors 200 in 10ms (next.js: 2ms)"), { firstRouteStatus: 200, firstRouteElapsedMs: 132000, firstRouteCompileMs: 94000 });
  assert.deepEqual(firstCompile("GET /connectors 500 in 450ms (compile: 12ms, render: 438ms)"), { firstRouteStatus: 500, firstRouteElapsedMs: 450, firstRouteCompileMs: 12 });
  assert.equal(firstCompile("GET /connectors/example 200 in 1s (next.js: 1s)"), null);
  assert.equal(firstCompile("private arbitrary line"), null);
});

test("teardown sends TERM then bounded KILL to surviving owned identities, excluding reused/unrelated PIDs", async () => {
  let time = 0;
  const signals: [number, string][] = [];
  const known = new Set(["10:1", "11:2", "12:3"]);
  const rows = [row(11, 1, 10, 2), row(12, 1, 12, 8), row(99, 1, 99, 9)];
  const result = await stopOwned(10, known, { read: () => ({ rows, complete: true }), signal: (pid, signal) => signals.push([pid, signal]), now: () => time, sleep: async (ms) => { time += ms; if (time >= 6000) rows.splice(0, 1); } });
  assert.deepEqual(signals, [[11, "SIGTERM"], [11, "SIGKILL"]]);
  assert.equal(result, true);
  assert.ok(time <= 10000);
});

test("teardown reports a surviving owned process after its fixed bound", async () => {
  let time = 0;
  assert.equal(await stopOwned(10, new Set(["10:1"]), { read: () => ({ rows: [row(10, 1, 10, 1)], complete: true }), signal: () => {}, now: () => time, sleep: async (ms) => { time += ms; } }), false);
  assert.equal(time, 10000);
});


test("reused group number without an original identity is never a cleanup target", () => {
  assert.deepEqual(selectOwned([row(10, 1, 10, 99), row(11, 10, 10, 100)], 10, new Set(["10:1", "11:2"])), []);
});

test("failed process enumeration cannot report successful teardown", async () => {
  await assert.rejects(stopOwned(10, new Set(["10:1"]), { read: () => { throw new Error("unavailable"); }, signal: () => assert.fail("must not signal"), now: () => 0, sleep: async () => {} }), /unavailable/);
});


test("partial process enumeration never proves successful teardown", async () => {
  let time = 0;
  assert.equal(await stopOwned(10, new Set(["10:1"]), { read: () => ({ rows: [], complete: false }), signal: () => assert.fail("must not signal"), now: () => time, sleep: async (ms) => { time += ms; } }), false);
  assert.equal(time, 10000);
});

test("cleanup runs when initialization fails immediately after spawning", async () => {
  const events: string[] = [];
  await assert.rejects(withServerCleanup(async () => { events.push("spawned"); throw new Error("pid-file-unavailable"); }, async () => { events.push("cleanup"); }), /pid-file-unavailable/);
  assert.deepEqual(events, ["spawned", "cleanup"]);
});

test("missing compile data on the first response cannot be replaced by a later response", () => {
  assert.equal(firstCompile("GET /connectors 200 in 2s\nGET /connectors 200 in 1s (next.js: 1s)"), null);
});

test("stored attribution cannot be relabeled as another head or run attempt", () => {
  const run = { runId: "12", attempt: "2", sha: "a".repeat(40) };
  assert.equal(sameRun(run, { ...run }), true);
  assert.equal(sameRun(run, { ...run, attempt: "1" }), false);
  assert.equal(sameRun(run, { ...run, sha: "b".repeat(40) }), false);
});

test("same-cadence available memory keeps the lowest observed value", () => {
  const p = createPeak();
  recordPeak(p, [row(10, 1, 10, 1)], 1, 5000);
  recordPeak(p, [row(10, 1, 10, 1)], 2, 3000);
  recordPeak(p, [row(10, 1, 10, 1)], 3, 4000);
  assert.equal(p.lowestRunnerMemAvailableBytes, 3000);
});


test("the held supervisor anchors children even when pnpm exits before their first observation", async () => {
  let time = 0;
  const signals: [number, string][] = [];
  const rows = [row(10, 1, 10, 1), row(12, 1, 10, 3)];
  assert.equal(await stopOwned(10, new Set(["10:1"]), {
    excludePid: 10, read: () => ({ rows, complete: true }),
    signal: (pid, signal) => signals.push([pid, signal]), now: () => time,
    sleep: async (ms) => { time += ms; rows.splice(1); },
  }), true);
  assert.deepEqual(signals, [[12, "SIGTERM"]]);
});

test("loss of ownership cannot report an unanchored live group as stopped", async () => {
  let time = 0;
  assert.equal(await stopOwned(10, new Set(["10:1"]), {
    read: () => ({ rows: [row(12, 1, 10, 3)], complete: true }),
    signal: () => assert.fail("numeric-only ownership must not signal"), now: () => time,
    sleep: async (ms) => { time += ms; },
  }), false);
  assert.equal(time, 10000);
});


test("incomplete stat rows prevent a complete inventory, while kernel/PID1 rows are valid", () => {
  const p = createPeak();
  const stat = (pid, group) => `${pid} (name) S 0 ${group} ${Array(16).fill("0").join(" ")} 1 0 0`;
  const result = readRows(p, { list: () => ["1", "2", "10"], stat: (pid) => pid === "10" ? "10 (truncated)" : stat(pid, 0) });
  assert.equal(result.complete, false);
  assert.deepEqual(result.rows.map((r) => r.pid), [1, 2]);
  assert.equal(p.readErrors, 1);
});


test("public high-water corroboration is numeric, bounded, and retains the largest values", () => {
  const p = createPeak();
  recordPeak(p, Array.from({ length: 140 }, (_, i) => row(i + 10, 1, 10, i, 100, 100 + i)), 1);
  const summary = publicPeak(p);
  assert.equal(summary.observedProcessHighWaters.length, 128);
  assert.deepEqual(summary.observedProcessHighWaters[0], { pid: 149, start: 139, hwmBytes: 239 });
  assert.equal(summary.omittedProcessHighWaters, 12);
  assert.equal("highWaters" in summary, false);
});


test("malformed or overflowing compile durations are unavailable rather than a successful null reading", () => {
  assert.equal(firstCompile("GET /connectors 200 in ...s (compile: ...s)"), null);
  assert.equal(firstCompile(`GET /connectors 200 in 1s (compile: ${"9".repeat(400)}s)`), null);
});

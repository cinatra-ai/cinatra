import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createPeak, recordPeak, parseProcStat, selectOwned, stopOwned, firstCompile, readingUnderLimit, withServerCleanup, sameRun, readRows, publicPeak, sample, cleanupIo, openStatReader } from "../dev-hmr-smoke/server-monitor.mjs";

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
  // The matched main baseline plus 20% is the exact decimal-byte boundary.
  recordPeak(p, [row(10, 1, 10, 1, 22_040_518_656)], 0);
  assert.equal(readingUnderLimit(p), false);
  const q = createPeak();
  recordPeak(q, [row(10, 1, 10, 1, 22_040_518_655)], 0);
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

const statText = (p) => `${p.pid} (command deliberately never published) ${p.state} ${p.ppid} ${p.group} ${Array(16).fill("0").join(" ")} ${p.start} 0 0`;
const ownership = () => ({ group: 10, known: new Set(["10:1", "11:2"]) });
const statRows = [row(1, 0, 1, 1), row(10, 1, 10, 1), row(11, 10, 10, 2), row(99, 1, 99, 9)];
const memoryRead = () => "MemAvailable: 123456 kB";
// Unit leases model one stat task incarnation; production opens one descriptor.
const leaseStatIo = (io) => ({ ...io, openStat: io.openStat ?? ((name) => ({ read: () => io.stat(name), close: () => {} })) });

test("the valid matched main tree peak fits its measured 20 percent margin without GB rounding", () => {
  const p = createPeak();
  recordPeak(p, [row(11, 10, 10, 2, 18_367_098_880)], 1);
  assert.equal(readingUnderLimit(p), true);
  recordPeak(p, [row(11, 10, 10, 2, 22_040_518_656)], 2);
  assert.equal(readingUnderLimit(p), false);
});

test("a stat error proven outside the tree is recorded separately and cannot invalidate the tree reading", () => {
  const peak = createPeak();
  const reads = new Map<string, number>();
  const inventory = readRows(peak, leaseStatIo({
    list: () => statRows.map((p) => String(p.pid)),
    stat: (name) => {
      const count = reads.get(name) ?? 0; reads.set(name, count + 1);
      if (name === "99" && count === 0) throw Object.assign(new Error("private path and environment"), { code: "EACCES" });
      return statText(statRows.find((p) => String(p.pid) === name)!);
    },
  }), ownership());
  assert.equal(inventory.complete, true);
  assert.equal(peak.readErrors, 0);
  assert.equal(peak.outsideTreeReadErrors, 1);
  assert.deepEqual(peak.readErrorReasons.map(({ site, code, pid, owned }) => ({ site, code, pid, owned })), [
    { site: "stat-scan", code: "EACCES", pid: 99, owned: false },
  ]);
  recordPeak(peak, [row(11, 10, 10, 2, 1000)], 1);
  assert.equal(readingUnderLimit(peak), true);
  assert.equal(JSON.stringify(publicPeak(peak)).includes("private path"), false);
  assert.equal(JSON.stringify(publicPeak(peak)).includes("command deliberately"), false);
});

test("recovered owned, unresolved identity and unresolved ancestor stat errors stay invalidating", () => {
  for (const mode of ["owned", "identity", "ancestor"] as const) {
    const peak = createPeak();
    let failedReads = 0;
    const failingPid = mode === "owned" ? 11 : 99;
    const inventory = readRows(peak, leaseStatIo({
      list: () => statRows.map((p) => String(p.pid)),
      stat: (name) => {
        if (Number(name) === failingPid && (failedReads++ === 0 || mode === "identity")) throw Object.assign(new Error("do not log me"), { code: "EIO" });
        const p = statRows.find((r) => String(r.pid) === name)!;
        return statText(mode === "ancestor" && p.pid === 99 ? { ...p, ppid: 888 } : p);
      },
    }), ownership());
    assert.equal(inventory.complete, false, mode);
    assert.equal(peak.readErrors, 1, mode);
    assert.equal(peak.outsideTreeReadErrors, 0, mode);
    assert.equal(peak.readErrorReasons[0].owned, mode === "owned" ? true : null, mode);
    recordPeak(peak, [row(11, 10, 10, 2, 1)], 1);
    assert.equal(readingUnderLimit(peak), null, mode);
  }
});

test("a recovered stat's parse-null reason and conservative unanchored group ownership are explicit", () => {
  const peak = createPeak();
  let reads = 0;
  const inventory = readRows(peak, leaseStatIo({
    list: () => ["99"],
    stat: () => reads++ === 0 ? "malformed secret text" : statText(row(99, 1, 10, 9)),
  }), ownership());
  assert.equal(inventory.complete, false);
  assert.equal(peak.readErrors, 1);
  assert.equal(peak.outsideTreeReadErrors, 0);
  assert.equal(peak.readErrorReasons[0].code, "parse-null");
  assert.equal(peak.readErrorReasons[0].owned, null);
  assert.equal(JSON.stringify(publicPeak(peak)).includes("malformed secret"), false);
});

test("listing failures retain a sanitized reason and cannot certify cleanup", () => {
  for (const code of ["private-code-containing-key", "EPRIVATESECRET"]) {
    const peak = createPeak();
    const inventory = readRows(peak, leaseStatIo({
      list: () => { throw Object.assign(new Error("secret listing path"), { code }); },
      stat: () => assert.fail("must not read when listing failed"),
    }), ownership());
    assert.equal(inventory.complete, false);
    assert.equal(peak.readErrors, 1);
    assert.deepEqual(peak.readErrorReasons.map(({ site, code, pid, owned }) => ({ site, code, pid, owned })), [
      { site: "list", code: "unknown", pid: null, owned: null },
    ]);
    assert.equal(JSON.stringify(publicPeak(peak)).includes("secret"), false);
    assert.equal(JSON.stringify(publicPeak(peak)).includes("private-code"), false);
    assert.equal(JSON.stringify(publicPeak(peak)).includes("EPRIVATESECRET"), false);
  }
});

test("owned status and meminfo failures remain explicit invalid reads while exit races do not", () => {
  for (const failure of ["owned-status", "meminfo", "exit-race"] as const) {
    const state = { group: 10, known: ["10:1", "11:2"], peak: createPeak() };
    sample(state, new Set(state.known), leaseStatIo({
      list: () => statRows.map((p) => String(p.pid)),
      stat: (name) => statText(statRows.find((p) => String(p.pid) === name)!),
      status: () => {
        if (failure !== "meminfo") throw Object.assign(new Error("do not publish exception"), { code: failure === "exit-race" ? "ENOENT" : "EPERM" });
        return "VmRSS: 10 kB\nVmHWM: 12 kB\n";
      },
      meminfo: () => failure === "meminfo" ? "private malformed meminfo" : memoryRead(), now: () => 1,
    }));
    assert.equal(state.peak.outsideTreeReadErrors, 0);
    if (failure === "exit-race") {
      assert.equal(state.peak.readErrors, 0);
      assert.equal(state.peak.exitRaces, 1);
      assert.equal(state.peak.readErrorReasons.length, 0);
    } else {
      assert.equal(state.peak.readErrors, 1);
      assert.equal(state.peak.readErrorReasons[0].site, failure);
      assert.equal(state.peak.readErrorReasons[0].owned, failure === "owned-status" ? true : null);
    }
    assert.equal(readingUnderLimit(state.peak), null);
  }
});

test("teardown signal errors remain invalidating and expose no exception text", () => {
  const state = { group: 10, known: ["10:1", "11:2"], peak: createPeak() };
  recordPeak(state.peak, [row(11, 10, 10, 2, 1)], 1);
  const io = cleanupIo(state, {
    stat: () => row(11, 10, 10, 2),
    signal: () => { throw Object.assign(new Error("private signal target"), { code: "EPERM" }); },
  });
  io.signal(11, "SIGTERM");
  assert.equal(state.peak.readErrors, 1);
  assert.equal(state.peak.outsideTreeReadErrors, 0);
  assert.equal(state.peak.readErrorReasons[0].site, "signal");
  assert.equal(state.peak.readErrorReasons[0].owned, true);
  assert.equal(readingUnderLimit(state.peak), null);
  assert.equal(JSON.stringify(publicPeak(state.peak)).includes("private signal"), false);
});

test("a recovered reused PID cannot recast a previously owned read failure as outside-tree", () => {
  const peak = createPeak();
  let failed = false;
  const inventory = readRows(peak, leaseStatIo({
    list: () => ["1", "10", "11"],
    stat: (name) => {
      if (name === "11" && !failed) { failed = true; throw Object.assign(new Error("private"), { code: "EACCES" }); }
      return statText(name === "11" ? row(11, 1, 99, 99) : statRows.find((p) => String(p.pid) === name)!);
    },
  }), ownership());
  assert.equal(inventory.complete, false);
  assert.equal(peak.readErrors, 1);
  assert.equal(peak.outsideTreeReadErrors, 0);
  assert.equal(peak.readErrorReasons[0].owned, null);
});

test("a complete sample with an outside stat error retains its valid tree and headroom reading", () => {
  const state = { group: 10, known: ["10:1", "11:2"], peak: createPeak() };
  let failed = false;
  sample(state, new Set(state.known), leaseStatIo({
    list: () => statRows.map((p) => String(p.pid)),
    stat: (name) => {
      if (name === "99" && !failed) { failed = true; throw Object.assign(new Error("private"), { code: "EACCES" }); }
      return statText(statRows.find((p) => String(p.pid) === name)!);
    },
    status: () => "VmRSS: 1000 kB\nVmHWM: 2000 kB\n", meminfo: memoryRead, now: () => 1,
  }));
  assert.equal(state.peak.samples, 1);
  assert.equal(state.peak.sampledProcessTreePeakBytes, 1_024_000);
  assert.equal(state.peak.lowestRunnerMemAvailableBytes, 123456 * 1024);
  assert.equal(state.peak.outsideTreeReadErrors, 1);
  assert.equal(state.peak.readErrors, 0);
  assert.equal(readingUnderLimit(state.peak), true);
});

test("owned-stat failures, meminfo read failures and teardown identity failures are separately named", () => {
  for (const failure of ["owned-stat", "meminfo"] as const) {
    const state = { group: 10, known: ["10:1", "11:2"], peak: createPeak() };
    let ownedReads = 0;
    sample(state, new Set(state.known), leaseStatIo({
      list: () => statRows.map((p) => String(p.pid)),
      stat: (name) => {
        if (failure === "owned-stat" && name === "11" && ownedReads++ > 0) throw Object.assign(new Error("private"), { code: "EIO" });
        return statText(statRows.find((p) => String(p.pid) === name)!);
      },
      status: () => "VmRSS: 10 kB\nVmHWM: 12 kB\n",
      meminfo: () => { if (failure === "meminfo") throw Object.assign(new Error("private"), { code: "EIO" }); return memoryRead(); }, now: () => 1,
    }));
    assert.equal(state.peak.readErrors, 1);
    assert.equal(state.peak.readErrorReasons[0].site, failure);
    assert.equal(state.peak.readErrorReasons[0].code, "EIO");
    assert.equal(readingUnderLimit(state.peak), null);
  }
  const state = { group: 10, known: ["10:1", "11:2"], peak: createPeak() };
  const io = cleanupIo(state, { stat: () => null, signal: () => assert.fail("missing identity must not signal") });
  io.signal(11, "SIGTERM");
  assert.equal(state.peak.readErrors, 1);
  assert.equal(state.peak.readErrorReasons[0].site, "signal-stat");
  assert.equal(state.peak.readErrorReasons[0].code, "parse-null");
  assert.equal(state.peak.readErrorReasons[0].owned, null);
});

test("reason records stay bounded while every outside-tree failure remains counted", () => {
  const peak = createPeak();
  const seen = new Set<string>();
  const rows = [...statRows.slice(0, 2), ...Array.from({ length: 130 }, (_, i) => row(100 + i, 1, 100 + i, i + 1))];
  readRows(peak, leaseStatIo({
    list: () => rows.map((p) => String(p.pid)),
    stat: (name) => {
      if (Number(name) >= 100 && !seen.has(name)) { seen.add(name); throw Object.assign(new Error("private"), { code: "EIO" }); }
      return statText(rows.find((p) => String(p.pid) === name)!);
    },
  }), ownership());
  const summary = publicPeak(peak);
  assert.equal(summary.outsideTreeReadErrors, 130);
  assert.equal(summary.readErrors, 0);
  assert.equal(summary.readErrorReasons.length, 128);
  assert.equal(summary.omittedReadErrorReasons, 2);
});

test("an exited task's descriptor cannot recover a replacement PID as an outside-tree process", () => {
  const peak = createPeak();
  let replacementPathReads = 0;
  const closed: string[] = [];
  const inventory = readRows(peak, leaseStatIo({
    list: () => ["1", "10", "99"],
    stat: (name) => { replacementPathReads++; return statText(statRows.find((p) => String(p.pid) === name)!); },
    openStat: (name) => {
      let reads = 0;
      return {
        read: () => {
          if (name === "99") throw Object.assign(new Error("private descriptor"), { code: reads++ === 0 ? "EIO" : "ESRCH" });
          return statText(statRows.find((p) => String(p.pid) === name)!);
        },
        close: () => closed.push(name),
      };
    },
  }), ownership());
  assert.equal(replacementPathReads, 0);
  assert.equal(inventory.complete, false);
  assert.equal(peak.readErrors, 1);
  assert.equal(peak.outsideTreeReadErrors, 0);
  assert.equal(peak.readErrorReasons[0].owned, null);
  assert.equal(peak.readErrorReasons[0].code, "EIO");
  assert.deepEqual(closed, ["1", "10", "99"]);
});

test("every opened inventory descriptor is closed after valid, malformed, failed and racing reads", () => {
  for (const mode of ["valid", "parse-null", "read-error", "exit-race"] as const) {
    const peak = createPeak();
    let opens = 0;
    let closes = 0;
    readRows(peak, leaseStatIo({
      list: () => ["99"],
      stat: () => statText(row(99, 1, 99, 9)),
      openStat: () => {
        opens++;
        return {
          read: () => {
            if (mode === "read-error" || mode === "exit-race") throw Object.assign(new Error("private"), { code: mode === "read-error" ? "EIO" : "ENOENT" });
            return mode === "parse-null" ? "malformed" : statText(row(99, 1, 99, 9));
          },
          close: () => { closes++; },
        };
      },
    }), ownership());
    assert.equal(opens, 1, mode);
    assert.equal(closes, 1, mode);
  }
});

test("a real descriptor read error cannot reopen a replaced pathname and misclassify an owned identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-stat-fd-"));
  const path = join(dir, "stat");
  writeFileSync(path, statText(row(99, 10, 10, 3)));
  let fd: number | null = null;
  let opens = 0;
  let closed = false;
  let reads = 0;
  try {
    const peak = createPeak();
    const inventory = readRows(peak, {
      list: () => ["1", "10", "99"],
      stat: () => assert.fail("must not reopen the replaced path"),
      openStat: (name) => name !== "99" ? {
        read: () => statText(statRows.find((p) => String(p.pid) === name)!), close: () => {},
      } : openStatReader(name, {
        open: () => { opens++; fd = openSync(path, "r"); return fd; },
        read: (descriptor, buffer, offset, length, position) => {
          assert.equal(position, 0);
          if (reads++ === 0) {
            unlinkSync(path);
            writeFileSync(path, statText(row(99, 1, 99, 99)));
            throw Object.assign(new Error("synthetic read failure"), { code: "EIO" });
          }
          return readSync(descriptor, buffer, offset, length, position);
        },
        close: (descriptor) => { closeSync(descriptor); closed = true; },
      }),
    }, ownership());
    assert.equal(opens, 1);
    assert.equal(reads, 2);
    assert.equal(closed, true);
    assert.equal(inventory.complete, false);
    assert.equal(peak.readErrors, 1);
    assert.equal(peak.outsideTreeReadErrors, 0);
    assert.equal(peak.readErrorReasons[0].owned, true);
    assert.equal(inventory.rows.find((p) => p.pid === 99)?.start, 3);
    assert.throws(() => readSync(fd!, Buffer.alloc(1), 0, 1, 0), { code: "EBADF" });
  } finally {
    if (fd !== null && !closed) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inventory OPEN failure or a path-only reader has no stable outside-tree identity", () => {
  for (const mode of ["open-failure", "path-only"] as const) {
    const peak = createPeak();
    let pathReads = 0;
    const io = {
      list: () => ["99"],
      stat: () => { pathReads++; if (pathReads === 1) throw Object.assign(new Error("private"), { code: "EACCES" }); return statText(row(99, 1, 99, 9)); },
      ...(mode === "open-failure" ? { openStat: () => { throw Object.assign(new Error("private"), { code: "EACCES" }); } } : {}),
    };
    assert.equal(readRows(peak, io, ownership()).complete, false);
    assert.equal(peak.readErrors, 1);
    assert.equal(peak.outsideTreeReadErrors, 0);
    assert.equal(peak.readErrorReasons[0].owned, null);
    assert.equal(peak.readErrorReasons[0].site, mode === "open-failure" ? "stat-open" : "stat-scan");
    assert.equal(pathReads, mode === "open-failure" ? 0 : 1);
  }
});

test("oversized descriptor data and descriptor-close failures remain explicit invalid reads", () => {
  for (const mode of ["overflow", "close-error"] as const) {
    const peak = createPeak();
    let closes = 0;
    const inventory = readRows(peak, {
      list: () => ["99"],
      openStat: () => openStatReader("99", {
        open: () => 42,
        read: (_, buffer) => mode === "overflow" ? buffer.length : buffer.write(statText(row(99, 1, 99, 9))),
        close: () => { closes++; if (mode === "close-error") throw Object.assign(new Error("private close details"), { code: "EIO" }); },
      }),
    }, ownership());
    assert.equal(inventory.complete, false);
    assert.equal(closes, 1);
    assert.equal(peak.readErrors, 1);
    assert.equal(peak.outsideTreeReadErrors, 0);
    assert.equal(peak.readErrorReasons[0].site, mode === "overflow" ? "stat-scan" : "stat-close");
    assert.equal(peak.readErrorReasons[0].code, mode === "overflow" ? "EOVERFLOW" : "EIO");
    recordPeak(peak, [row(11, 10, 10, 2, 1)], 1);
    assert.equal(readingUnderLimit(peak), null);
  }
});

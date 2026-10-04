// Linux workflow-only supervisor. No command arguments or environment values are
// sampled. RSS sums can count shared pages twice; observations are not an exact
// kernel counter for the whole tree. A child that starts and exits (or escapes
// its group before discovery) between scans can be missed. Keep that limitation
// in the reading: neither sampled maxima nor observed HWM sums prove a true peak.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";

const INTERVAL_MS = 100;
// Matched main's valid sampled tree peak (18_367_098_880 bytes) plus 20%.
// Keep the exact decimal-byte result; neither GB/GiB rounding nor HWM sums.
const LIMIT_BYTES = 22_040_518_656;
const LIFETIME_MS = 18 * 60_000; // readiness (5m) + walk step (12m) + cleanup
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const key = (p) => `${p.pid}:${p.start}`;
const REASON_CODES = new Set([...Object.keys(constants.errno), "parse-null", "scan-limit", "supervisor-incomplete"]);

export function parseProcStat(text) {
  const end = text.lastIndexOf(") ");
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const [state, ppid, group, start] = [fields[0], Number(fields[1]), Number(fields[2]), Number(fields[19])];
  return end > 0 && [pid, ppid, group, start].every(Number.isSafeInteger) && pid > 0 && ppid >= 0 && group >= 0 && start >= 0 && /^[A-Za-z]$/.test(state)
    ? { pid, ppid, group, start, state } : null;
}

export function selectOwned(rows, group, known) {
  // A live, previously observed identity anchors group ownership even after the
  // leader exits. Never signal a newly reused group/PID on its number alone.
  const anchored = rows.some((p) => p.group === group && known.has(key(p)));
  const owned = new Map(rows.filter((p) => known.has(key(p)) || (anchored && p.group === group)).map((p) => [p.pid, p]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of rows) if (!owned.has(p.pid) && owned.has(p.ppid)) { owned.set(p.pid, p); changed = true; }
  }
  return [...owned.values()].filter((p) => p.state !== "Z");
}

export function createPeak() {
  return { samples: 0, firstSampleAtMs: null, lastSampleAtMs: null, maxSampleGapMs: 0, maxScanDurationMs: 0,
    readErrors: 0, outsideTreeReadErrors: 0, readErrorReasons: [], omittedReadErrorReasons: 0,
    exitRaces: 0, emptySamples: 0, sampledProcessTreePeakBytes: null, lowestRunnerMemAvailableBytes: null,
    largestObservedProcessHwmBytes: null, observedProcessHwmSumBytes: null, observedProcessCount: 0, highWaters: {} };
}

function readError(peak, site, code, pid = null, owned = null) {
  // No exception message, path, command or environment can reach the reading.
  const safeCode = REASON_CODES.has(code) ? code : "unknown";
  const reason = { site, code: safeCode, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, owned };
  // Only an inventory error with positive exclusion proof is non-invalidating.
  // Listing, owned reads, meminfo and teardown always stay conservative.
  if (site === "stat-scan" && owned === false) peak.outsideTreeReadErrors++;
  else peak.readErrors++;
  if (peak.readErrorReasons.length < 128) peak.readErrorReasons.push(reason);
  else peak.omittedReadErrorReasons++;
}

/** @param {number | null} [availableBytes] */
export function recordPeak(peak, rows, now, availableBytes = null) {
  if (availableBytes !== null) peak.lowestRunnerMemAvailableBytes = Math.min(peak.lowestRunnerMemAvailableBytes ?? availableBytes, availableBytes);
  if (!rows.length) { peak.emptySamples++; return; }
  if (peak.lastSampleAtMs !== null) peak.maxSampleGapMs = Math.max(peak.maxSampleGapMs, now - peak.lastSampleAtMs);
  peak.firstSampleAtMs ??= now;
  peak.lastSampleAtMs = now;
  peak.samples++;
  peak.sampledProcessTreePeakBytes = Math.max(peak.sampledProcessTreePeakBytes ?? 0, rows.reduce((sum, p) => sum + p.rssBytes, 0));
  for (const p of rows) peak.highWaters[key(p)] = Math.max(peak.highWaters[key(p)] ?? 0, p.hwmBytes);
  const waters = Object.values(peak.highWaters);
  peak.observedProcessHwmSumBytes = waters.reduce((sum, n) => sum + n, 0);
  peak.largestObservedProcessHwmBytes = Math.max(...waters);
  peak.observedProcessCount = waters.length;
}

export function publicPeak(peak) {
  const summary = { ...peak };
  delete summary.highWaters;
  const marks = Object.entries(peak.highWaters).map(([identity, hwmBytes]) => {
    const [pid, start] = identity.split(":").map(Number);
    return { pid, start, hwmBytes };
  }).sort((a, b) => b.hwmBytes - a.hwmBytes);
  return { ...summary, observedProcessHighWaters: marks.slice(0, 128), omittedProcessHighWaters: Math.max(0, marks.length - 128) };
}

export function readingUnderLimit(peak) {
  if (!peak.samples || peak.readErrors) return null;
  // The observed sum is intentionally separate: it is NOT a simultaneous peak.
  return peak.sampledProcessTreePeakBytes < LIMIT_BYTES;
}

export function firstCompile(log) {
  const first = /(?:^|\n)\s*GET \/connectors \d{3}[^\n]*/.exec(log.replace(/\u001b\[[0-9;]*m/g, ""));
  if (!first) return null;
  const match = /(?:^|\n)\s*GET \/connectors (\d{3}) in (\d+(?:\.\d+)?)(ms|s|min)\s*\([^\n]*?(?:next\.js|compile): (\d+(?:\.\d+)?)(ms|s|min)/.exec(first[0]);
  if (!match) return null;
  const ms = (value, unit) => Number(value) * ({ ms: 1, s: 1000, min: 60000 }[unit]);
  const firstRouteElapsedMs = ms(match[2], match[3]);
  const firstRouteCompileMs = ms(match[4], match[5]);
  if (![firstRouteElapsedMs, firstRouteCompileMs].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return { firstRouteStatus: Number(match[1]), firstRouteElapsedMs, firstRouteCompileMs };
}

export function openStatReader(name, io = { open: openSync, read: readSync, close: closeSync }) {
  const fd = io.open(`/proc/${name}/stat`, "r");
  return {
    read: () => {
      const buffer = Buffer.alloc(4096);
      const size = io.read(fd, buffer, 0, buffer.length, 0);
      if (size === buffer.length) throw Object.assign(new Error("stat-exceeds-read-bound"), { code: "EOVERFLOW" });
      return buffer.subarray(0, size).toString();
    },
    close: () => io.close(fd),
  };
}

const sampleIo = {
  list: () => readdirSync("/proc"), stat: (name) => readFileSync(`/proc/${name}/stat`, "utf8"),
  openStat: openStatReader,
  status: (name) => readFileSync(`/proc/${name}/status`, "utf8"),
  meminfo: () => readFileSync("/proc/meminfo", "utf8"), now: Date.now,
};

function errorOwnership(row, rows, { group, known } = {}) {
  if (!row || !Number.isSafeInteger(group) || !(known instanceof Set)) return null;
  const owned = new Set(selectOwned(rows, group, known).map((p) => p.pid));
  if (owned.has(row.pid)) return true;
  // A failed read may have belonged to the previous incarnation. Recovered
  // metadata for a reused, previously owned PID cannot clear that uncertainty.
  if ([...known].some((identity) => identity.startsWith(`${row.pid}:`))) return null;
  // A missing identity, lost anchor or missing ancestor cannot prove exclusion.
  if (!rows.some((p) => known.has(key(p)))) return null;
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const visited = new Set();
  for (let current = row; current && !visited.has(current.pid); current = byPid.get(current.ppid)) {
    visited.add(current.pid);
    if (owned.has(current.pid) || known.has(key(current))) return true;
    if (current.group === group) return null;
    if (current.ppid === 0) return false;
  }
  return null;
}

export function readRows(peak, io = sampleIo, ownership = {}) {
  const rows = [];
  const failures = [];
  let complete = true;
  let names;
  try { names = io.list().filter((s) => /^\d+$/.test(s)); }
  catch (error) { readError(peak, "list", error.code); return { rows, complete: false }; }
  if (names.length > 8192) { readError(peak, "list", "scan-limit"); complete = false; }
  for (const name of names.slice(0, 8192)) {
    let reader;
    try {
      reader = io.openStat ? io.openStat(name) : { read: () => io.stat(name), close: () => {} };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") { readError(peak, "stat-open", error.code, Number(name)); complete = false; }
      continue;
    }
    try {
      let code;
      try {
        const row = parseProcStat(reader.read());
        if (row && row.pid === Number(name)) { rows.push(row); continue; }
        code = "parse-null";
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ESRCH") continue;
        code = error.code;
      }
      // A /proc descriptor stays tied to its task even after numeric PID reuse:
      // https://docs.kernel.org/filesystems/proc.html (process-specific entries).
      // Retry this same descriptor, never a replacement process's pathname. A
      // path-only injected reader cannot establish this identity and stays unknown.
      let recovered = null;
      if (io.openStat) {
        try { recovered = parseProcStat(reader.read()); } catch { /* Unknown remains invalidating. */ }
      }
      if (recovered?.pid !== Number(name)) recovered = null;
      if (recovered) rows.push(recovered);
      failures.push({ pid: Number(name), code, recovered });
    } finally {
      try { reader.close(); }
      catch (error) { readError(peak, "stat-close", error.code, Number(name)); complete = false; }
    }
  }
  for (const failure of failures) {
    const owned = errorOwnership(failure.recovered, rows, ownership);
    readError(peak, "stat-scan", failure.code, failure.pid, owned);
    if (owned !== false) complete = false;
  }
  return { rows, complete };
}

export function sample(state, known, io = sampleIo) {
  const started = io.now();
  let inventory = { rows: [], complete: false };
  try {
    inventory = readRows(state.peak, io, { group: state.group, known });
    const owned = selectOwned(inventory.rows, state.group, known).filter((p) => p.pid !== state.group);
    const readings = [];
    for (const p of owned) {
      known.add(key(p));
      let site = "owned-status";
      try {
        const status = io.status(String(p.pid));
        site = "owned-stat";
        const current = parseProcStat(io.stat(String(p.pid)));
        if (!current || key(current) !== key(p)) { state.peak.exitRaces++; continue; }
        const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
        const hwm = /^VmHWM:\s+(\d+) kB$/m.exec(status);
        if (!rss || !hwm) { state.peak.exitRaces++; continue; }
        const rssBytes = Number(rss[1]) * 1024;
        const hwmBytes = Number(hwm[1]) * 1024;
        if (![rssBytes, hwmBytes].every(Number.isSafeInteger)) { readError(state.peak, "owned-status", "parse-null", p.pid, true); continue; }
        readings.push({ ...p, rssBytes, hwmBytes });
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ESRCH") state.peak.exitRaces++;
        else readError(state.peak, site, error.code, p.pid, true);
      }
    }
    let availableBytes = null;
    try {
      const available = /^MemAvailable:\s+(\d+) kB$/m.exec(io.meminfo());
      if (available && Number.isSafeInteger(Number(available[1]) * 1024)) availableBytes = Number(available[1]) * 1024;
      else readError(state.peak, "meminfo", "parse-null");
    } catch (error) { readError(state.peak, "meminfo", error.code); }
    recordPeak(state.peak, readings, io.now(), availableBytes);
  } catch (error) { readError(state.peak, "sample", error.code); }
  state.peak.maxScanDurationMs = Math.max(state.peak.maxScanDurationMs, io.now() - started);
  state.known = [...known];
  return inventory;
}

export async function stopOwned(group, known, io) {
  const started = io.now();
  const sent = new Set();
  while (io.now() - started <= 10000) {
    const inventory = io.read();
    const rows = selectOwned(inventory.rows, group, known).filter((p) => p.pid !== io.excludePid);
    const unownedGroupMembers = inventory.rows.some((p) => p.group === group && p.pid !== io.excludePid && p.state !== "Z" && !rows.some((r) => r.pid === p.pid));
    if (!rows.length && inventory.complete && !unownedGroupMembers) return true;
    const signal = io.now() - started < 5000 ? "SIGTERM" : "SIGKILL";
    for (const p of rows) {
      known.add(key(p));
      const id = `${key(p)}:${signal}`;
      if (!sent.has(id)) { io.signal(p.pid, signal); sent.add(id); }
    }
    if (io.now() - started >= 10000) break;
    await io.sleep(100);
  }
  return false;
}

export async function withServerCleanup(action, cleanup) {
  try { return await action(); } finally { await cleanup(); }
}

export function sameRun(stored, run) {
  return stored?.runId === run.runId && stored?.attempt === run.attempt && stored?.sha === run.sha;
}

function attribution() {
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const sha = process.env.GITHUB_SHA;
  if (!/^\d+$/.test(runId ?? "") || !/^\d+$/.test(attempt ?? "") || !/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("missing-run-attribution");
  return { runId, attempt, sha };
}
const ownStat = (pid) => parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
function save(path, state) { writeFileSync(`${path}.new`, JSON.stringify(state)); renameSync(`${path}.new`, path); }
export function cleanupIo(state, io = { stat: ownStat, signal: (pid, signal) => process.kill(pid, signal) }) {
  return { now: Date.now, sleep, excludePid: state.group, read: () => sample(state, new Set(state.known)), signal: (pid, signal) => {
    // Re-read starttime immediately before signaling; never use a stale PID.
    let current;
    try { current = io.stat(pid); }
    catch (error) { if (error.code !== "ESRCH" && error.code !== "ENOENT") readError(state.peak, "signal-stat", error.code, pid); return; }
    if (!current) { readError(state.peak, "signal-stat", "parse-null", pid); return; }
    if (!state.known.includes(key(current))) return;
    try { io.signal(pid, signal); }
    catch (error) { if (error.code !== "ESRCH" && error.code !== "ENOENT") readError(state.peak, "signal", error.code, pid, true); }
  } };
}
function readCompile(logPath) {
  const fd = openSync(logPath, "r");
  try { const buffer = Buffer.alloc(32 * 1024 * 1024); return firstCompile(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString()); }
  finally { closeSync(fd); }
}

async function main(command) {
  const run = attribution();
  const dir = `/tmp/dev-hmr-${run.runId}-${run.attempt}`;
  const path = `${dir}/state.json`;
  const stop = `${dir}/stop`;
  const logPath = process.env.DEV_SERVER_LOG;
  if (!logPath) throw new Error("missing-server-log-path");
  if (command === "start") {
    // Exclusive fresh directory: a repeated start cannot overwrite an active
    // process identity or present an earlier attempt's reading as this run's.
    mkdirSync(dir, { mode: 0o700 });
    const fd = openSync(`${dir}/monitor.log`, "w", 0o600);
    const monitor = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise"], { detached: true, stdio: ["ignore", fd, fd] });
    monitor.unref(); closeSync(fd);
    const deadline = Date.now() + 5000;
    while (!existsSync(path) && Date.now() < deadline) await sleep(50);
    if (!existsSync(path)) throw new Error("monitor-start-timeout");
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (!sameRun(state, run)) throw new Error("monitor-attribution-mismatch");
    if (state.complete || !state.serverPid) throw new Error("server-unavailable-during-start");
    console.log(`[hmr-smoke-monitor] ${JSON.stringify({ ...run, serverPid: state.serverPid, intervalMs: INTERVAL_MS })}`);
    return;
  }
  if (command === "supervise") {
    // This detached supervisor holds the group identity for the entire walk.
    // pnpm shares its group; exiting pnpm cannot orphan an unanchored group.
    const root = ownStat(process.pid);
    if (!root || root.group !== process.pid) throw new Error("monitor-group-unavailable");
    const state = { ...run, group: root.pid, serverPid: null, known: [key(root)], peak: createPeak(), monitoringStartedAtMs: Date.now(), monitoringFinishedAtMs: null, complete: false, teardownComplete: false, lifetimeExpired: false };
    const known = new Set(state.known);
    let requested = false;
    process.on("SIGTERM", () => { requested = true; });
    process.on("SIGINT", () => { requested = true; });
    const deadline = Date.now() + LIFETIME_MS;
    await withServerCleanup(async () => {
      const fd = openSync(logPath, "w", 0o600);
      let server;
      try { server = spawn("pnpm", ["dev"], { stdio: ["ignore", fd, fd] }); }
      finally { closeSync(fd); }
      server.on("error", (error) => { readError(state.peak, "spawn", error.code, state.serverPid, true); requested = true; });
      server.unref();
      state.serverPid = server.pid ?? null;
      if (!state.serverPid) throw new Error("server-spawn-unavailable");
      writeFileSync("/tmp/dev-hmr.pid", String(state.serverPid));
      do {
        const cycleStarted = Date.now();
        sample(state, known); save(path, state);
        if (requested || existsSync(stop)) break;
        await sleep(Math.max(0, INTERVAL_MS - (Date.now() - cycleStarted)));
      } while (Date.now() < deadline);
      state.lifetimeExpired = Date.now() >= deadline;
    }, async () => {
      state.teardownComplete = await stopOwned(state.group, known, cleanupIo(state));
      sample(state, known);
      state.complete = true;
      state.monitoringFinishedAtMs = Date.now();
      save(path, state);
    });
    return;
  }
  if (command === "stop") {
    if (!existsSync(path)) throw new Error("monitor-state-unavailable");
    let state = JSON.parse(readFileSync(path, "utf8"));
    if (!sameRun(state, run)) throw new Error("monitor-attribution-mismatch");
    writeFileSync(stop, "stop");
    const deadline = Date.now() + 15000;
    do { state = JSON.parse(readFileSync(path, "utf8")); if (!sameRun(state, run)) throw new Error("monitor-attribution-mismatch"); if (state.complete) break; await sleep(100); } while (Date.now() < deadline);
    if (!state.complete) {
      // Supervisor failure still gets bounded teardown using its last recorded
      // identities. Missing final observations remain an explicit invalid read.
      readError(state.peak, "stop-timeout", "supervisor-incomplete");
      state.teardownComplete = await stopOwned(state.group, new Set(state.known), cleanupIo(state));
    }
    let compile = null;
    try { compile = readCompile(logPath); } catch { /* missing compile is explicit */ }
    const peak = publicPeak(state.peak);
    console.log(`[hmr-smoke-peak] ${JSON.stringify({ ...run, ...peak, intervalMs: INTERVAL_MS, limitBytes: LIMIT_BYTES,
      sampledPeakUnderLimit: readingUnderLimit(state.peak), exactTreePeakEstablished: false,
      method: "sampled observed server-tree RSS; shared pages can repeat; children exiting or escaping before discovery can be missed",
      observedHwmSumOverLimit: state.peak.observedProcessHwmSumBytes !== null && state.peak.observedProcessHwmSumBytes >= LIMIT_BYTES,
      firstRoute: compile, monitoringStartedAtMs: state.monitoringStartedAtMs, monitoringFinishedAtMs: state.monitoringFinishedAtMs, complete: state.complete, teardownComplete: state.teardownComplete, lifetimeExpired: state.lifetimeExpired })}`);
    if (!state.complete || !state.teardownComplete || state.lifetimeExpired || !compile || readingUnderLimit(state.peak) !== true) process.exitCode = 1;
    return;
  }
  throw new Error("unknown-monitor-command");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(() => { console.error("[hmr-smoke-monitor] operation-failed"); process.exitCode = 1; });
}

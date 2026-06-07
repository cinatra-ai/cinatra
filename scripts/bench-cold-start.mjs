// bench-cold-start.mjs — dynamic dev-compile benchmark.
//
// SECONDARY metric (the static scripts/route-graph.mjs count is PRIMARY). Boots
// the worktree dev server, triggers first-compile on a FIXED route set, and reads
// the per-route `compile-path` span from `.next/dev/trace` as the honest COMPILE
// metric. Wall-clock-to-response is recorded SEPARATELY and never used for
// acceptance: /api/mcp's compile finishes in ~6s but its request then hangs in
// runtime — so once a route's compile-path span lands, we ABORT the request and
// move on (the harness is bounded by compile time, not runtime hangs).
//
// Contract: N>=3 runs report median/min/max; route set LOCKED;
// refuse PORT 3000 without override; clean stop via scripts/dev-stop.mjs between
// runs; fail closed if the port stays bound. Zero deps (node: builtins + du/lsof).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACE = path.join(REPO_ROOT, ".next", "dev", "trace");
const DEFAULT_OUT = path.join(REPO_ROOT, ".planning", "phases", "515-devperf-measurement-harness");

// Dynamically-compilable routes (public or dev-bypass) that reliably compile
// their OWN module on a bare GET. Two classes are deliberately excluded and left
// to the static analyzer (route-graph.mjs), which measures them faithfully:
//   - auth-gated pages (e.g. /configuration/*, /chat) 307 at middleware without
//     a session and never compile.
//   - /api/mcp returns 404 on a bare GET (the MCP handler needs POST/SSE), so
//     Next compiles /_not-found instead of the route — measured here would be
//     misleading. Its 798-module graph is captured statically.
// All three below pull the @/lib/auth → google-oauth barrel chokepoint, so
// they corroborate the static delta. LOCKED set.
const DEFAULT_ROUTES = ["/sign-in", "/api/a2a", "/api/llm-bridge"];

function parseArgs(argv) {
  const a = { mode: "cold", runs: 3, routes: DEFAULT_ROUTES, timeoutMs: 90000, out: DEFAULT_OUT, allow3000: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--mode") a.mode = argv[++i];
    else if (x === "--runs") a.runs = Number(argv[++i]);
    else if (x === "--routes") a.routes = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (x === "--timeout-ms") a.timeoutMs = Number(argv[++i]);
    else if (x === "--out") a.out = argv[++i];
    else if (x === "--allow-port-3000") a.allow3000 = true;
    else if (x === "--help" || x === "-h") a.help = true;
  }
  return a;
}

function usage() {
  console.log(`bench-cold-start.mjs — dynamic dev-compile benchmark (compile-path metric)

  node scripts/bench-cold-start.mjs --mode cold --runs 3   wipe .next before each run (true cold)
  node scripts/bench-cold-start.mjs --mode warm --runs 3   keep cache (warm compiles)
  --routes a,b,c   override route set        --timeout-ms N   per-route bound (default 90000)
  --out <dir>      output dir                --allow-port-3000  override the main-checkout guard

Reads compile-path spans from .next/dev/trace (keyed by tags.trigger). Wall-clock
recorded separately, never used for acceptance. Stops cleanly via dev-stop.mjs.`);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function sh(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function readEnvPort() {
  // Mirror scripts/dev-server.mjs precedence EXACTLY: a real shell PORT wins over
  // .env.local. Otherwise the 3000 guard could pass on a safe .env.local port
  // while the spawned server actually binds shell PORT=3000 (the main checkout).
  if (process.env.PORT) return process.env.PORT;
  const p = path.join(REPO_ROOT, ".env.local");
  if (existsSync(p)) {
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^(?:export\s+)?PORT\s*=\s*['"]?([^'"\s]+)/.exec(raw.trim());
      if (m) return m[1];
    }
  }
  return null;
}

function portListening(port) {
  return sh("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN", "-P", "-n"]).split(/\s+/).filter(Boolean).length > 0;
}

function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  const out = sh("du", ["-sk", dir]).trim().split(/\s+/)[0];
  return out ? Number(out) * 1024 : 0;
}

function nextVersion() {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules", "next", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

// Parse .next/dev/trace (JSON-lines, each line = ARRAY of span objects).
function readTraceSpans() {
  if (!existsSync(TRACE)) return [];
  const spans = [];
  for (const line of readFileSync(TRACE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let arr;
    try {
      arr = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) arr = [arr];
    for (const s of arr) if (s && s.name) spans.push(s);
  }
  return spans;
}

// compile-path duration (µs->ms) for `route`, scoped to spans that STARTED at or
// after `floorMs` (epoch ms). The floor prevents a warm run (which does NOT wipe
// .next) from picking up a STALE compile-path span left by a prior cold run and
// misreporting it as a fresh warm compile. Span.startTime is epoch-ms.
function compilePathMsFor(route, floorMs) {
  let best = null;
  for (const s of readTraceSpans()) {
    if (s.name !== "compile-path" || !s.tags || s.tags.trigger !== route) continue;
    // `<=` (not `<`) is conservative: if a stale span's startTime exactly equals
    // floorMs to the millisecond — rare clock coincidence at ~1ms resolution —
    // the strict-less test would let it through and attribute it as fresh.
    if (typeof floorMs === "number" && typeof s.startTime === "number" && s.startTime <= floorMs) continue;
    const ms = s.duration / 1000;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

function startServer() {
  // stdin kept as an open pipe (never ended) so Next 16 does not exit on EOF.
  const child = spawn("node", ["scripts/dev-server.mjs"], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.on("data", (d) => (buf += d.toString()));
  child.stderr.on("data", (d) => (buf += d.toString()));
  child.on("error", () => {});
  return { child, getLog: () => buf };
}

function devStop() {
  try {
    execFileSync("node", ["scripts/dev-stop.mjs", "--quiet"], { cwd: REPO_ROOT, stdio: "ignore" });
  } catch {
    /* dev-stop exits non-zero on fail-closed; surfaced via portListening check below */
  }
}

// Fire GET {route}; resolve as soon as EITHER the response arrives OR the route's
// compile-path span lands in the trace (+ grace) OR timeout. Abort the request on
// resolve so a runtime hang never blocks the harness.
function requestAndAwaitCompile(port, route, timeoutMs, floorMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let status = null;
    const req = http.get({ host: "127.0.0.1", port, path: route, headers: { "user-agent": "devperf-bench" } }, (res) => {
      status = res.statusCode;
      res.resume();
    });
    req.on("error", () => {});
    const finish = (compiledVia) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      const compileMs = compilePathMsFor(route, floorMs);
      resolve({
        route,
        status,
        compiledVia,
        compiled: compileMs !== null,
        compileMs,
        wallMs: Date.now() - t0,
        timedOut: compiledVia === "timeout" && compileMs === null,
      });
    };
    const poll = setInterval(() => {
      if (compilePathMsFor(route, floorMs) !== null) {
        setTimeout(() => finish("compile-span"), 400); // small grace for span flush
      } else if (status !== null) {
        finish("response");
      } else if (Date.now() - t0 > timeoutMs) {
        finish("timeout");
      }
    }, 500);
  });
}

async function oneRun(port, routes, timeoutMs, cold) {
  if (cold) {
    const dotNext = path.resolve(path.join(REPO_ROOT, ".next"));
    // Guard: only ever wipe paths that genuinely live under REPO_ROOT
    // (real containment check, not the tautological "equals what we just
    // computed" version). maxRetries/retryDelay handle the transient
    // ENOTEMPTY/EBUSY race on macOS/APFS when wiping the large (~1.9GB)
    // cache tree (a prior worker may still be flushing right after the
    // port frees).
    if (dotNext.startsWith(REPO_ROOT + path.sep) || dotNext === REPO_ROOT) {
      rmSync(dotNext, { recursive: true, force: true, maxRetries: 8, retryDelay: 750 });
    }
  }
  const t0 = Date.now();
  const { child, getLog } = startServer();
  // wait for the port to accept connections (process up)
  const upDeadline = Date.now() + 120000;
  while (!portListening(port)) {
    if (Date.now() > upDeadline) {
      devStop();
      return { ok: false, error: "server never listened within 120s", log: getLog().slice(-2000) };
    }
    sleep(500);
  }
  const tProcUp = Date.now();
  // Warmup: the FIRST request on a cold server absorbs the instrumentation boot
  // chain (DB schema warm + 30+ migrations + 82-dir extension scan) which can
  // take tens of seconds and would contaminate whichever measured route goes
  // first. Issue a discardable GET to "/" (307s at middleware — exercises
  // instrumentation + proxy without compiling a heavy route graph), with a long
  // bound, so the measured routes below get clean per-route compile numbers.
  const tWarmStart = Date.now();
  await requestAndAwaitCompile(port, "/", Math.max(timeoutMs, 180000), t0);
  const warmupMs = Date.now() - tWarmStart;
  const routeResults = [];
  // Floor for compile-path attribution = AFTER warmup: any span from a prior run
  // or from the boot chain has startTime < tFloor and is excluded.
  const tFloor = Date.now();
  for (const r of routes) routeResults.push(await requestAndAwaitCompile(port, r, timeoutMs, tFloor));

  const spans = readTraceSpans();
  const startSpan = spans.find((s) => s.name === "start-dev-server");
  const result = {
    ok: true,
    cold,
    msToProcUp: tProcUp - t0,
    warmupMs, // boot-chain-absorbing GET "/" before the measured routes
    cacheBytesAfter: dirSizeBytes(path.join(REPO_ROOT, ".next", "dev", "cache")),
    routes: routeResults,
    startServerTags: startSpan ? startSpan.tags : null,
  };
  devStop();
  // fail closed: confirm the port released
  let rel = false;
  for (let i = 0; i < 10; i++) {
    if (!portListening(port)) {
      rel = true;
      break;
    }
    sleep(500);
  }
  result.portReleased = rel;
  if (!rel) result.warning = `port ${port} STILL bound after dev-stop — fail closed`;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone via dev-stop */
  }
  return result;
}

function median(nums) {
  const a = nums.filter((n) => typeof n === "number").sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function aggregate(runs, routes) {
  const ok = runs.filter((x) => x.ok);
  const per = {};
  for (const r of routes) {
    const ms = ok.flatMap((x) => x.routes.filter((rr) => rr.route === r).map((rr) => rr.compileMs)).filter((n) => typeof n === "number");
    const wall = ok.flatMap((x) => x.routes.filter((rr) => rr.route === r).map((rr) => rr.wallMs)).filter((n) => typeof n === "number");
    per[r] = {
      samples: ms.length,
      compileMsMedian: median(ms),
      compileMsMin: ms.length ? Math.min(...ms) : null,
      compileMsMax: ms.length ? Math.max(...ms) : null,
      wallMsMedian: median(wall),
    };
  }
  return per;
}

function aggregateStartup(runs) {
  const v = runs.filter((x) => x.ok).map((x) => x.msToProcUp).filter((n) => typeof n === "number");
  return { samples: v.length, msToProcUpMedian: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

function renderMd(out) {
  const L = [];
  L.push(`# bench-cold-start (${out.mode}, ${out.runs} runs)`);
  L.push("");
  L.push(`Generated ${out.generatedAt}`);
  L.push("");
  L.push("## Environment");
  L.push(`- node ${process.version}, next ${out.env.next}, platform ${process.platform}, cpus ${os.cpus().length}`);
  L.push(`- port ${out.port}, main :3000 live: ${out.main3000Live}`);
  L.push(`- cache after last run: ${(out.runs && out.lastCacheBytes ? (out.lastCacheBytes / 1e9).toFixed(2) : "?")} GB`);
  L.push("");
  L.push(`## Server startup (ms to process-up): median ${fmt(out.startup.msToProcUpMedian)} (min ${fmt(out.startup.min)} / max ${fmt(out.startup.max)}, n=${out.startup.samples})`);
  L.push("");
  L.push("## Per-route compile-path (ms) — the COMPILE metric (acceptance)");
  L.push("");
  L.push("| Route | samples | compile median | min | max | wall median |");
  L.push("|---|---|---|---|---|---|");
  for (const [r, v] of Object.entries(out.aggregate)) {
    L.push(`| ${r} | ${v.samples} | ${fmt(v.compileMsMedian)} | ${fmt(v.compileMsMin)} | ${fmt(v.compileMsMax)} | ${fmt(v.wallMsMedian)} |`);
  }
  L.push("");
  L.push("> compile-path = the acceptance metric. In WARM mode routes are served from the persistent cache and do not recompile, so compile samples are 0 and the warm signal is startup + wall-response time. Wall-clock is recorded but never used for cold acceptance (runtime can dominate, e.g. /api/mcp).");
  return L.join("\n");
}
const fmt = (n) => (typeof n === "number" ? Math.round(n) : "—");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  const port = readEnvPort();
  if (!port) {
    console.error("[bench] no PORT in .env.local or env — run `cinatra setup branch` first.");
    process.exit(2);
  }
  if (String(port) === "3000" && !args.allow3000) {
    console.error("[bench] refusing PORT 3000 (main checkout). Pass --allow-port-3000 to override.");
    process.exit(2);
  }
  const main3000Live = portListening("3000");
  const runs = [];
  for (let i = 0; i < args.runs; i++) {
    console.error(`[bench] run ${i + 1}/${args.runs} (${args.mode})…`);
    const r = await oneRun(port, args.routes, args.timeoutMs, args.mode === "cold");
    runs.push(r);
    if (!r.ok) console.error(`[bench]   run failed: ${r.error}`);
    else console.error(`[bench]   ` + args.routes.map((rt) => `${rt}=${fmt((r.routes.find((x) => x.route === rt) || {}).compileMs)}ms`).join(" "));
    // Fail closed: a server still bound after dev-stop would contaminate the next
    // run (and prove the cache-safety story is broken). Abort, never SIGKILL.
    if (r.ok && r.portReleased === false) {
      console.error(`[bench] FAIL CLOSED: port ${port} still bound after run ${i + 1}/${args.runs}; aborting (no SIGKILL). Inspect: lsof -iTCP:${port} -sTCP:LISTEN`);
      process.exit(1);
    }
  }
  const out = {
    mode: args.mode,
    runs: args.runs,
    port,
    main3000Live,
    generatedAt: new Date().toISOString(),
    env: { node: process.version, next: nextVersion(), platform: process.platform, cpus: os.cpus().length },
    routes: args.routes,
    lastCacheBytes: runs.filter((r) => r.ok).map((r) => r.cacheBytesAfter).pop() || 0,
    startup: aggregateStartup(runs),
    aggregate: aggregate(runs, args.routes),
    rawRuns: runs,
  };
  mkdirSync(args.out, { recursive: true });
  const tag = args.mode;
  writeFileSync(path.join(args.out, `bench-cold-start.${tag}.json`), JSON.stringify(out, null, 2));
  const md = renderMd(out);
  writeFileSync(path.join(args.out, `bench-cold-start.${tag}.md`), md);
  console.log(md);
}

main();

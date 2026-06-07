// dev-stop.mjs — clean, worktree-scoped dev-server shutdown (`pnpm dev:stop`).
//
// WHY: a SIGKILL mid-compile corrupts the ~1.3GB Turbopack
// persistent cache and forces a full cold start; and a global `pkill -f "next dev"`
// would also kill the user's main :3000 server and every other worktree. This
// tool stops ONLY this worktree's dev server, by SIGTERM, after verifying pid
// ownership — and FAILS CLOSED (non-zero) if the port is still bound after retry.
//
// Guarantees:
//   - never SIGKILL (cache safety)            - never a global pkill (scope safety)
//   - verify ownership by pid-file / cwd / ancestor cmdline before signaling
//   - refuse PORT 3000 without --allow-port-3000 (main checkout guard)
//   - fail closed if the port stays bound after SIGTERM + one retry
//
// Zero dependencies (node: builtins + lsof/ps, present on darwin + linux).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = path.join(REPO_ROOT, ".next", "dev-server.json");

const args = process.argv.slice(2);
const ALLOW_3000 = args.includes("--allow-port-3000");
const QUIET = args.includes("--quiet");
function log(...a) {
  if (!QUIET) console.log("[dev:stop]", ...a);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sh(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function readEnvLocalPort() {
  const p = path.join(REPO_ROOT, ".env.local");
  if (!existsSync(p)) return null;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?PORT\s*=\s*['"]?([^'"\s]+)/.exec(raw.trim());
    if (m) return m[1];
  }
  return null;
}

function listenersOnPort(port) {
  const out = sh("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN", "-P", "-n"]);
  return out.split(/\s+/).filter(Boolean).map(Number);
}

function cwdOf(pid) {
  // lsof -Fn emits a `p<pid>` line then an `n<path>` line for the cwd fd.
  const out = sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const m = out.split(/\r?\n/).find((l) => l.startsWith("n"));
  return m ? m.slice(1) : null;
}

function cmdOf(pid) {
  return sh("ps", ["-o", "command=", "-p", String(pid)]).trim();
}

function ppidOf(pid) {
  const v = sh("ps", ["-o", "ppid=", "-p", String(pid)]).trim();
  return v ? Number(v) : null;
}

const pidMeta = (() => {
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
})();

// A pid belongs to THIS worktree if it (or an ancestor) LIVE-verifies to REPO_ROOT.
// The pid-file (.next/dev-server.json) is only a CANDIDATE source — its recorded
// pids still pass through here, because a stale pid file + OS pid-reuse could
// otherwise SIGTERM an unrelated process.
function isOwned(pid) {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness/permission probe, no effect
  } catch {
    return false; // not alive (or not ours) → never signal a reused/dead pid
  }
  const cwd = cwdOf(pid);
  if (cwd && path.resolve(cwd) === REPO_ROOT) return true;
  let cur = pid;
  for (let hop = 0; hop < 6 && cur && cur > 1; hop++) {
    const cmd = cmdOf(cur);
    if (cmd && cmd.includes(REPO_ROOT)) return true;
    cur = ppidOf(cur);
  }
  return false;
}

function main() {
  const port = (pidMeta && pidMeta.port) || readEnvLocalPort() || process.env.PORT;
  if (!port) {
    log("no PORT resolvable (.env.local / dev-server.json / env) and no listener — nothing to stop.");
    return 0;
  }
  if (String(port) === "3000" && !ALLOW_3000) {
    console.error("[dev:stop] refusing to act on PORT 3000 (main checkout). Pass --allow-port-3000 to override.");
    return 2;
  }

  // Candidate pids: pid-file child + worker(s) listening on the port.
  const candidates = new Set();
  if (pidMeta && pidMeta.childPid) candidates.add(pidMeta.childPid);
  if (pidMeta && pidMeta.wrapperPid) candidates.add(pidMeta.wrapperPid);
  for (const p of listenersOnPort(port)) candidates.add(p);

  if (candidates.size === 0) {
    log(`no dev server found for port ${port} — nothing to stop.`);
    return 0;
  }

  const owned = [];
  for (const pid of candidates) {
    if (isOwned(pid)) owned.push(pid);
    else log(`skipping pid ${pid} on port ${port} — ownership NOT verified (not this worktree).`);
  }
  if (owned.length === 0) {
    console.error(`[dev:stop] port ${port} is bound but no pid is ownership-verified for ${REPO_ROOT}. Refusing to signal foreign processes.`);
    return 3;
  }

  // SIGTERM (never SIGKILL). Signal the worker/listener too — Next 16's
  // next-server worker does not always exit when only its `next dev` parent
  // is signaled.
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGTERM");
      log(`SIGTERM -> ${pid} (${cmdOf(pid).slice(0, 60)})`);
    } catch {
      /* already gone */
    }
  }

  // Wait for the port to release; one retry SIGTERM; then fail closed.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    sleep(500);
    if (listenersOnPort(port).length === 0) {
      log(`port ${port} released. clean stop.`);
      return 0;
    }
  }
  log(`port ${port} still bound after 12s — one more SIGTERM round (never SIGKILL).`);
  for (const pid of listenersOnPort(port)) {
    if (isOwned(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        log(`retry SIGTERM -> ${pid}`);
      } catch {
        /* gone */
      }
    }
  }
  // Retry uses a shorter (8s vs 12s) window because a child that didn't release
  // the port after a 12s first SIGTERM is unlikely to release without intervention
  // — extending the second wait yields diminishing returns. Fail closed sooner.
  const retryDeadline = Date.now() + 8000;
  while (Date.now() < retryDeadline) {
    sleep(500);
    if (listenersOnPort(port).length === 0) {
      log(`port ${port} released after retry. clean stop.`);
      return 0;
    }
  }
  console.error(
    `[dev:stop] FAIL CLOSED: port ${port} is STILL bound after SIGTERM + retry. ` +
      `Not escalating to SIGKILL (would corrupt the Turbopack cache). ` +
      `Inspect manually: lsof -iTCP:${port} -sTCP:LISTEN`,
  );
  return 1;
}

process.exit(main());

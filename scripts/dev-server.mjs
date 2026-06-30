// Dev-server launcher that makes `pnpm dev` honor the worktree's .env.local PORT.
//
// Next.js resolves its dev port from the *process* env (PORT) or --port flag
// BEFORE it loads .env.local into the app runtime. Worktrees provisioned by
// `cinatra setup branch` / `cinatra setup clone` write an isolated PORT into
// .env.local, but plain `next dev` never reads it and silently lands on 3000,
// colliding with the main repo. This launcher surfaces .env.local's PORT into
// process.env before spawning Next.js so isolated worktrees bind their own port.
//
// Precedence (unchanged from Next.js): real shell PORT > .env.local PORT > 3000.

import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_DB_SERVICES,
  shouldDiagnoseDrift,
  diagnoseDockerPortDrift,
  resolveMainRepoRoot,
  formatDriftRemedy,
  parseHostPort,
} from "./lib/docker-port-drift.mjs";
import {
  nangoHealthUrl,
  isLocalNangoUrl,
  resolveNangoBaseUrl,
  probeHttpHealth,
} from "./lib/nango-health.mjs";

// Repo root (the dir holding docker-compose*.yml), resolved from THIS script's
// location so the best-effort Nango heal targets the right compose files no
// matter what cwd `pnpm dev` was launched from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const envPath = path.join(process.cwd(), ".env.local");
// The Nango preflight heals against repoRoot's compose files (resolved from this
// script's location, not cwd), so it reads NANGO_SERVER_URL from the SAME root's
// .env.local — otherwise launching `pnpm dev` from outside the repo root would
// miss a configured remote Nango URL and wrongly fall back to the local default.
const repoEnvPath = path.join(repoRoot, ".env.local");
// Worktree-scoped marker the `pnpm dev:stop` tooling (scripts/dev-stop.mjs)
// reads to find + cleanly SIGTERM THIS worktree's dev server. It
// records the repo root + port so dev-stop can verify ownership before signaling
// and never touch another worktree or the main checkout.
const pidFilePath = path.join(process.cwd(), ".next", "dev-server.json");

function readEnvPort(filePath) {
  if (!existsSync(filePath)) return undefined;
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?PORT\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || undefined;
  }
  return undefined;
}

// A PORT explicitly set in the real shell environment always wins.
if (!process.env.PORT) {
  const envPort = readEnvPort(envPath);
  if (envPort) {
    process.env.PORT = envPort;
    console.log(`[dev-server] PORT=${envPort} (from ${path.relative(process.cwd(), envPath) || ".env.local"})`);
  }
}

// Narrow Docker DB-port preflight (CINATRA_SKIP_DEV_PREFLIGHT=1 to skip).
//
// `next dev` against a host where the bundled Postgres/Redis containers run but
// publish no host port (a base-only `docker compose up` without
// docker-compose.dev.yml) fails with a cryptic ECONNREFUSED deep in app boot.
// Catch that drift HERE and print the one-command remedy. Plain "not started
// yet" stays a non-blocking warning (start docker, the app reconnects); only the
// positively-diagnosed drift — running container, unpublished port — is fatal,
// because it is a definitively-broken state with a known fix.
function readEnvValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || undefined;
  }
  return undefined;
}

function envHostPort(filePath, key, fallback) {
  const value = process.env[key] || readEnvValue(filePath, key);
  // parseHostPort applies explicit-port > scheme-default > fallback precedence, so
  // a no-port loopback URL (e.g. postgresql://…@localhost/db = :5432) is NOT
  // mis-read as the bundled host port and never triggers a false drift exit.
  return parseHostPort(value, fallback);
}

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function runDbPortPreflight() {
  if (process.env.CINATRA_SKIP_DEV_PREFLIGHT === "1") return;
  // Only the two REQUIRED services gate boot; neo4j (recommended) is skipped to
  // keep healthy boots fast.
  const targets = BUNDLED_DB_SERVICES.filter((s) =>
    ["postgres", "redis"].includes(s.composeService),
  );
  const down = [];
  for (const svc of targets) {
    const { host, port } = envHostPort(envPath, svc.envVar, {
      host: "127.0.0.1",
      port: svc.defaultHostPort,
    });
    if (!shouldDiagnoseDrift({ host, port }, svc)) continue; // external/non-default → not ours
    if (await probeTcp(host, port)) continue; // reachable → fine
    down.push({ svc, host, port });
  }
  if (down.length === 0) return;

  let mainRoot;
  try {
    mainRoot = resolveMainRepoRoot(process.cwd());
  } catch {
    mainRoot = process.cwd();
  }
  const drifted = [];
  for (const { svc, port } of down) {
    let diag;
    try {
      diag = diagnoseDockerPortDrift({ service: svc, mainRoot, expectedHostPort: port });
    } catch {
      diag = { available: false };
    }
    if (diag.available && diag.drift) drifted.push(svc.label);
  }

  if (drifted.length > 0) {
    console.error(`\n[dev-server] ✖ Docker host-port drift — refusing to start ${process.env.PORT ? `on PORT=${process.env.PORT}` : "the dev server"}.\n`);
    console.error(formatDriftRemedy(drifted));
    console.error("(Set CINATRA_SKIP_DEV_PREFLIGHT=1 to bypass this check.)\n");
    process.exit(1);
  }
  // Containers not running / unreachable but no drift — warn and continue; the
  // app retries and the operator may be bringing services up alongside.
  console.warn(
    `[dev-server] ⚠ ${down.map((d) => d.svc.label).join(", ")} not reachable yet — start them with \`pnpm services\` (the app will retry once they are up).`,
  );
}

await runDbPortPreflight();

// Run a docker compose subcommand against the bundled dev stack (base +
// loopback-publish override, exactly as `make dev` does). Resolves
// { available } — false when Docker is not installed/usable — and { ok } from
// the exit code. Never throws; output is suppressed (we print our own lines).
function runCompose(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "docker",
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.dev.yml",
          ...args,
        ],
        { cwd: repoRoot, stdio: "ignore" },
      );
    } catch {
      resolve({ available: false });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ available: false }); // e.g. ENOENT — docker not on PATH
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ available: true, ok: code === 0 });
    });
  });
}

// Poll the /health URL up to `tries` times (spaced `intervalMs` apart). Returns
// true on the first healthy response, false once the budget is exhausted.
async function waitForNangoHealth(healthUrl, { tries, intervalMs }) {
  for (let i = 0; i < tries; i++) {
    if ((await probeHttpHealth(healthUrl, 4000)).ok) return true;
    if (i < tries - 1) await sleep(intervalMs);
  }
  return false;
}

// Nango connector-service preflight (CINATRA_SKIP_DEV_PREFLIGHT=1 to skip, same
// switch the DB preflight honors).
//
// The connector OAuth gateway (`cinatra-nango-server-1`) runs the upstream
// amd64-only image under qemu on arm64 dev hosts and can segfault. The compose
// `restart: unless-stopped` policy now self-revives a crash, but a host that
// never ran `docker compose up` (a bare `pnpm dev`) has no Nango at all, and a
// hung-but-port-bound process needs a kick. Probe the HTTP /health contract; if
// a LOCAL Nango is down, make ONE best-effort heal (compose up, then a single
// restart if it came up but stayed unhealthy), bounded-wait, otherwise print
// ONE actionable line.
//
// Never fatal: the app boots without connectors and reconnects when Nango
// returns, so this only warns — it must not block dev on the connector backend.
async function runNangoHealthPreflight() {
  if (process.env.CINATRA_SKIP_DEV_PREFLIGHT === "1") return;
  const rawUrl =
    process.env.NANGO_SERVER_URL || readEnvValue(repoEnvPath, "NANGO_SERVER_URL");
  const healthUrl = nangoHealthUrl(rawUrl);

  if ((await probeHttpHealth(healthUrl, 4000)).ok) return; // healthy → silent

  // A custom remote Nango (hosted / shared infra) is not ours to start — flag it.
  if (!isLocalNangoUrl(rawUrl)) {
    console.warn(
      `[dev-server] ⚠ Nango connector service at ${resolveNangoBaseUrl(rawUrl)} is not answering /health — connectors will fail until it recovers.`,
    );
    return;
  }

  // Local Nango down: one best-effort heal. `up -d` is idempotent (starts it if
  // stopped; no-op if already running).
  console.warn(
    "[dev-server] ⚠ Nango connector service is down — starting it (docker compose up -d nango-server)…",
  );
  const up = await runCompose(["up", "-d", "nango-server"], { timeoutMs: 120_000 });
  if (!up.available) {
    console.warn(
      "[dev-server] ⚠ Nango connector service is not healthy and Docker is unavailable. Start Docker, then `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d nango-server` and re-run `pnpm dev`.",
    );
    return;
  }
  if (!up.ok) {
    // Docker is present but `compose up` itself failed (daemon down, bad config,
    // image pull failure, or the container exited on start). Waiting then
    // restarting would just burn ~60s and end on a misleading "inspect logs"
    // line, so surface the actionable failure path directly and stop here.
    console.warn(
      "[dev-server] ⚠ `docker compose up -d nango-server` failed — connectors will be unavailable. Check Docker is running, then inspect: docker compose -f docker-compose.yml -f docker-compose.dev.yml logs --tail=80 nango-server",
    );
    return;
  }
  if (await waitForNangoHealth(healthUrl, { tries: 12, intervalMs: 3000 })) {
    console.log("[dev-server] ✓ Nango connector service is healthy.");
    return;
  }

  // Up but still failing /health (segfaulted-but-port-bound / hung) — one restart.
  console.warn(
    "[dev-server] ⚠ Nango still unhealthy after start — restarting it once (docker compose restart nango-server)…",
  );
  await runCompose(["restart", "nango-server"], { timeoutMs: 60_000 });
  if (await waitForNangoHealth(healthUrl, { tries: 8, intervalMs: 3000 })) {
    console.log("[dev-server] ✓ Nango connector service is healthy.");
    return;
  }

  console.warn(
    "[dev-server] ⚠ Nango connector service is not healthy — connectors will fail. Inspect: docker compose logs --tail=80 nango-server",
  );
}

await runNangoHealthPreflight();

const forwardedArgs = process.argv.slice(2);
const nextBin = path.join(process.cwd(), "node_modules", ".bin", "next");

const child = spawn(nextBin, ["dev", ...forwardedArgs], {
  stdio: "inherit",
  env: process.env,
});

function writePidFile() {
  try {
    mkdirSync(path.dirname(pidFilePath), { recursive: true });
    writeFileSync(
      pidFilePath,
      JSON.stringify(
        {
          wrapperPid: process.pid,
          childPid: child.pid, // the `next dev` parent; the next-server worker is its child
          port: process.env.PORT || null,
          repoRoot: process.cwd(),
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    // Non-fatal: dev-stop falls back to resolving the listener by port.
  }
}

function clearPidFile() {
  try {
    rmSync(pidFilePath, { force: true });
  } catch {
    /* ignore */
  }
}

writePidFile();

child.on("exit", (code, signal) => {
  clearPidFile();
  if (signal) {
    // Re-raise the child's terminating signal to self so the wrapper exits with
    // matching semantics. Remove our forwarding handlers FIRST, otherwise the
    // re-raised signal is swallowed by the handler below and the wrapper hangs.
    for (const s of ["SIGINT", "SIGTERM"]) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

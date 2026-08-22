// Cinatra service check.
//
// Probes every supporting service Cinatra depends on and reports whether each
// is reachable. Run automatically at the end of `make setup`, and on demand
// with `make check` / `pnpm check:services`.
//
// Most services are checked with a plain TCP connect to their published port —
// that proves the container is up and listening without depending on service-
// specific health routes. Nango is the exception: it probes the HTTP `/health`
// contract, because the emulated amd64 image can hang while still port-bound, in
// which case a TCP connect "passes" but every connector is broken (cinatra#730).
// Ports/hosts are read from .env.local where Cinatra exposes them
// (SUPABASE_DB_URL, REDIS_URL, NANGO_SERVER_URL, GRAPHITI_URL, WAYFLOW_BASE_URL);
// the rest fall back to the docker-compose.yml defaults.
//
// Exit code: non-zero if any REQUIRED service is unreachable (so the check is
// usable as a CI / scripting gate). Recommended-tier and the app itself never
// affect the exit code.
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_DB_SERVICES,
  shouldDiagnoseDrift,
  diagnoseDockerPortDrift,
  resolveMainRepoRoot,
  formatDriftRemedy,
  parseHostPort,
} from "./lib/docker-port-drift.mjs";
import { formatGuardedComposeCommand } from "./lib/dev-preflight.mjs";
import { nangoHealthUrl, probeHttpHealth } from "./lib/nango-health.mjs";
import { wayflowDownHint } from "./lib/wayflow-down-hint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ANSI colors — disabled when stdout is not a TTY or NO_COLOR is set.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const green = (s) => c("0;32", s);
const red = (s) => c("0;31", s);
const yellow = (s) => c("1;33", s);
const dim = (s) => c("2", s);

function readEnvLocal() {
  const file = path.join(repoRoot, ".env.local");
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Derive { host, port } from a URL-shaped env value (explicit port > scheme
// default > compose fallback). Centralized in scripts/lib/docker-port-drift.mjs
// so the dev-server preflight resolves ports identically.
const hostPort = parseHostPort;

// Build the WayFlow `/.health` URL from WAYFLOW_BASE_URL: the same contract the
// docker-compose healthcheck probes. The loader can be hung or crash-looping
// while the port stays bound (its restart policy re-binds it between attempts),
// so a bare TCP connect would report a broken runtime as "up" and drop the
// start hint. Probe HTTP like Nango instead. `/.health` answers 200 for both
// "ok" and "degraded" (per-agent load failures never condemn the runtime), so
// the probe's 2xx rule accepts exactly what the compose healthcheck accepts.
function wayflowHealthUrl(baseUrl) {
  const v = typeof baseUrl === "string" ? baseUrl.trim() : "";
  return `${(v || "http://127.0.0.1:3010").replace(/\/+$/, "")}/.health`;
}

// Probe WayFlow `/.health` and enforce the documented contract EXACTLY as the
// docker-compose healthcheck does: HTTP 200 AND valid JSON whose `status` is
// "ok" or "degraded". A 204, another 2xx, malformed JSON, or any other status
// value is NOT ready; the generic 2xx rule of probeHttpHealth would report
// those as up and suppress the start hint while agent runs still fail.
async function probeWayflowHealth(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) return false;
    let body;
    try {
      body = await res.json();
    } catch {
      return false;
    }
    return body?.status === "ok" || body?.status === "degraded";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function probe(host, port, timeoutMs = 2500) {
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

const env = readEnvLocal();
const appPort = Number(env.PORT) || 3000;

// tier: "required"  — core; a failure exits non-zero.
//       "recommended" — needed for full agent/object functionality; warn only.
//       "optional"  — behind a docker-compose profile, so NOT started by the
//                     default `docker compose up -d`; informational only (never
//                     warns or fails — its absence on a default setup is normal).
//       "app"       — the Cinatra app itself; informational (not running until
//                     `make dev`).
const services = [
  {
    name: "PostgreSQL",
    tier: "required",
    ...hostPort(env.SUPABASE_DB_URL, { host: "127.0.0.1", port: 5434 }),
    note: "app + Better Auth store",
  },
  {
    name: "Redis",
    tier: "required",
    ...hostPort(env.REDIS_URL, { host: "127.0.0.1", port: 6379 }),
    note: "BullMQ queue, event log",
  },
  {
    name: "Verdaccio",
    tier: "required",
    host: "127.0.0.1",
    port: 4873,
    note: "local agent-package registry",
  },
  {
    name: "Nango",
    tier: "required",
    ...hostPort(env.NANGO_SERVER_URL, { host: "127.0.0.1", port: 3003 }),
    // HTTP /health (not a bare TCP connect): the emulated image can hang while
    // the port stays bound, which a TCP probe would wrongly report as up.
    healthUrl: nangoHealthUrl(env.NANGO_SERVER_URL),
    note: "connector OAuth gateway",
  },
  {
    name: "Neo4j",
    tier: "recommended",
    host: "127.0.0.1",
    port: 7687,
    note: "objects knowledge graph",
  },
  {
    name: "Graphiti",
    tier: "recommended",
    ...hostPort(env.GRAPHITI_URL, { host: "127.0.0.1", port: 8000 }),
    note: "object graph indexer",
  },
  {
    // Recommended (not optional): agent runs are a headline feature and 100%
    // of them hard-fail with ECONNREFUSED while this runtime is down. The
    // profile gate means a default dev bring-up NEVER starts it (#2654), so
    // this check is where a fresh install learns the exact start command.
    // Recommended-tier never affects the exit code.
    name: "WayFlow",
    tier: "recommended",
    ...hostPort(env.WAYFLOW_BASE_URL, { host: "127.0.0.1", port: 3010 }),
    healthUrl: wayflowHealthUrl(env.WAYFLOW_BASE_URL),
    // Contract-validating probe (200 + status ok|degraded), NOT the generic
    // 2xx probeHttpHealth: see probeWayflowHealth.
    probeHealth: probeWayflowHealth,
    note: "agent runtime; serves every installed agent",
    // Mode-aware: a hint that ignores CINATRA_WAYFLOW_RUNTIME tells an
    // operator who deliberately opted out, or who points at an external
    // runtime, to "start" a local container this install never owns. See
    // scripts/lib/wayflow-down-hint.mjs.
    downHint: wayflowDownHint(env.CINATRA_WAYFLOW_RUNTIME),
  },
  {
    name: "Cinatra app",
    tier: "app",
    host: "127.0.0.1",
    port: appPort,
    note: "Next.js dev server",
  },
];

const results = await Promise.all(
  services.map(async (svc) => ({
    ...svc,
    // Nango + WayFlow carry a healthUrl → probe their HTTP health contract
    // (hung-but-port-bound must read DOWN); everything else TCP-connects. A
    // service-specific probeHealth (WayFlow: 200 + status ok|degraded) wins
    // over the generic 2xx probeHttpHealth.
    up: svc.healthUrl
      ? svc.probeHealth
        ? await svc.probeHealth(svc.healthUrl, 2500)
        : (await probeHttpHealth(svc.healthUrl, 2500)).ok
      : await probe(svc.host, svc.port),
  })),
);

console.log(`\n${useColor ? "[1m" : ""}Cinatra service check${useColor ? "[0m" : ""}\n`);

const nameWidth = Math.max(...results.map((r) => r.name.length));
const addrWidth = Math.max(...results.map((r) => `${r.host}:${r.port}`.length));

for (const r of results) {
  let mark;
  if (r.up) mark = green("✓");
  else if (r.tier === "required") mark = red("✗");
  else if (r.tier === "recommended") mark = yellow("✗");
  else mark = dim("○"); // app / optional — informational, not a problem
  const addr = `${r.host}:${r.port}`.padEnd(addrWidth);
  let status;
  if (r.up) status = green("up");
  else if (r.tier === "app") status = dim("not started — run `make dev`");
  else if (r.tier === "optional") status = dim("not started; enable its compose profile");
  else if (r.tier === "required") status = red("DOWN — required");
  else status = yellow(r.downHint ? `down — recommended; ${r.downHint}` : "down — recommended");
  console.log(`  ${mark}  ${r.name.padEnd(nameWidth)}  ${dim(addr)}  ${status}  ${dim(r.note)}`);
}

// MCP public URL — a configuration state rather than a service, but the most
// common reason a fresh install can't use the chat. Only the .env.local
// fallback vars are visible here; the canonical value may also be set in the
// admin UI (stored in the database), so report this as informational.
const mcpPublicUrl =
  env.MCP_PUBLIC_BASE_URL?.trim() || env.APP_PUBLIC_URL?.trim() || "";
console.log("");
if (mcpPublicUrl) {
  console.log(`  ${green("✓")}  MCP public URL (env): ${mcpPublicUrl}`);
} else {
  console.log(
    `  ${yellow("○")}  MCP public URL: not set in the environment — the AI chat needs it.`,
  );
  console.log(
    `     ${dim("This check only sees the env fallback (MCP_PUBLIC_BASE_URL / APP_PUBLIC_URL).")}`,
  );
  console.log(
    `     ${dim("The canonical value is set in the app at /configuration/development?tab=tunnel")}`,
  );
  console.log(
    `     ${dim("and stored in the database (getPublicMcpServerUrl) — authoritative even though it")}`,
  );
  console.log(
    `     ${dim("is not visible here. Why + Tailscale setup: https://docs.cinatra.ai/guides/hosting/mcp-public-url/")}`,
  );
}

const requiredDown = results.filter((r) => r.tier === "required" && !r.up);
const recommendedDown = results.filter((r) => r.tier === "recommended" && !r.up);

// Docker host-port drift diagnosis: when a bundled DB/cache service is DOWN but
// its container is actually RUNNING (just not publishing the host port), the
// generic "start them with make dev" message is misleading. Diagnose the real
// cause — a base-only `docker compose up` without docker-compose.dev.yml — and
// print the precise remedy. Best-effort; scoped to the MAIN compose project.
const downByLabel = new Map(
  [...requiredDown, ...recommendedDown].map((r) => [r.name, r]),
);
const driftedLabels = [];
if (downByLabel.size > 0) {
  const mainRoot = resolveMainRepoRoot(repoRoot);
  for (const svc of BUNDLED_DB_SERVICES) {
    const down = downByLabel.get(svc.label);
    if (!down) continue;
    if (!shouldDiagnoseDrift({ host: down.host, port: down.port }, svc)) continue;
    const diag = diagnoseDockerPortDrift({
      service: svc,
      mainRoot,
      expectedHostPort: down.port,
    });
    if (diag.available && diag.drift) driftedLabels.push(svc.label);
  }
}

console.log("");
if (driftedLabels.length > 0) {
  console.log(red("  ⚠ Docker host-port drift detected:"));
  for (const line of formatDriftRemedy(driftedLabels).split("\n")) {
    console.log(`  ${dim(line)}`);
  }
}
if (requiredDown.length > 0) {
  console.log(
    red(
      `  ${requiredDown.length} required service(s) unreachable: ${requiredDown
        .map((r) => r.name)
        .join(", ")}.`,
    ),
  );
  // The raw alternative is the GUARDED chain (cinatra#2839): a bare
  // `docker compose up` pasted from here skips scripts/dev-compose-env.mjs, so
  // it neither pins this checkout's compose project — Docker reads
  // COMPOSE_PROJECT_NAME from its own env, never from `.env.local` — nor honors
  // any of the refusals `make dev` now stops on. Same builder as the recipes.
  console.log(
    dim(
      `  Start them with \`make dev\` (or \`${formatGuardedComposeCommand({
        args: ["up", "-d"],
        requireManageable: true,
      })}\`), then inspect \`make logs\`.`,
    ),
  );
  process.exit(1);
}

if (recommendedDown.length > 0) {
  console.log(
    yellow(
      `  All required services are up. Still starting / down: ${recommendedDown
        .map((r) => r.name)
        .join(", ")} (give containers a minute, or check \`make logs\`).`,
    ),
  );
} else {
  console.log(green("  All services are reachable."));
}
process.exit(0);

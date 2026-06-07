// Docker DB/cache host-port drift detection (dev-environment guard).
//
// Why this exists: the base `docker-compose.yml` is safe-by-default — it does NOT
// publish the platform DB/cache ports (postgres 5434 / redis 6379 / neo4j 7687)
// on the host (v1.0.4 P1a hardening, so a bare `docker compose up` on a public
// host can never expose them on 0.0.0.0). Those loopback host bindings live ONLY
// in `docker-compose.dev.yml`, opted in via
//   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
// (= `pnpm services` / `make dev` / `scripts/setup.sh`).
//
// If the stack is brought up from the BASE file alone (a bare `docker compose up`
// or a stale checkout), the containers run healthy but publish no host port, so a
// host-run `pnpm dev` hits a cryptic `ECONNREFUSED 127.0.0.1:5434`. This helper
// turns that into an actionable root-cause message: "container running but the
// host port isn't published — you started the stack without docker-compose.dev.yml".
//
// Split into a PURE detector (`detectDriftFromInspect`, unit-tested without Docker)
// and an impure wrapper (`diagnoseDockerPortDrift`) that shells out to Docker.

import { spawnSync } from "node:child_process";
import path from "node:path";

// The bundled local DB/cache services whose host ports come from the dev override.
// `containerPort` is the in-container listen port; `defaultHostPort` is the
// loopback port the override publishes (and what the host app connects to).
export const BUNDLED_DB_SERVICES = [
  { composeService: "postgres", label: "PostgreSQL", containerPort: 5432, defaultHostPort: 5434, envVar: "SUPABASE_DB_URL" },
  { composeService: "redis", label: "Redis", containerPort: 6379, defaultHostPort: 6379, envVar: "REDIS_URL" },
  { composeService: "neo4j", label: "Neo4j", containerPort: 7687, defaultHostPort: 7687, envVar: "NEO4J_URI" },
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? "").trim());
}

// Default port per URL scheme. A URL that omits an explicit port resolves to its
// scheme default, NOT the bundled-stack fallback — otherwise a loopback
// `postgresql://…@localhost/db` (which means :5432) is mis-read as the bundled
// 5434 and a perfectly-healthy non-bundled DB triggers a false drift diagnosis.
export const PROTOCOL_DEFAULT_PORTS = {
  "http:": 80,
  "https:": 443,
  "postgres:": 5432,
  "postgresql:": 5432,
  "redis:": 6379,
  "rediss:": 6379,
  "bolt:": 7687,
  "neo4j:": 7687,
};

// Derive { host, port } from a URL-shaped value. Port precedence:
//   explicit URL port  >  scheme default  >  bundled fallback.
// host.docker.internal (used so containers reach the host) maps to loopback,
// which is what the published port is actually bound to. Mirrors the resolution
// in scripts/check-services.mjs (single source of truth, imported by both).
export function parseHostPort(urlValue, fallback) {
  if (!urlValue) return fallback;
  try {
    const url = new URL(urlValue);
    let host = url.hostname || fallback.host;
    if (host === "host.docker.internal") host = "127.0.0.1";
    let port;
    if (url.port) {
      port = Number(url.port);
    } else if (url.protocol in PROTOCOL_DEFAULT_PORTS) {
      port = PROTOCOL_DEFAULT_PORTS[url.protocol];
    } else {
      port = fallback.port;
    }
    return { host, port };
  } catch {
    return fallback;
  }
}

// Decide whether a DOWN service is a candidate for Docker drift diagnosis. Only
// the bundled local stack qualifies: the expected host must be loopback AND the
// expected port must be the override's default. A non-loopback host (a hosted
// DB / external infra) or a non-default port means "not our docker stack" — skip
// (so a perfectly-healthy external DB is never mis-blamed on docker-compose.dev.yml).
export function shouldDiagnoseDrift({ host, port }, service) {
  return isLoopbackHost(host) && Number(port) === service.defaultHostPort;
}

// PURE drift detector. Given a service's running state + the published-ports map
// from `docker inspect ... {{json .NetworkSettings.Ports}}`, decide whether the
// container is up but its DB/cache port is unpublished (the drift), or genuinely
// down (a different problem — stack not started).
//
// portsJson shapes (from Docker):
//   { "5432/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "5434" }] }  → published
//   { "5432/tcp": null }                                             → unpublished (DRIFT when running)
//   {}                                                               → unpublished
export function detectDriftFromInspect({ running, containerPort, expectedHostPort, portsJson }) {
  if (!running) {
    return { drift: false, running: false, reason: "container is not running" };
  }
  const key = `${containerPort}/tcp`;
  const bindings = portsJson && typeof portsJson === "object" ? portsJson[key] : undefined;
  if (Array.isArray(bindings) && bindings.some((b) => String(b?.HostPort) === String(expectedHostPort))) {
    return { drift: false, running: true, reason: `host port ${expectedHostPort} is published` };
  }
  return {
    drift: true,
    running: true,
    reason: `container is running but ${key} is not published to host port ${expectedHostPort}`,
  };
}

// Resolve the MAIN checkout's repo root from any worktree/clone, so drift
// diagnosis always inspects the SHARED docker stack (the main compose project),
// never a per-clone runtime project. Worktrees + heavy clones share the main
// repo's git common-dir; its parent is the main working tree.
export function resolveMainRepoRoot(cwd = process.cwd()) {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : "";
  };
  // Submodule case (rare here) — the superproject is the main tree.
  const superproject = run(["rev-parse", "--show-superproject-working-tree"]);
  if (superproject) return superproject;
  // Worktree/clone case — git-common-dir is the MAIN repo's .git; its parent is
  // the main working tree. (For the main checkout itself this also resolves to
  // the main root.)
  const commonDir = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) {
    // commonDir is `<main>/.git` (or a bare/worktrees path); the working tree is
    // its parent directory.
    return path.dirname(commonDir.replace(/\/\.git\/?$/, "/.git"));
  }
  return cwd;
}

// Impure: shell out to Docker to diagnose drift for one bundled service against
// the MAIN compose project. Best-effort — any Docker unavailability / missing
// container / parse failure returns { available: false } (never throws), so the
// guard degrades to the generic "service down" message.
export function diagnoseDockerPortDrift({ service, mainRoot, expectedHostPort }) {
  const compose = (args) =>
    spawnSync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", ...args],
      { cwd: mainRoot, encoding: "utf8" },
    );

  // `ps -q <service>` (all states) → the container id in THIS project for the
  // service, regardless of which compose files started it (project+service
  // labels match). Empty output = no such container (stack not created here).
  const psAll = compose(["ps", "-aq", service.composeService]);
  if (psAll.status !== 0) return { available: false };
  const containerId = (psAll.stdout || "").trim().split(/\s+/).filter(Boolean)[0];
  if (!containerId) return { available: false };

  const inspect = spawnSync(
    "docker",
    ["inspect", containerId, "--format", "{{.State.Running}}\t{{json .NetworkSettings.Ports}}"],
    { encoding: "utf8" },
  );
  if (inspect.status !== 0) return { available: false };
  const [runningRaw, portsRaw] = (inspect.stdout || "").trim().split("\t");
  let portsJson;
  try {
    portsJson = JSON.parse(portsRaw ?? "null");
  } catch {
    return { available: false };
  }
  const result = detectDriftFromInspect({
    running: runningRaw === "true",
    containerPort: service.containerPort,
    expectedHostPort,
    portsJson,
  });
  return { available: true, containerId, ...result };
}

// The single actionable remedy message shared by both consumers.
export function formatDriftRemedy(driftedServiceLabels) {
  const which = driftedServiceLabels.join(", ");
  return [
    `The Docker container(s) for ${which} are RUNNING but their host port(s) are not published.`,
    "Cause: the stack was started from the base docker-compose.yml ALONE (a bare `docker compose up`),",
    "which deliberately does not expose the DB/cache ports on the host. The loopback bindings live in",
    "docker-compose.dev.yml. Re-create the services WITH the dev override (data is preserved):",
    "",
    "    pnpm services",
    "    # or: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d",
    "",
  ].join("\n");
}

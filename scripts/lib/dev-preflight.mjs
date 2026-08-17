// Dev-server preflight POLICY — the skip switch and the compose scoping the
// `pnpm dev` preflight (scripts/dev-server.mjs) runs under.
//
// Why this module exists (cinatra#2839): the preflight's two decisions — "may I
// touch Docker at all?" and "which compose project / host ports do I touch?" —
// were both inline in the launcher, which is a top-level script with spawn +
// process.exit side effects and therefore not unit-importable (the same reason
// scripts/lib/nango-health.mjs and scripts/lib/wayflow-down-hint.mjs were split
// out). Inline meant untested, and untested meant two defects shipped together:
//
//   1. CINATRA_SKIP_DEV_PREFLIGHT was read from the PROCESS env only, while
//      every other launcher knob (PORT, NANGO_SERVER_URL) is honored from
//      `.env.local` too. A worktree lane records its configuration in
//      `.env.local` — that IS where a lane states its intent — so a lane that
//      set the flag there got the full preflight anyway, and a best-effort
//      `docker compose up -d nango-server` brought up nango-server plus its
//      `depends_on` (nango-db, redis) behind a flag whose entire documented
//      promise is that nothing starts.
//
//   2. The compose invocation was unscoped: no `-p`, so the project name fell
//      out of the checkout directory's basename, and the compose files publish
//      FIXED host ports (3003/3009/5435/6379). Two lanes — or one lane beside
//      the operator's stack — therefore collide on those ports even though each
//      lane already runs its own compose project. The rest of the stack scopes
//      itself with COMPOSE_PROJECT_NAME (see evidence/2747-e2e: `p2747-*`
//      containers) and states its service ports as URLs in `.env.local`; this
//      module threads both of those into the preflight instead of inventing a
//      third convention.
//
// Everything here is PURE (no IO beyond an explicit file read) and
// dependency-injected, so the decisions are asserted in
// scripts/__tests__/dev-preflight.test.mjs without Docker on the box.

import { existsSync, readFileSync } from "node:fs";

/** The documented dev-preflight bypass switch. */
export const SKIP_PREFLIGHT_ENV_VAR = "CINATRA_SKIP_DEV_PREFLIGHT";

/** Docker's own per-project switch — the one the rest of the stack already uses. */
export const COMPOSE_PROJECT_ENV_VAR = "COMPOSE_PROJECT_NAME";

/** The two compose files the dev stack is always composed from (`make dev`). */
export const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.dev.yml"];

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Read one KEY=value out of a dotenv-style file. Mirrors the launcher's original
 * inline reader: `export ` prefix tolerated, surrounding quotes stripped, blank
 * and `#` lines skipped, first match wins. Returns undefined when the file is
 * absent or the key is unset/empty.
 *
 * @param {string} filePath
 * @param {string} key
 * @returns {string | undefined}
 */
export function readEnvFileValue(filePath, key) {
  if (!filePath || !existsSync(filePath)) return undefined;
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return undefined; // unreadable → treat as unset, never throw out of a preflight
  }
  for (const raw of contents.split(/\r?\n/)) {
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

/**
 * Normalize a boolean-ish flag value.
 *
 * Returns `true`/`false` for a RECOGNIZED value and `undefined` for "not
 * stated" — absent, empty, or a spelling this does not model. The tri-state is
 * the point: it lets a caller fall through to the next source instead of
 * treating an unset shell variable as an explicit "no".
 *
 * @param {unknown} raw
 * @returns {boolean | undefined}
 */
export function normalizeSkipFlag(raw) {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (!value) return undefined;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined; // unrecognized → not a statement either way
}

/**
 * Decide whether the dev preflight must not touch Docker at all.
 *
 * Precedence mirrors the launcher's documented PORT precedence — the real shell
 * environment wins, `.env.local` is consulted next, default is "run the
 * preflight". An explicitly FALSY shell value (`=0`) is a real statement and
 * overrides a `.env.local` opt-out, so an operator can force the preflight back
 * on for one run without editing the lane's file.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {boolean}
 */
export function shouldSkipDevPreflight({ processEnv = {}, envFileValues = [] } = {}) {
  const fromShell = normalizeSkipFlag(processEnv[SKIP_PREFLIGHT_ENV_VAR]);
  if (fromShell !== undefined) return fromShell;
  for (const value of envFileValues) {
    const fromFile = normalizeSkipFlag(value);
    if (fromFile !== undefined) return fromFile;
  }
  return false;
}

/**
 * Resolve the compose project the preflight may act on.
 *
 * A lane names its project with COMPOSE_PROJECT_NAME (the Docker-native switch
 * the rest of the stack uses). Docker reads that from its own process env, but
 * NOT from `.env.local` — which is exactly where a worktree lane records it —
 * so it is read here and passed explicitly as `-p`. Returns undefined when
 * nothing is configured, which preserves the historical behavior for the main
 * checkout: compose derives the project from the directory basename.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {string | undefined}
 */
export function resolveComposeProjectName({ processEnv = {}, envFileValues = [] } = {}) {
  const candidates = [processEnv[COMPOSE_PROJECT_ENV_VAR], ...envFileValues];
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The host ports the preflight can cause to be published, and where a lane
 * already states each one.
 *
 * `envVar` is the compose interpolation variable (docker-compose.yml /
 * docker-compose.dev.yml read it as `${VAR:-default}`), `defaultHostPort` is the
 * historical fixed port that stays in force when nothing overrides it, and
 * `urlVar` is the `.env.local` service URL the app itself connects on — the
 * SAME value the rest of the stack honors, so the published port and the app's
 * client port cannot drift apart.
 */
export const PREFLIGHT_HOST_PORTS = [
  { envVar: "CINATRA_NANGO_SERVER_HOST_PORT", defaultHostPort: 3003, urlVar: "NANGO_SERVER_URL" },
  { envVar: "CINATRA_NANGO_CONNECT_HOST_PORT", defaultHostPort: 3009, urlVar: undefined },
  { envVar: "CINATRA_NANGO_DB_HOST_PORT", defaultHostPort: 5435, urlVar: "NANGO_DATABASE_URL" },
  { envVar: "CINATRA_REDIS_HOST_PORT", defaultHostPort: 6379, urlVar: "REDIS_URL" },
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * Extract an EXPLICIT host port from a service URL, and only when it points at
 * this host.
 *
 * Deliberately narrower than docker-port-drift's `parseHostPort`: that helper
 * falls back to the URL scheme's default port, which is right for "where do I
 * connect?" but wrong here. Publishing a container port is a claim on a HOST
 * port, so a URL with no port stated (`http://localhost/…` = :80) must not be
 * read as a request to publish :80, and a remote service
 * (`https://nango.example.com`) is not ours to publish at all.
 *
 * @param {string | undefined} urlValue
 * @returns {number | undefined}
 */
export function explicitLoopbackPort(urlValue) {
  if (!urlValue) return undefined;
  let url;
  try {
    url = new URL(String(urlValue).trim());
  } catch {
    return undefined;
  }
  let host = url.hostname;
  if (host === "host.docker.internal") host = "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) return undefined; // external service — not ours
  if (!url.port) return undefined;
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/**
 * Build the compose interpolation environment for the preflight's services.
 *
 * Per port, precedence is: an explicit `CINATRA_*_HOST_PORT` (shell, then
 * `.env.local`) > the port stated in the lane's service URL > the historical
 * default. Always returns every key so the spawned compose never inherits a
 * stale value from the ambient environment.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileLookup?: (key: string) => string | undefined }} input
 * @returns {Record<string, string>}
 */
export function resolveComposeHostPortEnv({ processEnv = {}, envFileLookup = () => undefined } = {}) {
  const read = (key) => {
    const fromShell = String(processEnv[key] ?? "").trim();
    if (fromShell) return fromShell;
    const fromFile = String(envFileLookup(key) ?? "").trim();
    return fromFile || undefined;
  };

  const out = {};
  for (const spec of PREFLIGHT_HOST_PORTS) {
    const explicit = Number(read(spec.envVar));
    if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) {
      out[spec.envVar] = String(explicit);
      continue;
    }
    const fromUrl = spec.urlVar ? explicitLoopbackPort(read(spec.urlVar)) : undefined;
    out[spec.envVar] = String(fromUrl ?? spec.defaultHostPort);
  }
  return out;
}

/**
 * Build the argv for a `docker compose` subcommand, pinned to the resolved
 * project and the dev stack's two compose files.
 *
 * `-p` is emitted only when a project name is configured; omitting it preserves
 * compose's directory-basename derivation for the main checkout, which is what
 * the operator's existing stack is already named.
 *
 * @param {{ projectName?: string, args?: string[] }} input
 * @returns {string[]}
 */
export function buildComposeArgs({ projectName, args = [] } = {}) {
  const project = String(projectName ?? "").trim();
  return [
    "compose",
    ...(project ? ["-p", project] : []),
    ...COMPOSE_FILES.flatMap((file) => ["-f", file]),
    ...args,
  ];
}

/**
 * Render the same invocation as a copy-pasteable command line.
 *
 * Operator guidance MUST be built from `buildComposeArgs` too, not hand-written
 * alongside it: an unpinned command pasted from a warning forks a SECOND
 * compose project that cannot see the lane's stack. Same lesson, same remedy as
 * the WayFlow compose builder in packages/agents/src/wayflow-url.ts (#2803).
 *
 * @param {{ projectName?: string, args?: string[] }} input
 * @returns {string}
 */
export function formatComposeCommand({ projectName, args = [] } = {}) {
  return `docker ${buildComposeArgs({ projectName, args }).join(" ")}`;
}

/**
 * Create the preflight's `docker compose` runner.
 *
 * THE GUARD LIVES HERE, not only at each preflight's entry point. The
 * cinatra#2839 regression was a Docker write reached behind a flag that
 * promises none, so the skip check sits on the single chokepoint every compose
 * call must pass through: when `skip` is set the runner resolves
 * `{ available: false, skipped: true }` WITHOUT spawning anything, and no
 * future call site added above it can reintroduce the bypass.
 *
 * Resolves `{ available }` — false when Docker is not installed/usable — and
 * `{ ok }` from the exit code. Never throws; output is suppressed (the launcher
 * prints its own lines).
 *
 * @param {{
 *   spawnFn: Function,          // node:child_process spawn (injected for tests)
 *   skip: boolean,
 *   projectName?: string,
 *   portEnv?: Record<string, string>,
 *   cwd: string,
 *   baseEnv?: Record<string, string | undefined>,
 * }} deps
 * @returns {(args: string[], opts?: { timeoutMs?: number }) => Promise<{ available: boolean, ok?: boolean, skipped?: boolean }>}
 */
export function createComposeRunner({
  spawnFn,
  skip,
  projectName,
  portEnv = {},
  cwd,
  baseEnv = {},
}) {
  return function runCompose(args, { timeoutMs = 120_000 } = {}) {
    if (skip) return Promise.resolve({ available: false, skipped: true });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn("docker", buildComposeArgs({ projectName, args }), {
          cwd,
          stdio: "ignore",
          // The host-port overrides are passed as compose interpolation
          // variables; the compose files read them as `${VAR:-default}`.
          env: { ...baseEnv, ...portEnv },
        });
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
  };
}

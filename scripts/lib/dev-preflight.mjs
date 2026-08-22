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
//      out of the checkout directory's basename. A lane that already runs its
//      own compose project (see evidence/2747-e2e: `p2747-*` containers) got a
//      SECOND, basename-derived project rather than the one it owns, so the
//      "heal" started a duplicate stack the lane could not see. The rest of the
//      stack already scopes itself with COMPOSE_PROJECT_NAME, so this module
//      threads that same switch into the preflight instead of inventing a third
//      convention.
//
// A later review round found the reader leaking the same way the flag did — by
// reading something a lane HAD stated as "not stated at all":
//
//   3. The dotenv reader kept an inline comment in the value, so
//      `CINATRA_SKIP_DEV_PREFLIGHT=1 # lane isolation` read as an unrecognized
//      spelling and the flag was silently dropped — defect (1) again, one layer
//      down.
//
// Host-PORT scoping is deliberately NOT here. Parameterizing the compose files'
// fixed 3003/3009/5435/6379 and deriving each lane's port is the other half of
// cinatra#2839 (acceptance item 2); it needs a real boot on a Docker host before
// it is worth trusting, so it lands on its own branch. This module changes WHICH
// PROJECT the preflight acts on and nothing about which host ports it publishes.
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
 * Parse the right-hand side of one `KEY=value` dotenv line.
 *
 * Inline comments are real dotenv syntax and a lane WILL write one — a worktree
 * annotates why it opted out (`CINATRA_SKIP_DEV_PREFLIGHT=1 # lane isolation`).
 * Reading that as the literal value `1 # lane isolation` made
 * `normalizeSkipFlag` see an unrecognized spelling, report "not stated", and the
 * preflight run anyway: the ORIGINAL cinatra#2839 defect's exact shape — an
 * opt-out stated where a lane states things, silently not honored —
 * reintroduced one layer down, in the reader this module extracted.
 *
 * Rules (dotenv convention):
 *   - A quoted value ends at its closing quote; a `#` INSIDE the quotes is
 *     literal, and only trailing whitespace or a comment may follow it.
 *   - An unquoted value is cut at the first `#` that begins the value or is
 *     preceded by whitespace. Requiring that separator (as python-dotenv does)
 *     keeps a `#` that is part of the value itself — a dev DB password, a URL
 *     fragment — from being silently truncated.
 *   - Whatever survives is trimmed; empty means "unset".
 *
 * @param {string} rawValue
 * @returns {string | undefined}
 */
function parseEnvValue(rawValue) {
  const value = String(rawValue).trim();
  if (!value) return undefined;

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    const rest = close === -1 ? undefined : value.slice(close + 1).trim();
    // Only a WELL-FORMED quoted value (closed, followed by nothing but a
    // comment) is treated as quoted. Anything else falls through to the
    // unquoted rule, which is what the previous reader did with an unbalanced
    // quote — no existing `.env.local` changes meaning here.
    if (rest !== undefined && (rest === "" || rest.startsWith("#"))) {
      return value.slice(1, close).trim() || undefined;
    }
  }

  return value.replace(/(^|\s)#.*$/, "").trim() || undefined;
}

/**
 * Read one KEY=value out of a dotenv-style file. Mirrors the launcher's original
 * inline reader: `export ` prefix tolerated, surrounding quotes stripped, blank
 * and `#` lines skipped, first match wins — plus the inline-comment handling in
 * `parseEnvValue`. Returns undefined when the file is absent or the key is
 * unset/empty.
 *
 * The inline-comment handling is DELIBERATELY not scoped to the skip flag. This
 * is the launcher's one `.env.local` reader, so widening it also widens how
 * PORT, SUPABASE_DB_URL, REDIS_URL and NANGO_SERVER_URL are read
 * (scripts/dev-server.mjs). That is the intent, not a side effect: an annotated
 * `PORT=13839 # lane port` previously resolved to the literal `13839 # lane
 * port`, which Next.js does not parse as a port, and an annotated DSN parsed to
 * no host port at all and fell back to the bundled default. One rule for one
 * file beats a per-key exception nobody can predict. The narrowness of the
 * comment rule is what keeps the widening safe: a `#` is a comment only when it
 * begins the value or follows whitespace, so a DSN password (`pa#ssword`) and a
 * URL fragment survive untouched. Both are pinned at the reader in
 * scripts/__tests__/dev-preflight.test.mjs; the DSN cases are pinned once more
 * through `parseHostPort`, which is how dev-server.mjs actually consumes them.
 * (A RAW `#` in a password is not valid DSN syntax and never parsed — the point
 * of that case is that the reader hands the parser the value WHOLE, unchanged
 * from `main`.)
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
    return parseEnvValue(m[1]);
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
 * promises none, so the skip check sits on the function that spawns: when
 * `skip` is set the runner resolves `{ available: false, skipped: true }`
 * WITHOUT spawning anything, and no future call site added above it can
 * reintroduce the bypass through this runner.
 *
 * This runner is the chokepoint for every compose WRITE the preflight makes; it
 * is NOT the process's only door to Docker. The read-only host-port drift
 * diagnosis (scripts/lib/docker-port-drift.mjs) spawns `docker` itself, so it
 * carries the SAME guard on its own spawning function and builds its argv from
 * `buildComposeArgs` here. Two spawning functions, two guards — that is what
 * makes the flag's promise hold, rather than one runner every path happens to
 * use today.
 *
 * Resolves `{ available }` — false when Docker is not installed/usable — and
 * `{ ok }` from the exit code. Never throws; output is suppressed (the launcher
 * prints its own lines).
 *
 * @param {{
 *   spawnFn: Function,          // node:child_process spawn (injected for tests)
 *   skip: boolean,
 *   projectName?: string,
 *   cwd: string,
 * }} deps
 * @returns {(args: string[], opts?: { timeoutMs?: number }) => Promise<{ available: boolean, ok?: boolean, skipped?: boolean }>}
 */
export function createComposeRunner({ spawnFn, skip, projectName, cwd }) {
  return function runCompose(args, { timeoutMs = 120_000 } = {}) {
    if (skip) return Promise.resolve({ available: false, skipped: true });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn("docker", buildComposeArgs({ projectName, args }), {
          cwd,
          stdio: "ignore",
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

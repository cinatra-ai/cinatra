// Pure, side-effect-free decision helpers for `cinatra dev refresh`.
//
// `cinatra dev refresh` reconciles a contributor's local dev environment
// (dependencies + dev database schema) to the code they have checked out. It is
// the idempotent, non-destructive subset of `scripts/setup.sh` minus .env.local
// creation: the human owns git (pull / checkout), the command never touches it.
//
// The flow orchestration (docker / pnpm install / runSetup) lives in index.mjs
// because it depends on that file's internal helpers. The decision logic that is
// worth testing in isolation lives here so it can be unit-tested without a live
// docker stack or database.

const DEFAULT_SCHEMA = "cinatra";
const DEFAULT_QUEUE = "cinatra-background-jobs";
const DOCKER_FLAG_PREFIX = "--docker=";

/**
 * Parse `dev refresh` flags into a normalized docker mode.
 * - `--no-docker`            → "off" (takes precedence over --docker=)
 * - `--docker=always`        → "always"
 * - `--docker=auto` / absent → "auto"
 * Any other `--docker=<value>` throws.
 */
export function parseDevRefreshFlags(argv = []) {
  // Reject anything that is not a recognized flag so typos (`--dockr=always`) or a
  // dropped flag (`--rebuild-shell`) fail loudly instead of silently no-opping to
  // the default — a silent `--dockr=always` would run `auto` and surprise the user.
  for (const arg of argv) {
    if (arg === "--no-docker" || arg.startsWith(DOCKER_FLAG_PREFIX)) {
      continue;
    }
    throw new Error(
      `Unknown flag "${arg}" for cinatra dev refresh. Supported flags: --docker=auto|always, --no-docker.`,
    );
  }

  const dockerArg = argv.find((arg) => arg.startsWith(DOCKER_FLAG_PREFIX));
  if (dockerArg) {
    const value = dockerArg.slice(DOCKER_FLAG_PREFIX.length);
    if (value !== "auto" && value !== "always") {
      throw new Error(
        `Invalid ${DOCKER_FLAG_PREFIX}${value}. Expected --docker=auto, --docker=always, or --no-docker.`,
      );
    }
  }
  // A malformed --docker= value is always rejected above, so typos fail loudly even
  // when combined with --no-docker. Otherwise --no-docker is the most conservative
  // choice and wins over a valid --docker=.
  if (argv.includes("--no-docker")) {
    return { dockerMode: "off" };
  }
  if (dockerArg) {
    return { dockerMode: dockerArg.slice(DOCKER_FLAG_PREFIX.length) };
  }
  return { dockerMode: "auto" };
}

function hostnameOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * True when SUPABASE_DB_URL points at the bundled local stack (or is unset —
 * a fresh dev checkout defaults to the local docker Postgres). External
 * (non-localhost) database URLs return false so `auto` mode leaves infra alone.
 */
export function looksLikeBundledStack(env = {}) {
  const host = hostnameOf(env.SUPABASE_DB_URL);
  if (!host) return true;
  // Node's URL parser returns IPv6 hosts wrapped in brackets, e.g. "[::1]".
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * True when this checkout is an isolated worktree/clone that borrows the shared
 * main docker stack rather than owning it. Bringing the bundled compose stack up
 * from such a checkout would port-conflict with the main dev server, so `auto`
 * mode must skip docker here. Detected via the markers `cinatra setup branch` /
 * `setup clone` write into the worktree `.env.local`.
 */
export function isIsolatedWorktree(env = {}) {
  const schema = (env.SUPABASE_SCHEMA || "").trim();
  if (schema && schema !== DEFAULT_SCHEMA) return true;
  if ((env.CINATRA_CLONE_SLUG || "").trim()) return true;
  const queue = (env.BULLMQ_QUEUE_NAME || "").trim();
  if (queue && queue !== DEFAULT_QUEUE) return true;
  return false;
}

/**
 * Decide whether `dev refresh` should run `docker compose up -d`, and why.
 * Returns `{ run, reason }` so the orchestrator can print an explanation either way.
 * - off    → never
 * - always → always (forced; the orchestrator treats failure as fatal)
 * - auto   → only when this checkout owns the bundled local stack
 */
export function describeDockerDecision({ dockerMode, env = {} }) {
  if (dockerMode === "off") return { run: false, reason: "--no-docker" };
  if (dockerMode === "always") return { run: true, reason: "--docker=always" };
  if (isIsolatedWorktree(env)) {
    return { run: false, reason: "isolated worktree/clone (it borrows the shared main stack)" };
  }
  if (!looksLikeBundledStack(env)) {
    return { run: false, reason: "external infrastructure (SUPABASE_DB_URL is not localhost)" };
  }
  return { run: true, reason: "bundled local stack" };
}

/** Convenience boolean form of {@link describeDockerDecision}. */
export function shouldRunDocker({ dockerMode, env = {} }) {
  return describeDockerDecision({ dockerMode, env }).run;
}

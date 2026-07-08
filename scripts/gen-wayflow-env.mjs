// Generate the narrow WayFlow container env file from .env.local.
//
// WHY THIS EXISTS
// ---------------
// The `wayflow` docker service (docker-compose.yml) runs the WayFlow agent
// runtime that serves http://localhost:3010 and calls BACK into the host's
// `/api/llm-bridge` with an `X-Cinatra-Bridge-Token` shared secret. The bridge
// returns 403 when that token is missing or wrong, the agent then produces no
// text, and the interactive widget content-edit surfaces "(no response)".
//
// The compose file CANNOT safely read these secrets via
// `environment: CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}"`: that
// interpolation resolves from the *shell* env, so any bring-up that does NOT
// `source .env.local` first (a bare `docker compose up`, a CI/test harness)
// leaves the token EMPTY — and, worse, an empty `environment:` value OVERRIDES
// an `env_file:` value on the same key (proven against docker compose: an
// `environment: FOO: "${UNSET}"` resolves to `FOO: ""` in `docker compose
// config` and wins over the file). So the durable fix is: keep ONLY the three
// host-secret keys in a narrow generated file referenced via `env_file`, with
// NO overlapping `environment:` mapping for them.
//
// We deliberately do NOT point the service's `env_file` at `.env.local`
// directly: that file holds 20+ keys (BETTER_AUTH_SECRET, CINATRA_ENCRYPTION_KEY,
// NANGO_*_KEY, DB URLs, dev-admin bypasses) that the agent-running container
// must never see, and its `PORT` (the app's 3000) would clobber the wayflow
// container's required 3010. This generator extracts EXACTLY the keys the
// wayflow container needs.
//
// LIFECYCLE
// ---------
// Run by `npm run services` on EVERY bring-up (so a rotated token always
// propagates). Idempotent. The output file `docker/wayflow/.wayflow.env` is
// gitignored and written 0600.
//
// SOURCES: the parsed .env.local overlaid with the PROCESS env for exactly the
// wayflow keys (non-empty env value wins; see overlayProcessEnv). The overlay
// is what lets the wp-drupal UAT gate — which provisions the whole app-service
// env from in-repo runner-env values and never writes an .env.local — hand the
// per-run CINATRA_BRIDGE_TOKEN to the container; without it the wayflow boot
// preflight exits non-zero, the container restart-loops, and the widget-stream
// relay dies with "fetch failed".
//
// FAIL POLICY
// -----------
// By default this is TOLERANT: if neither .env.local nor the process env has a
// bridge token, it writes whatever keys it can (so a fresh checkout /
// non-wayflow flow is not blocked) and exits 0 with a warning. Pass
// `--require-bridge-token` (used by the `services` script that is about to
// start wayflow) to HARD-FAIL when the bridge token is missing or
// whitespace-only in BOTH sources — turning the silent 403 into a loud,
// actionable error BEFORE the container starts. The wayflow container ALSO
// fails loud at boot (agent_loader.py main()) as a second backstop.

import path from "node:path";
import process from "node:process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// The keys the wayflow CONTAINER needs from host secrets. Static literals
// (PORT=3010, CINATRA_AGENTS_DIR, CINATRA_BASE_URL) stay in the compose
// `environment:` block — they are not secrets and not interpolated, so they
// never hit the empty-override trap and must NOT appear here (PORT especially:
// .env.local's PORT is the app's 3000 and must never reach this container).
// CINATRA_CONTEXT_ATTEST_KEY (#907): the dedicated per-node context-callback
// signing key. The wayflow runtime mints an HMAC attestation with it on
// /api/context-resolve + /api/context-finalize calls so the app can bind the
// callback to the actually-executing composed child. Secret (no default);
// missing → degraded (the app fails closed on the composed-child path).
const WAYFLOW_KEYS = [
  "CINATRA_BRIDGE_TOKEN",
  "OPENAI_API_KEY",
  "WAYFLOW_BASE_URL",
  "CINATRA_CONTEXT_ATTEST_KEY",
];

// Defaults applied when the key is absent from .env.local. Only for the
// non-secret WAYFLOW_BASE_URL (mirrors the compose default that used to live in
// `${WAYFLOW_BASE_URL:-http://localhost:3010}`). Secrets have NO default.
const DEFAULTS = { WAYFLOW_BASE_URL: "http://localhost:3010" };

// Parse a dotenv file into a flat object. Mirrors scripts/check-services.mjs's
// `readEnvLocal` (same regex) so the two never drift. Strips surrounding quotes.
export function parseDotenv(contents) {
  const env = {};
  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Overlay the PROCESS env onto the parsed .env.local for EXACTLY the wayflow
// keys. Pure (no IO) so it is unit-testable.
//
// WHY: the wp-drupal UAT gate provisions the app-service env from in-repo,
// zero-secret values in the RUNNER env (SUPABASE_DB_URL, BETTER_AUTH_SECRET,
// CINATRA_BRIDGE_TOKEN, ... — .github/workflows/wp-drupal-uat.yml) and never
// writes an .env.local at all, so a file-only read left the wayflow container
// with NO bridge token in CI: agent_loader's boot preflight then exits
// non-zero, the container restart-loops, and the widget-stream relay to
// localhost:3010 dies with "fetch failed" ("(no response)" in the widget —
// exactly the silent 403 family this generator exists to prevent). A
// NON-EMPTY process-env value wins over the file (the `services` script
// `source`s .env.local first, so the two agree in the local flow); an
// empty/whitespace process value never clobbers a file value; keys outside
// WAYFLOW_KEYS are never read from the process env.
export function overlayProcessEnv(source, processEnv) {
  const merged = { ...source };
  for (const key of WAYFLOW_KEYS) {
    const raw = processEnv?.[key];
    if (typeof raw === "string" && raw.trim() !== "") merged[key] = raw;
  }
  return merged;
}

// Build the narrow env map + a list of missing-secret keys. Pure (no IO) so it
// is unit-testable. `source` is the parsed .env.local object.
export function buildWayflowEnv(source) {
  const out = {};
  const missing = [];
  for (const key of WAYFLOW_KEYS) {
    const raw = typeof source[key] === "string" ? source[key].trim() : "";
    if (raw) {
      out[key] = raw;
    } else if (key in DEFAULTS) {
      out[key] = DEFAULTS[key];
    } else {
      // A required secret (CINATRA_BRIDGE_TOKEN / OPENAI_API_KEY) is missing or
      // whitespace-only — record it; the writer decides whether to hard-fail.
      missing.push(key);
    }
  }
  return { env: out, missing };
}

// Serialize to dotenv text. Values are emitted bare (no quoting) — docker
// compose's env_file parser treats the whole post-`=` remainder as the literal
// value, so quoting would embed the quotes.
export function serializeDotenv(env) {
  const header =
    "# GENERATED by scripts/gen-wayflow-env.mjs from .env.local — DO NOT EDIT.\n" +
    "# Narrow host-secret set the wayflow docker service needs. Gitignored.\n";
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return `${header}${body}\n`;
}

function main() {
  const requireBridgeToken = process.argv.includes("--require-bridge-token");
  const envLocalPath = path.join(repoRoot, ".env.local");
  const outDir = path.join(repoRoot, "docker", "wayflow");
  const outPath = path.join(outDir, ".wayflow.env");

  let fileSource = {};
  if (existsSync(envLocalPath)) {
    fileSource = parseDotenv(readFileSync(envLocalPath, "utf8"));
  } else {
    console.warn(
      "[gen-wayflow-env] .env.local not found; reading the wayflow keys from the process env only " +
        "(the CI runner provisions them there; locally run the dev setup to create .env.local).",
    );
  }
  // Process-env overlay (CI provisioning path; see overlayProcessEnv). The
  // former ".env.local not found + --require-bridge-token = FATAL" branch is
  // deliberately gone: the file being absent is fine as long as the RESULTING
  // source carries the bridge token — the bridgeMissing check below is the
  // single fail-closed arbiter for both sources.
  const source = overlayProcessEnv(fileSource, process.env);

  const { env, missing } = buildWayflowEnv(source);
  const bridgeMissing = missing.includes("CINATRA_BRIDGE_TOKEN");

  if (bridgeMissing && requireBridgeToken) {
    console.error(
      "[gen-wayflow-env] FATAL: CINATRA_BRIDGE_TOKEN is missing or empty in " +
        ".env.local AND the process env. The wayflow runtime needs it to " +
        "authenticate its callback to /api/llm-bridge; without it the bridge " +
        'returns 403 and the widget content-edit returns "(no response)". Set ' +
        "CINATRA_BRIDGE_TOKEN in .env.local (the dev setup mints one) or export " +
        "it (CI derives a throwaway per-run value) and re-run.",
    );
    process.exit(1);
  }
  if (missing.length > 0) {
    console.warn(
      `[gen-wayflow-env] WARNING: not set in .env.local: ${missing.join(", ")}. ` +
        "The wayflow container will start without them (degraded).",
    );
  }

  mkdirSync(outDir, { recursive: true });
  // 0600: the file carries secrets; keep it owner-only. The `mode` option only
  // applies when CREATING the file, so an existing file written under a broader
  // umask would keep that mode after a rewrite — chmod unconditionally after
  // the write to guarantee owner-only perms on every run.
  writeFileSync(outPath, serializeDotenv(env), { mode: 0o600 });
  chmodSync(outPath, 0o600);
  console.log(
    `[gen-wayflow-env] wrote ${path.relative(repoRoot, outPath)} ` +
      `(${Object.keys(env).length} keys${bridgeMissing ? ", bridge token MISSING" : ""}).`,
  );
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

// Generate the narrow Nango container env file from .env.local (cinatra#1691).
//
// WHY THIS EXISTS
// ---------------
// The `nango-server` docker service stores connector provider secrets
// (API keys, OAuth tokens) encrypted with NANGO_ENCRYPTION_KEY. The compose
// file used to read it via `environment: NANGO_ENCRYPTION_KEY:
// "${NANGO_ENCRYPTION_KEY}"` — that interpolation resolves from the *shell*
// env, NOT from .env.local where Cinatra keeps the key. So any bring-up that
// did not `source .env.local` first (a bare `docker compose up -d
// nango-server`) started Nango with an EMPTY key, silently:
//   1. a fresh Nango DB then initializes UNENCRYPTED (secrets at rest in
//      plaintext), and
//   2. an existing encrypted DB refuses to boot with the misleading
//      "A previously set NANGO_ENCRYPTION_KEY has been removed from your
//      environment variables" — the key was never removed, it was never
//      passed (this broke a real volume restore; see the issue).
// And an empty `environment:` value OVERRIDES an `env_file:` value on the
// same key (the gen-wayflow-env precedent, proven against docker compose),
// so the durable fix is: keep the key ONLY in a narrow generated file
// referenced via `env_file`, with NO overlapping `environment:` mapping.
//
// We deliberately do NOT point the service's `env_file` at `.env.local`
// directly: that file holds 20+ host secrets (BETTER_AUTH_SECRET,
// CINATRA_ENCRYPTION_KEY, provider API keys, DB URLs) that the Nango
// container must never see. This generator extracts EXACTLY the one key it
// needs.
//
// LIFECYCLE
// ---------
// Run by `npm run services` on EVERY bring-up (so a rotated key always
// propagates) and tolerantly by `setup:dev`. Idempotent. The output file
// `docker/nango/.nango.env` is gitignored and written 0600.
//
// FAIL POLICY
// -----------
// Tolerant by default (a fresh checkout / non-nango flow is not blocked):
// writes what it can and exits 0 with a warning. Pass
// `--require-encryption-key` (used by the `services` script that is about to
// start nango-server) to HARD-FAIL when the key is missing or
// whitespace-only in BOTH .env.local and the process env — turning the
// silent unencrypted-store / misleading boot-crash into a loud, actionable
// error BEFORE the container starts.

import path from "node:path";
import process from "node:process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  COMPOSE_PROJECT_ENV_VAR,
  buildComposeArgs,
  normalizeComposeProjectName,
  readEnvFileValue,
  resolveComposeProjectName,
} from "./lib/dev-preflight.mjs";
import { isLocalNangoUrl } from "./lib/nango-health.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// The ONLY host secret the nango-server container needs from .env.local.
// Every static, non-secret setting (ports, dashboard creds, DB wiring) stays
// in the compose `environment:` block — those are not interpolated from the
// shell, share no key with this file, and so never hit the empty-override
// trap.
const NANGO_KEYS = ["NANGO_ENCRYPTION_KEY"];

// Parse a dotenv file into a flat object. Mirrors gen-wayflow-env.mjs /
// scripts/check-services.mjs (same regex) so the parsers never drift.
export function parseDotenv(contents) {
  const env = {};
  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Overlay the PROCESS env onto the parsed .env.local for EXACTLY the nango
// keys (the gen-wayflow-env overlay contract: a NON-EMPTY process value wins;
// empty/whitespace never clobbers a file value; other keys are never read).
// Pure (no IO) so it is unit-testable.
export function overlayProcessEnv(source, processEnv) {
  const merged = { ...source };
  for (const key of NANGO_KEYS) {
    const raw = processEnv?.[key];
    if (typeof raw === "string" && raw.trim() !== "") merged[key] = raw;
  }
  return merged;
}

// Build the narrow env map + missing-secret list. Pure (no IO). A secret has
// no default — missing means missing.
export function buildNangoEnv(source) {
  const out = {};
  const missing = [];
  for (const key of NANGO_KEYS) {
    const raw = typeof source[key] === "string" ? source[key].trim() : "";
    if (raw) {
      out[key] = raw;
    } else {
      missing.push(key);
    }
  }
  return { env: out, missing };
}

// Tolerant-mode clobber guard (codex 1691-r2): when the key is missing from
// BOTH sources but a previously generated .nango.env still carries a
// non-empty key, the tolerant path must KEEP that file — rewriting it empty
// would re-break exactly the volume-restore scenario this tool exists to fix
// (a later bare `docker compose up` would boot keyless against an encrypted
// DB). Pure (no IO) so it is unit-testable.
export function shouldPreserveExisting(existingContents) {
  const parsed = parseDotenv(existingContents ?? "");
  const raw = parsed.NANGO_ENCRYPTION_KEY;
  return typeof raw === "string" && raw.trim() !== "";
}

// Serialize to dotenv text (bare values — compose's env_file parser treats
// the post-`=` remainder as the literal value; quoting would embed quotes).
export function serializeDotenv(env) {
  const header =
    "# GENERATED by scripts/gen-nango-env.mjs from .env.local — DO NOT EDIT.\n" +
    "# Narrow host-secret set the nango-server docker service needs. Gitignored.\n";
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return `${header}${body}\n`;
}

// ---------------------------------------------------------------------------
// NANGO_SECRET_KEY — the OTHER Nango secret, and why this script now fills it
// ---------------------------------------------------------------------------
// NANGO_ENCRYPTION_KEY (above) is minted by the dev setup. The per-environment
// CLIENT secret key is not: nango-server seeds it into its OWN database on
// first boot, so nothing on the host can know it before Nango has started.
// Until it lands in .env.local the setup wizard's Secrets step is not
// env-managed and asks the operator to run a raw psql read by hand — which an
// automated bring-up cannot do, and which a human should not have to do with a
// live API credential on their clipboard.
//
// So this generator performs EXACTLY the read the wizard documents, once, and
// writes the value into .env.local. Three rules make that safe:
//   - the value is NEVER printed, returned or logged (only a status word);
//   - an existing non-empty value is KEPT — a rerun is a no-op, and a key the
//     operator entered by hand is never overwritten;
//   - Nango being down is NOT an error. The read is best-effort: the key stays
//     unset, the wizard keeps showing its manual command, and the setup that
//     called us carries on (exit 0). Failing a bring-up over an optional
//     convenience would be the worse bug.
//
// Note the ordering reality: `npm run services` runs this script BEFORE
// `docker compose up -d`, so on a first bring-up nango-db is not up yet and
// this step correctly reports "left unset". The fill happens on the next run
// of the script, once Nango is up.

// The read, verbatim as .env.example and src/app/setup/secrets/page.tsx state
// it. One exported constant so the copies can be pinned equal by test instead
// of drifting apart.
export const NANGO_SECRET_KEY_QUERY =
  "SELECT secret_key FROM _nango_environments WHERE name='dev' LIMIT 1;";

// The psql invocation, minus the compose project pin (added per call).
const NANGO_SECRET_KEY_EXEC_ARGS = [
  "exec",
  "-T",
  "nango-db",
  "psql",
  "-U",
  "nango",
  "-d",
  "nango",
  "-tAc",
  NANGO_SECRET_KEY_QUERY,
];

// The bundled nango-server accepts a UUID-v4 secret key and nothing else — a
// differently shaped bearer comes back `invalid_secret_key_format` (see the
// note in packages/google-oauth-connection/src/index.ts). So the shape is not
// cosmetic validation: it is the difference between a key and psql's error
// text arriving on stdout. Anything that is not a UUID is treated as "no read".
const SECRET_KEY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is a usable NANGO_SECRET_KEY already on file?
 *
 * Read through `readEnvFileValue` — the SAME reader the dev preflight and
 * check-services use — so this agrees with what the app actually gets from
 * .env.local: `export ` prefixes honored, inline comments stripped, quotes
 * handled, and a DUPLICATED key resolved to its LAST occurrence. Reimplementing
 * dotenv here would put this script on the other side of that contract, which
 * is exactly the drift `readEnvFileValue`'s own comment was written about.
 */
export function hasNangoSecretKey(envLocalPath) {
  return readEnvFileValue(envLocalPath, "NANGO_SECRET_KEY") !== undefined;
}

// Write the key into .env.local's text. The LAST `NANGO_SECRET_KEY` line —
// commented or not — is replaced IN PLACE, because last-stated is the line the
// app reads: appending below an empty later assignment would report "written"
// while the effective value stayed empty, and appending below the commented
// example line would leave two. With no such line at all the assignment is
// appended. Pure (no IO).
export function applySecretKeyToEnvLocal(contents, value) {
  const text = String(contents ?? "");
  const assignment = `NANGO_SECRET_KEY=${value}`;
  const lines = text.split("\n");
  const isKeyLine = (line) => /^\s*#?\s*(?:export\s+)?NANGO_SECRET_KEY\s*=/.test(line);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isKeyLine(lines[i])) continue;
    lines[i] = assignment;
    return lines.join("\n");
  }
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${assignment}\n`;
}

// First usable line of the psql output, or "" — never throws, never echoes.
function extractSecretKey(stdout) {
  for (const line of String(stdout ?? "").split("\n")) {
    const candidate = line.trim();
    if (candidate === "") continue;
    return SECRET_KEY_SHAPE.test(candidate) ? candidate : "";
  }
  return "";
}

// The real executor. stderr is DISCARDED rather than surfaced: psql echoes the
// failing statement, and this statement selects a secret. The exit status and
// stdout are all the caller needs.
function defaultComposeExec(args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("docker", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
      }),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// Atomic, mode-preserving replace of .env.local (the .nango.env writer's
// reasoning: never truncate a live secrets file in place).
//
// The temp file is CREATED 0600 and only then relaxed to the mode .env.local
// already had: it holds a live credential, and `scripts/setup.sh` creates
// .env.local with a plain `cp`, so that mode is commonly 0644 — a window this
// file must not open even briefly. Any failure removes the temp file rather
// than leaving a secret-bearing stray behind, and is reported to the caller as
// a plain false (never as a throw carrying file contents).
function writeEnvLocal(envLocalPath, contents) {
  let mode = 0o600;
  try {
    mode = statSync(envLocalPath).mode & 0o777;
  } catch {
    // keep the restrictive default
  }
  // EXCLUSIVE creation under an unpredictable name. A predictable temp path in
  // a directory another user can write is the classic hand-off: an existing
  // file there is opened with ITS mode (`mode:` applies only on create), and a
  // symlink there is followed — so the secret would be written through it and
  // then chmodded, before the rename put the link in .env.local's place. `wx`
  // fails instead, and only a file this call actually created is cleaned up.
  // The name is minted INSIDE the guard as well: a secure-random failure is a
  // throw, and this best-effort step must degrade to `write-failed` rather than
  // fail the whole setup.
  let tmpPath = "";
  let created = false;
  try {
    tmpPath = `${envLocalPath}.tmp-${randomBytes(8).toString("hex")}`;
    writeFileSync(tmpPath, contents, { mode: 0o600, flag: "wx" });
    created = true;
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, envLocalPath);
    return true;
  } catch {
    if (created) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // nothing further we can do; never throw out of a best-effort step
      }
    }
    return false;
  }
}

/**
 * Fill NANGO_SECRET_KEY into .env.local from the bundled dev Nango, once.
 *
 * `exec` is injected so the tests never touch docker, and so the only code
 * that ever holds the value is this function. Returns a status word — never
 * the value — and never throws.
 *
 * @param {{
 *   envLocalPath: string,
 *   exec?: (args: string[]) => { ok: boolean, stdout: string },
 *   processEnv?: Record<string, string | undefined>,
 *   quiet?: boolean,
 *   log?: (message: string) => void,
 *   warn?: (message: string) => void,
 * }} input
 * @returns {{ status: "written" | "kept" | "not-local" | "not-canonical" |
 *   "unreachable" | "write-failed" | "no-env-file" }}
 */
export function fillNangoSecretKey({
  envLocalPath,
  exec = defaultComposeExec,
  processEnv = process.env,
  quiet = false,
  log = console.log,
  warn = console.error,
} = {}) {
  const say = (message) => {
    if (!quiet) log(message);
  };

  if (!existsSync(envLocalPath)) return { status: "no-env-file" };

  // Already supplied — by the file, or by the shell (which OVERRIDES the file
  // for the app). Either way there is nothing to fill and nothing to overwrite.
  const fromProcess = processEnv?.NANGO_SECRET_KEY;
  if (hasNangoSecretKey(envLocalPath) || (typeof fromProcess === "string" && fromProcess.trim())) {
    say("[gen-nango-env] NANGO_SECRET_KEY: kept");
    return { status: "kept" };
  }

  // ONLY the Nango on this machine. A checkout pointed at a hosted or shared
  // Nango is not served by the local container's key — writing it would put a
  // wrong credential in .env.local, where it then SHADOWS the right one entered
  // through the UI. Same locality rule the dev preflight applies before it
  // heals nango-server (scripts/lib/nango-health.mjs).
  const serverUrl =
    (typeof processEnv?.NANGO_SERVER_URL === "string" && processEnv.NANGO_SERVER_URL.trim()) ||
    readEnvFileValue(envLocalPath, "NANGO_SERVER_URL");
  if (!isLocalNangoUrl(serverUrl)) {
    warn(
      "[gen-nango-env] NANGO_SECRET_KEY: NANGO_SERVER_URL is not a local Nango — left unset " +
        "(read the key from that server's Environment Settings).",
    );
    return { status: "not-local" };
  }

  // Read the LANE's nango-db, not another checkout's: the same
  // COMPOSE_PROJECT_NAME resolution the dev preflight performs, through the
  // same reader, from the shell env AND .env.local (docker itself reads only
  // the former).
  const projectName = resolveComposeProjectName({
    processEnv,
    envFileValues: [readEnvFileValue(envLocalPath, COMPOSE_PROJECT_ENV_VAR)],
  });
  // A project name compose will not accept is not this checkout's stack under
  // another spelling — compose refuses such a name outright rather than
  // cleaning it up (the same refusal resolveComposeHostPortPlan raises), so
  // there is no stack under it at all. Trimming or normalizing it here would
  // point the read at a DIFFERENT project's nango-db, which is the one place
  // this step could import a key from the wrong stack.
  //
  // The check bites on what DOCKER sees, which is not symmetric between the two
  // sources and must not be made so: a shell COMPOSE_PROJECT_NAME reaches
  // docker verbatim, while a name recorded in .env.local reaches it only
  // through `scripts/dev-compose-env.mjs`, which exports the value this SAME
  // reader (`readEnvFileValue`) returns. So the parsed file value IS the
  // running project, and it is the shell value that must survive unparsed.
  if (projectName !== undefined && normalizeComposeProjectName(projectName) !== projectName) {
    warn(
      `[gen-nango-env] NANGO_SECRET_KEY: ${COMPOSE_PROJECT_ENV_VAR} is not a name Docker Compose ` +
        "accepts (lowercase alphanumerics, hyphens and underscores, starting with a letter or " +
        "number) — left unset.",
    );
    return { status: "not-canonical" };
  }

  let value = "";
  try {
    const result = exec(buildComposeArgs({ projectName, args: NANGO_SECRET_KEY_EXEC_ARGS }));
    if (result && result.ok) value = extractSecretKey(result.stdout);
  } catch {
    value = "";
  }

  if (!value) {
    warn(
      "[gen-nango-env] NANGO_SECRET_KEY: nango-db not reachable — left unset " +
        "(start Nango and re-run this script; the setup Secrets step meanwhile " +
        "shows the manual command).",
    );
    return { status: "unreachable" };
  }

  // Re-read RIGHT BEFORE the write. The docker read can block for seconds, and
  // the file this replaces must be the file as it is now — an operator (or the
  // wizard) may have written .env.local in the meantime, and renaming a stale
  // snapshot over it would silently discard that edit, including a secret key
  // they just entered themselves.
  let contents;
  try {
    contents = readFileSync(envLocalPath, "utf8");
  } catch {
    contents = undefined;
  }
  if (contents === undefined || hasNangoSecretKey(envLocalPath)) {
    say("[gen-nango-env] NANGO_SECRET_KEY: kept");
    return { status: "kept" };
  }

  if (!writeEnvLocal(envLocalPath, applySecretKeyToEnvLocal(contents, value))) {
    warn("[gen-nango-env] NANGO_SECRET_KEY: .env.local could not be written — left unset.");
    return { status: "write-failed" };
  }

  say("[gen-nango-env] NANGO_SECRET_KEY: written");
  return { status: "written" };
}

function main() {
  const requireKey = process.argv.includes("--require-encryption-key");
  // --quiet: no informational stdout. Warnings and errors still speak — a
  // silent bring-up must still be able to report that something is wrong.
  const quiet = process.argv.includes("--quiet");
  const envLocalPath = path.join(repoRoot, ".env.local");
  const outDir = path.join(repoRoot, "docker", "nango");
  const outPath = path.join(outDir, ".nango.env");

  let fileSource = {};
  if (existsSync(envLocalPath)) {
    fileSource = parseDotenv(readFileSync(envLocalPath, "utf8"));
  } else {
    console.warn(
      "[gen-nango-env] .env.local not found; reading NANGO_ENCRYPTION_KEY from the process env only " +
        "(locally run the dev setup to create .env.local).",
    );
  }
  const source = overlayProcessEnv(fileSource, process.env);

  const { env, missing } = buildNangoEnv(source);
  const keyMissing = missing.includes("NANGO_ENCRYPTION_KEY");

  if (keyMissing && requireKey) {
    console.error(
      "[gen-nango-env] FATAL: NANGO_ENCRYPTION_KEY is missing or empty in " +
        ".env.local AND the process env. Without it a fresh Nango DB stores " +
        "provider secrets UNENCRYPTED, and an existing encrypted Nango DB " +
        "refuses to boot (the misleading 'key has been removed' crash). Set " +
        "NANGO_ENCRYPTION_KEY in .env.local (the dev setup mints one) and re-run.",
    );
    process.exit(1);
  }
  if (keyMissing && existsSync(outPath) && shouldPreserveExisting(readFileSync(outPath, "utf8"))) {
    console.warn(
      "[gen-nango-env] WARNING: NANGO_ENCRYPTION_KEY is missing from .env.local and the " +
        "process env, but the existing docker/nango/.nango.env still carries a key — " +
        "keeping it untouched (rewriting it empty would boot Nango keyless against an " +
        "encrypted store).",
    );
    fillNangoSecretKey({ envLocalPath, quiet });
    return;
  }
  if (missing.length > 0) {
    console.warn(
      `[gen-nango-env] WARNING: not set in .env.local: ${missing.join(", ")}. ` +
        "nango-server would start with an UNENCRYPTED secret store.",
    );
  }

  mkdirSync(outDir, { recursive: true });
  // ATOMIC replace (CodeRabbit 1698-r1): writing outPath directly truncates
  // the live file before the new content lands and keeps a pre-existing
  // permissive mode until the chmod — a mid-write failure could leave an
  // empty or exposed key file. Write a fresh 0600 temp file in the same
  // directory, chmod defensively (`mode` only applies on CREATE), then
  // rename over outPath — readers see the old or the new file, never a
  // truncated one.
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, serializeDotenv(env), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, outPath);
  if (!quiet) {
    console.log(
      `[gen-nango-env] wrote ${path.relative(repoRoot, outPath)} ` +
        `(${Object.keys(env).length} keys${keyMissing ? ", encryption key MISSING" : ""}).`,
    );
  }

  // Best-effort, never fatal: fill the wizard's client secret key from the
  // running dev Nango if it is up and .env.local does not carry one yet.
  fillNangoSecretKey({ envLocalPath, quiet });
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

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
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

function main() {
  const requireKey = process.argv.includes("--require-encryption-key");
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
    return;
  }
  if (missing.length > 0) {
    console.warn(
      `[gen-nango-env] WARNING: not set in .env.local: ${missing.join(", ")}. ` +
        "nango-server would start with an UNENCRYPTED secret store.",
    );
  }

  mkdirSync(outDir, { recursive: true });
  // 0600 + unconditional chmod: the `mode` option only applies on CREATE; an
  // existing file keeps its old mode after a rewrite otherwise.
  writeFileSync(outPath, serializeDotenv(env), { mode: 0o600 });
  chmodSync(outPath, 0o600);
  console.log(
    `[gen-nango-env] wrote ${path.relative(repoRoot, outPath)} ` +
      `(${Object.keys(env).length} keys${keyMissing ? ", encryption key MISSING" : ""}).`,
  );
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

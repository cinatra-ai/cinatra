#!/usr/bin/env node
/**
 * STAGING/TEST-ONLY flip of the `org_archive_activation` gate — cinatra#1942
 * V5 (archive program S6, Decision 8's testing/rollout reconciliation).
 *
 * WHY THIS EXISTS. The Danger-zone Archive control is hidden until the
 * activation gate is on (no dead button pre-flip), and the archive
 * transaction refuses `activation-gate-off`. The #1943 acceptance program's
 * 3-role live proof runs in a CONTROLLED production-equivalent environment
 * where the gate must be flipped ON for the test — after the V5 deploy,
 * before any real production flip. This script is that staging/test-only
 * path: the same `writeConnectorConfigToDatabase` write the production
 * closeout will use, but explicitly opt-in-fenced so it can never be the
 * production activation.
 *
 * ⛔ THE PRODUCTION FLIP IS NOT THIS SCRIPT. Production activation is the
 * OWNER-GATED V6 closeout (its own script + preflight report + runbook,
 * riding a formal owner approval) — see the #1942 design, Decision 10. This
 * script REFUSES to run unless the environment carries the explicit staging
 * opt-in below, which no production runbook ever sets.
 *
 * Guards (BOTH required — PR #2273 hardening; see the residual-risk note):
 *   1. `CINATRA_ORG_ARCHIVE_STAGING_FLIP=allow` must be present in the
 *      environment (the e2e/staging harness sets it; nothing else does).
 *   2. `--i-verified-staging-host=<host>` must be passed on the CLI and must
 *      equal the actual hostname parsed from `SUPABASE_DB_URL` — the
 *      database written is whatever `SUPABASE_DB_URL` points at, and this is
 *      an explicit, logged, per-invocation affirmation of that host. Both
 *      checks run and are resolved from raw argv/env BEFORE `@/lib/database`
 *      (and the live Postgres pool it opens on import) is ever loaded, so a
 *      refusal never touches the target database at all.
 *
 * ⚠️ RESIDUAL RISK (say this plainly, do not overclaim): cinatra instances
 * are self-hosted and per-deployment — there is NO trustworthy in-database
 * "this is staging" marker anywhere in the schema (checked
 * `instance_identity` / `cinatra.metadata` — nothing carries an
 * environment/instance-tier flag), and no canonical "this hostname is
 * production" registry exists in this repo to check against (self-hosted
 * production instances can be named anything). Neither guard above
 * CRYPTOGRAPHICALLY proves the target is staging:
 *   - the opt-in env var is still just a caller-controlled flag;
 *   - the host-affirmation flag only proves the operator TYPED the host they
 *     believe `SUPABASE_DB_URL` resolves to — it catches a STALE/mistaken
 *     `SUPABASE_DB_URL` (the classic "forgot to switch shells" accident) by
 *     forcing a fresh, explicit, per-run statement of intent instead of a
 *     silently-reused env flag, but an operator who deliberately points
 *     `SUPABASE_DB_URL` at production AND types that same host for
 *     `--i-verified-staging-host` will not be stopped. That operator already
 *     holds production DB credentials, which is the actual trust boundary —
 *     this script narrows the accidental-misfire surface, it does not
 *     replace credential-level access control. A real fix needs a canonical,
 *     server-issued environment identity (e.g. a value stamped into the DB
 *     at provisioning time that this script could read back) — no such
 *     mechanism exists in this codebase today; flagged for the V6
 *     owner-gated closeout to consider providing one, not solved here.
 *   - an environment-mode sniff (NODE_ENV / CINATRA_RUNTIME_MODE) is
 *     deliberately NOT used as a refusal signal: the #1943 acceptance
 *     program's live proof legitimately runs in a production-equivalent CI
 *     build with NODE_ENV=production, so that signal has known false
 *     positives against the documented legitimate use of this script.
 *
 * Usage:
 *   CINATRA_ORG_ARCHIVE_STAGING_FLIP=allow \
 *     node --import tsx scripts/ops/flip-org-archive-activation-staging.mjs \
 *       --on --i-verified-staging-host=<host-from-SUPABASE_DB_URL>
 *   CINATRA_ORG_ARCHIVE_STAGING_FLIP=allow \
 *     node --import tsx scripts/ops/flip-org-archive-activation-staging.mjs \
 *       --off --i-verified-staging-host=<host-from-SUPABASE_DB_URL>
 *
 * Idempotent: writes `{enabled:true}` / `{enabled:false}` unconditionally and
 * verifies by reading the row back — via a direct, cache-bypassing persisted
 * read (`readMetadataValueInternal`, the same primitive
 * `readConnectorConfigFromDatabase` falls back to on a cache miss), NOT
 * through the connector-config in-process TTL cache, so a write that lands in
 * cache but fails to persist (or diverges from durable storage some other
 * way) is caught instead of silently read back from the cache the write just
 * populated. `--off` is the staging half of the two-step rollback runbook
 * (stop new archives; already-archived orgs are recovered via the ungated
 * Unarchive control, never by this script).
 *
 * Exit codes: 0 = flipped+verified · 1 = refused/failed · 2 = usage error.
 */
import { pathToFileURL } from "node:url";

export const STAGING_FLIP_OPTIN_ENV = "CINATRA_ORG_ARCHIVE_STAGING_FLIP";
export const STAGING_FLIP_OPTIN_VALUE = "allow";
export const STAGING_HOST_FLAG = "--i-verified-staging-host=";
const CONFIG_KEY = "org_archive_activation";

/**
 * Extract the `--i-verified-staging-host=<host>` value from argv, or null
 * when absent/blank. Pure string parsing — no env/DB access.
 */
export function parseStagingHostFlag(argv) {
  const hit = (argv ?? []).find(
    (a) => typeof a === "string" && a.startsWith(STAGING_HOST_FLAG),
  );
  if (!hit) return null;
  const value = hit.slice(STAGING_HOST_FLAG.length).trim();
  return value.length > 0 ? value : null;
}

/**
 * Parse the hostname out of a postgres connection string. Returns null when
 * the string is missing/unparseable — callers MUST treat null as "cannot
 * verify" and refuse, never as a pass.
 */
export function resolveConnectionHost(connectionString) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    return null;
  }
  try {
    const hostname = new URL(connectionString).hostname;
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Pure decision function: returns a refusal message when the host-affirmation
 * fence fails, or null when it passes. Shared by the pre-import check in
 * `main()` (so a mismatch never loads `@/lib/database`) and the injectable
 * core (so the fence itself stays independently unit-testable).
 */
export function describeHostMismatch(affirmedHost, actualHost) {
  if (!actualHost) {
    return (
      `refusing: could not determine the target database host from SUPABASE_DB_URL. ` +
      `This script refuses to guess at a staging/production boundary when the target ` +
      `host cannot even be resolved.`
    );
  }
  if (!affirmedHost) {
    return (
      `refusing: ${STAGING_HOST_FLAG}<host> is required and must equal the actual ` +
      `connection host (currently "${actualHost}"). This is an explicit, logged, ` +
      `per-run affirmation of the target — it does not by itself prove the host is ` +
      `staging, only that you typed the host you believe you are pointing at (see the ` +
      `residual-risk note in this file's header).`
    );
  }
  if (affirmedHost.toLowerCase() !== actualHost.toLowerCase()) {
    return (
      `refusing: ${STAGING_HOST_FLAG}${affirmedHost} does not match the actual connection ` +
      `host "${actualHost}". Refusing — this is exactly the guard against a stale or ` +
      `mistaken SUPABASE_DB_URL.`
    );
  }
  return null;
}

/**
 * The injectable core (unit-tested with fake read/write/readPersisted; the
 * CLI wires the real connector-config store + the cache-bypassing metadata
 * reader). Returns `{ ok, message }` — the CLI maps `ok` to the exit code and
 * prints the message.
 */
export async function runStagingArchiveGateFlip({
  mode,
  env,
  write,
  read,
  readPersisted,
  affirmedHost,
  actualHost,
}) {
  if (mode !== "on" && mode !== "off") {
    return { ok: false, usage: true, message: `unknown mode ${String(mode)} — use --on or --off` };
  }
  if (env[STAGING_FLIP_OPTIN_ENV] !== STAGING_FLIP_OPTIN_VALUE) {
    return {
      ok: false,
      message:
        `refusing: ${STAGING_FLIP_OPTIN_ENV}=${STAGING_FLIP_OPTIN_VALUE} is not set. ` +
        `This script is the STAGING/TEST-ONLY gate flip; the production activation is the ` +
        `owner-gated V6 closeout (cinatra#1942 Decision 10), never this script.`,
    };
  }
  // Independent host-affirmation fence (PR #2273 hardening) — kept here too
  // (not just in main()'s pre-import check) so the core stays the single,
  // directly-testable arbiter of every refusal reason.
  const hostRefusal = describeHostMismatch(affirmedHost, actualHost);
  if (hostRefusal) {
    return { ok: false, message: hostRefusal };
  }
  const enabled = mode === "on";
  const before = read(CONFIG_KEY);
  write(CONFIG_KEY, { enabled });
  // Cache-bypassing verification read (PR #2273 hardening): `read` above may
  // be backed by the connector-config in-process TTL cache, which `write`
  // itself just repopulated with the value we intended to persist — reading
  // it back through that same cache would only prove the cache agrees with
  // itself, never that the write actually reached durable storage.
  // `readPersisted` MUST go straight to the backing store.
  const after = readPersisted(CONFIG_KEY);
  if (after?.enabled !== enabled) {
    return {
      ok: false,
      message: `write did not verify against persisted storage: read back ${JSON.stringify(after)} after writing {enabled:${String(enabled)}}`,
    };
  }
  return {
    ok: true,
    message:
      `org_archive_activation: ${JSON.stringify(before)} -> {enabled:${String(enabled)}} (verified against persisted storage). ` +
      (enabled
        ? "Archive controls are now live in THIS environment only."
        : "New archives are now refused; recover any archived org via the ungated Unarchive control."),
  };
}

async function main() {
  const mode = process.argv[2] === "--on" ? "on" : process.argv[2] === "--off" ? "off" : process.argv[2];

  // Usage errors (bad/missing mode) take precedence over the host-affirmation
  // refusal below, same as before this fence existed — `--bogus-mode` (with
  // or without a host flag) is still a exit-2 usage error, not a exit-1
  // refusal message about the host.
  if (mode !== "on" && mode !== "off") {
    process.stderr.write(`unknown mode ${String(mode)} — use --on or --off\n`);
    process.exit(2);
    return;
  }

  const affirmedHost = parseStagingHostFlag(process.argv);
  const actualHost = resolveConnectionHost(process.env.SUPABASE_DB_URL);

  // Resolved and checked from raw argv/env ONLY — refuse before `@/lib/database`
  // (which opens a live Postgres connection pool on import via the sync
  // bridge) is ever loaded, so a mismatch never touches the target at all.
  const hostRefusal = describeHostMismatch(affirmedHost, actualHost);
  if (hostRefusal) {
    process.stderr.write(`${hostRefusal}\n`);
    process.exit(1);
    return;
  }

  const { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } =
    await import("@/lib/database");
  // `readMetadataValueInternal` is the same DB-only primitive
  // `readConnectorConfigFromDatabase` itself falls back to on a cache miss —
  // imported straight from the metadata leaf so the post-write verification
  // always goes to the backing store, never through the connector-config TTL
  // cache the write just populated. Safe to read raw here (no unseal step)
  // because CONFIG_KEY ("org_archive_activation") is not in the connector
  // secret-field allow-map (`@/lib/connector-config-secret-fields.ts`,
  // currently only "nango") — it never carries an at-rest-sealed value.
  const { readMetadataValueInternal } = await import("@/lib/database-metadata");
  const result = await runStagingArchiveGateFlip({
    mode,
    env: process.env,
    affirmedHost,
    actualHost,
    read: (key) => readConnectorConfigFromDatabase(key, null),
    write: (key, value) => writeConnectorConfigToDatabase(key, value),
    readPersisted: (key) => readMetadataValueInternal(`connector_config:${key}`, null),
  });
  process.stderr.write(`${result.message}\n`);
  process.exit(result.ok ? 0 : result.usage ? 2 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    process.stderr.write(`flip-org-archive-activation-staging: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

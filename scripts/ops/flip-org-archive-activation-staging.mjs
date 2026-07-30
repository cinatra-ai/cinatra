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
 * Guard: `CINATRA_ORG_ARCHIVE_STAGING_FLIP=allow` must be present in the
 * environment (the e2e/staging harness sets it; nothing else does). The
 * database written is whatever `SUPABASE_DB_URL` points at — the fence is
 * the explicit opt-in, not an environment sniff (a production-equivalent
 * CI build legitimately runs NODE_ENV=production).
 *
 * Usage:
 *   CINATRA_ORG_ARCHIVE_STAGING_FLIP=allow \
 *     node --import tsx scripts/ops/flip-org-archive-activation-staging.mjs --on
 *   CINATRA_ORG_ARCHIVE_STAGING_FLIP=allow \
 *     node --import tsx scripts/ops/flip-org-archive-activation-staging.mjs --off
 *
 * Idempotent: writes `{enabled:true}` / `{enabled:false}` unconditionally and
 * verifies by reading the row back. `--off` is the staging half of the
 * two-step rollback runbook (stop new archives; already-archived orgs are
 * recovered via the ungated Unarchive control, never by this script).
 *
 * Exit codes: 0 = flipped+verified · 1 = refused/failed · 2 = usage error.
 */
import { pathToFileURL } from "node:url";

export const STAGING_FLIP_OPTIN_ENV = "CINATRA_ORG_ARCHIVE_STAGING_FLIP";
export const STAGING_FLIP_OPTIN_VALUE = "allow";
const CONFIG_KEY = "org_archive_activation";

/**
 * The injectable core (unit-tested with fake read/write; the CLI wires the
 * real connector-config store). Returns `{ ok, message }` — the CLI maps
 * `ok` to the exit code and prints the message.
 */
export async function runStagingArchiveGateFlip({ mode, env, write, read }) {
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
  const enabled = mode === "on";
  const before = read(CONFIG_KEY);
  write(CONFIG_KEY, { enabled });
  const after = read(CONFIG_KEY);
  if (after?.enabled !== enabled) {
    return {
      ok: false,
      message: `write did not verify: read back ${JSON.stringify(after)} after writing {enabled:${String(enabled)}}`,
    };
  }
  return {
    ok: true,
    message:
      `org_archive_activation: ${JSON.stringify(before)} -> {enabled:${String(enabled)}} (verified). ` +
      (enabled
        ? "Archive controls are now live in THIS environment only."
        : "New archives are now refused; recover any archived org via the ungated Unarchive control."),
  };
}

async function main() {
  const mode = process.argv[2] === "--on" ? "on" : process.argv[2] === "--off" ? "off" : process.argv[2];
  const { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } =
    await import("@/lib/database");
  const result = await runStagingArchiveGateFlip({
    mode,
    env: process.env,
    read: (key) => readConnectorConfigFromDatabase(key, null),
    write: (key, value) => writeConnectorConfigToDatabase(key, value),
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

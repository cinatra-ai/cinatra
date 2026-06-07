#!/usr/bin/env node
// One-shot destructive cutover for the Twenty CRM migration: drains in-flight
// CRM-touching agent runs, drains the Graphiti projection outbox, deletes
// every account / contact / list pointer row from `cinatra.objects` in a
// single transaction. Smoke verification is a manual operator step
// afterward (see scripts/twenty-bootstrap/twenty-cutover.md).
//
// The legacy CRM surfaces have been retired (agents + list-picker route
// through the crm_* facade; the lists_* MCP primitives are unregistered; the
// entity-accounts/entity-contacts/lists UI deeplinks to Twenty). The
// destructive path is therefore UNLOCKED — `--yes` is the only flag required
// to run the wipe. `--dry-run` stays the default safe mode (a read-only
// probe). The dev-DB guard (`assertDevDatabase`) still blocks remote hosts +
// non-cinatra schemas unless `--i-know-this-is-dev` is passed (test-DB only).
//
// Usage:
//   node scripts/twenty-bootstrap/cutover-wipe-and-reseed.mjs --dry-run
//   node scripts/twenty-bootstrap/cutover-wipe-and-reseed.mjs --dry-run --i-know-this-is-dev
//
//   (destructive path — operator action, against the LOCAL dev DB:)
//   node scripts/twenty-bootstrap/cutover-wipe-and-reseed.mjs --yes
//
//   (--i-know-this-is-dev is a SEPARATE escape hatch for a non-localhost test
//   DB — it relaxes the dev-DB host/schema guard, so only pass it knowingly,
//   never as part of the default command.)
//
// Exit codes:
//   0  cutover completed (or dry-run completed without surfacing blockers)
//   1  blocker: active agent runs / undrained outbox / non-dev DB
//   2  invocation error: missing env / bad flags
//   3  runtime error during the delete

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "pg";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KNOWN_FLAGS = new Set([
  "--dry-run",
  "--yes",
  "--i-know-this-is-dev",
  "--drain-outbox-now",
]);

const RAW_ARGS = process.argv.slice(2);
const ARGV = new Set(RAW_ARGS);
const UNKNOWN_FLAGS = RAW_ARGS.filter((arg) => !KNOWN_FLAGS.has(arg));
const FLAGS = {
  dryRun: ARGV.has("--dry-run"),
  yes: ARGV.has("--yes"),
  knowDev: ARGV.has("--i-know-this-is-dev"),
  drainOutboxNow: ARGV.has("--drain-outbox-now"),
};

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

const CRM_TYPE_IDS = [
  "@cinatra-ai/entity-accounts:account",
  "@cinatra-ai/entity-contacts:contact",
  "@cinatra-ai/lists:list",
];

// Mirrors packages/agents/src/store.ts AgentRunStatus minus
// TERMINAL_RUN_STATUSES ({completed, failed, stopped}). Keep in sync if the
// union grows.
const NONTERMINAL_AGENT_RUN_STATES = [
  "queued",
  "running",
  "pending_approval",
  "pending_input",
  "armed",
  "pending_trigger",
  "waiting_trigger",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logStep(n, name, status, extra = "") {
  const tag = status === "ok" ? "✓" : status === "skip" ? "·" : "✗";
  const line = `[cutover step ${n}/6] ${tag} ${name}${extra ? `  (${extra})` : ""}`;
  process.stdout.write(`${line}\n`);
}

function die(code, message) {
  process.stderr.write(`[cutover] ERROR: ${message}\n`);
  process.exit(code);
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function confirmInteractive(prompt) {
  if (FLAGS.yes) return true;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${prompt} (type 'yes' to proceed) > `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Step 1 — assert this is a dev DB
// ---------------------------------------------------------------------------

export function assertDevDatabase(connStr, schema, { knowDev } = { knowDev: false }) {
  if (!connStr) {
    throw new Error("SUPABASE_DB_URL is required");
  }
  let url;
  try {
    url = new URL(connStr);
  } catch (err) {
    throw new Error(`SUPABASE_DB_URL is not a valid URL: ${err.message}`);
  }
  // For a bracketed IPv6 URL like postgres://...@[::1]:5432/, `url.hostname`
  // strips the brackets and returns the raw form (e.g. "::1"). Unbracketed
  // `@::1:5432` is invalid per RFC 3986 and would have failed the new URL()
  // parse above.
  const host = url.hostname;
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  // Cinatra dev schemas are `cinatra` or `cinatra_<slug>`. Anything else
  // strongly suggests a non-dev target and is refused without the override.
  const isDevSchema = schema === "cinatra" || /^cinatra_/.test(schema);
  if (isLocalHost && isDevSchema) return { ok: true, host, schema };
  if (knowDev) {
    return { ok: true, host, schema, override: true };
  }
  throw new Error(
    `target appears non-dev: host=${host} schema=${schema}. Pass --i-know-this-is-dev to override.`,
  );
}

// ---------------------------------------------------------------------------
// Step 2 — assert no nonterminal CRM-touching agent runs
// ---------------------------------------------------------------------------

async function checkActiveCrmRuns(client, schema) {
  // `agent_runs` has NO `agent_slug` column (the original draft of this query
  // assumed one). The human-readable identifier lives on
  // `agent_templates.name`, reachable via `agent_runs.template_id`. LEFT JOIN
  // so a row with a missing template still surfaces (the abort message falls
  // back to the run id).
  const sql = `
    SELECT r.id, t.name AS agent_name, r.status
      FROM ${quoteIdent(schema)}."agent_runs" r
      LEFT JOIN ${quoteIdent(schema)}."agent_templates" t ON t.id = r.template_id
     WHERE r.status = ANY($1::text[])
       AND (
            r.input_params::text ILIKE '%@cinatra-ai/entity-accounts:account%'
         OR r.input_params::text ILIKE '%@cinatra-ai/entity-contacts:contact%'
         OR r.input_params::text ILIKE '%@cinatra-ai/lists:list%'
       )
  `;
  const result = await client.query(sql, [NONTERMINAL_AGENT_RUN_STATES]);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Step 3 — Graphiti outbox drain check
// ---------------------------------------------------------------------------

async function countUnprocessedOutbox(client, schema) {
  // The outbox lives in `graphiti_projection_outbox` and joins to
  // `cinatra.objects` by `object_id` to identify the type. Unprocessed rows
  // pointing at a CRM type would orphan after the delete.
  const sql = `
    SELECT count(*)::int AS n
      FROM ${quoteIdent(schema)}."graphiti_projection_outbox" o
      JOIN ${quoteIdent(schema)}."objects" obj ON obj.id = o.object_id
     WHERE o.processed_at IS NULL
       AND obj.type = ANY($1::text[])
  `;
  const result = await client.query(sql, [CRM_TYPE_IDS]);
  return result.rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Step 4 — delete (single transaction)
// ---------------------------------------------------------------------------

async function executeWipe(client, schema, { dryRun }) {
  const countSql = `
    SELECT count(*)::int AS n
      FROM ${quoteIdent(schema)}."objects"
     WHERE type = ANY($1::text[])
  `;
  const pre = await client.query(countSql, [CRM_TYPE_IDS]);
  const preCount = pre.rows[0]?.n ?? 0;

  if (dryRun) {
    return { dryRun: true, preCount, deletedCount: 0, postCount: preCount };
  }

  // Capture victim object ids BEFORE the delete so the post-transaction
  // outbox assertion can find orphan outbox rows (joining outbox -> objects
  // after delete would lose those rows to the delete itself).
  const victimsRes = await client.query(
    `SELECT id FROM ${quoteIdent(schema)}."objects" WHERE type = ANY($1::text[])`,
    [CRM_TYPE_IDS],
  );
  const victimIds = victimsRes.rows.map((r) => r.id);

  await client.query("BEGIN");
  try {
    const del = await client.query(
      `DELETE FROM ${quoteIdent(schema)}."objects"
        WHERE type = ANY($1::text[])
       RETURNING id`,
      [CRM_TYPE_IDS],
    );
    const deletedCount = del.rowCount ?? 0;
    const post = await client.query(countSql, [CRM_TYPE_IDS]);
    const postCount = post.rows[0]?.n ?? 0;
    if (postCount !== 0) {
      throw new Error(
        `post-delete count is ${postCount}, expected 0 — aborting (rows survived inside the transaction window?)`,
      );
    }
    // Assert no unprocessed outbox rows for the now-deleted victim ids.
    // We use the captured id list (not a join through `objects`) because the
    // objects rows have just been removed.
    let postOutbox = 0;
    if (victimIds.length > 0) {
      const outboxRes = await client.query(
        `SELECT count(*)::int AS n
           FROM ${quoteIdent(schema)}."graphiti_projection_outbox"
          WHERE object_id = ANY($1::text[])
            AND processed_at IS NULL`,
        [victimIds],
      );
      postOutbox = outboxRes.rows[0]?.n ?? 0;
    }
    if (postOutbox !== 0) {
      throw new Error(
        `post-delete unprocessed outbox rows for victim ids: ${postOutbox} — aborting`,
      );
    }
    await client.query("COMMIT");
    return { dryRun: false, preCount, deletedCount, postCount, postOutbox };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 5 / 6 — smoke
// ---------------------------------------------------------------------------

function logSmokeGuidance() {
  process.stdout.write(
    "[cutover step 5/6] · restart guidance — operator action required:\n" +
      "    1. pnpm dev (or restart the production app + workers)\n" +
      "    2. Wait for /api/health to return 200\n" +
      "    3. Run the manual smoke checks in scripts/twenty-bootstrap/twenty-cutover.md\n",
  );
}

function logSmokePending() {
  process.stdout.write(
    "[cutover step 6/6] · smoke check pending — restart the app + workers, then run the manual smoke checks in scripts/twenty-bootstrap/twenty-cutover.md (verify the CRM routes render <OpenInTwenty> and a CRM read resolves against Twenty).\n",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (UNKNOWN_FLAGS.length > 0) {
    die(
      2,
      `unknown flag(s): ${UNKNOWN_FLAGS.join(", ")}. Known: ${[...KNOWN_FLAGS].join(", ")}`,
    );
  }
  if (!FLAGS.dryRun && !FLAGS.yes) {
    die(2, "destructive run requires --yes (or use --dry-run for a read-only probe)");
  }

  // Step 1
  let dbAssertion;
  try {
    dbAssertion = assertDevDatabase(SUPABASE_DB_URL, SUPABASE_SCHEMA, {
      knowDev: FLAGS.knowDev,
    });
  } catch (err) {
    die(1, err.message);
  }
  logStep(
    1,
    "dev DB assertion",
    "ok",
    `host=${dbAssertion.host} schema=${dbAssertion.schema}${dbAssertion.override ? " (override)" : ""}`,
  );

  const client = new Client({ connectionString: SUPABASE_DB_URL });
  await client.connect();

  try {
    // Step 2
    const activeRuns = await checkActiveCrmRuns(client, SUPABASE_SCHEMA);
    if (activeRuns.length > 0) {
      logStep(
        2,
        "no nonterminal CRM-touching agent runs",
        "fail",
        `${activeRuns.length} active`,
      );
      for (const row of activeRuns) {
        process.stdout.write(`    - ${row.id} agent=${row.agent_name ?? row.id} status=${row.status}\n`);
      }
      die(
        1,
        "drain or cancel the listed runs via agent_run_stop / agent_runs_stop, then re-run.",
      );
    }
    logStep(2, "no nonterminal CRM-touching agent runs", "ok", "0 active");

    // Step 3
    const outboxN = await countUnprocessedOutbox(client, SUPABASE_SCHEMA);
    if (outboxN > 0 && !FLAGS.drainOutboxNow) {
      logStep(
        3,
        "Graphiti outbox drained",
        "fail",
        `${outboxN} unprocessed`,
      );
      die(
        1,
        "wait for the outbox worker, or re-run with --drain-outbox-now to drop CRM-type outbox rows.",
      );
    }
    if (outboxN > 0 && !FLAGS.dryRun) {
      await client.query(
        `DELETE FROM ${quoteIdent(SUPABASE_SCHEMA)}."graphiti_projection_outbox" o
          USING ${quoteIdent(SUPABASE_SCHEMA)}."objects" obj
          WHERE obj.id = o.object_id
            AND obj.type = ANY($1::text[])
            AND o.processed_at IS NULL`,
        [CRM_TYPE_IDS],
      );
    }
    logStep(
      3,
      "Graphiti outbox drained",
      "ok",
      outboxN === 0
        ? "0"
        : FLAGS.dryRun
          ? `${outboxN} (dry-run: would drain with --drain-outbox-now)`
          : `${outboxN} cleared`,
    );

    // Step 4 — confirm + delete
    if (!FLAGS.dryRun) {
      const confirmed = await confirmInteractive(
        `About to delete ALL rows of type ${JSON.stringify(CRM_TYPE_IDS)} from ${SUPABASE_SCHEMA}.objects on ${dbAssertion.host}`,
      );
      if (!confirmed) {
        die(1, "operator declined the destructive step");
      }
    }

    let wipeResult;
    try {
      wipeResult = await executeWipe(client, SUPABASE_SCHEMA, { dryRun: FLAGS.dryRun });
    } catch (err) {
      logStep(4, "single-tx delete + assertions", "fail");
      die(3, err.message);
    }
    if (wipeResult.dryRun) {
      logStep(
        4,
        "single-tx delete + assertions",
        "skip",
        `dry-run: would delete ${wipeResult.preCount} rows`,
      );
    } else {
      logStep(
        4,
        "single-tx delete + assertions",
        "ok",
        `pre=${wipeResult.preCount} deleted=${wipeResult.deletedCount} post=${wipeResult.postCount} outbox=${wipeResult.postOutbox}`,
      );
    }

    // Step 5 + 6
    logSmokeGuidance();
    logSmokePending();
  } finally {
    await client.end();
  }
}

// Allow this module to be imported by tests without auto-running.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[cutover] unhandled: ${err.stack ?? err.message}\n`);
    process.exit(3);
  });
}

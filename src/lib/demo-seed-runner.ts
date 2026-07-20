import "server-only";

// Pending-demo-seed boot runner (`cinatra install demo`, cinatra#1238 item 3).
//
// The monolithic `scripts/seed.mjs` demo dataset (ACME Group) INTENTIONALLY
// no-ops until a HUMAN platform admin exists — it must never fabricate/promote a
// machine admin (the one-shot first-human admin slot belongs to the first real
// registrant, cinatra#1135). So a demo install cannot seed the monolithic
// dataset synchronously at setup time on a fresh DB. Instead the demo overlay
// seeds it LAZILY: on each strict-dev demo boot, once a human admin has
// registered AND the seed has not already COMPLETED, it fires exactly once.
//
// `shouldRunDemoSeed` (install-profile.ts) is the PURE decision; this module is
// the runner that supplies the two runtime facts it reads from the DB and, when
// the gate opens, CLAIMS the one-shot atomically and dispatches the seed. The
// orchestration is dependency-injected so the gate + claim wiring is unit-
// testable without a live DB or a child process.
//
// Exactly-once + crash-safety (codex convergence, #1291):
//   - `alreadySeeded` reads a durable COMPLETION marker written ONLY after the
//     child exits 0 — NOT the seed's early-created `org-acme-group` (which would
//     make a mid-seed crash permanently skip, leaving a partial dataset).
//   - the claim is a single atomic `INSERT … ON CONFLICT … WHERE … RETURNING`
//     against the core-store `metadata` table, so two racing dev boots cannot
//     both dispatch the destructive seed; the loser skips.
//
// Destructive-re-claim fix (cinatra#1238 live acceptance): a `failed` marker is
// NOT re-claimable — it is TERMINAL like `completed`. The monolithic seed opens
// with a `TRUNCATE` wipe, so an auto-re-claiming `failed` state made EVERY boot
// re-run the destructive wipe → partial seed → fail, forever (a boot loop that
// never converged and repeatedly destroyed the operator's data). A failed seed
// now requires an EXPLICIT operator reset (`resetDemoSeedStateInDb`, which
// CAS-clears ONLY a `failed` marker) before the next boot will re-attempt — the
// wipe never silently re-runs. `completed` still never re-claims (exactly-once).

import { spawn } from "node:child_process";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  readRawMetadataStringFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";
import { postgresSchema } from "@/lib/postgres-config";
import { isDemoProfile, isStrictDevelopmentRuntime, shouldRunDemoSeed } from "@/lib/install-profile";

/** Core-store `metadata` key holding the one-shot demo-seed state. */
export const DEMO_SEED_STATE_KEY = "demo:monolithic-seed:state";

// Raw stored forms (the metadata store JSON-encodes values, so the persisted
// bytes are the quoted JSON strings — keep the comparisons byte-exact). Exported
// for the real-Postgres claim test (byte-exact fixtures).
export const RUNNING_RAW = JSON.stringify("running");
export const COMPLETED_RAW = JSON.stringify("completed");
export const FAILED_RAW = JSON.stringify("failed");

/** The two runtime facts `shouldRunDemoSeed` consumes. */
export interface DemoSeedFacts {
  /** A HUMAN platform admin exists (role contains `admin`, non-seed id, human userType). */
  humanAdminExists: boolean;
  /** The monolithic demo dataset seed has already COMPLETED (durable marker). */
  alreadySeeded: boolean;
}

export type DemoSeedOutcome =
  | { status: "skipped"; reason: string }
  | { status: "seeded" }
  | { status: "error"; reason: string };

export interface DemoSeedDeps {
  /** Read the two runtime facts (real impl hits the DB; tests inject a fake). */
  readFacts: () => Promise<DemoSeedFacts> | DemoSeedFacts;
  /** Atomically claim the one-shot; `true` = this boot won and must seed. */
  claim: () => Promise<boolean> | boolean;
  /** Dispatch the monolithic seed (real impl spawns `scripts/seed.mjs`). */
  runMonolithicSeed: () => Promise<void>;
  /** Record the durable COMPLETION marker (only after a successful seed). */
  markCompleted: () => Promise<void> | void;
  /** Release the claim as `failed` so a later boot can retry. */
  markFailed: () => Promise<void> | void;
  log?: (message: string) => void;
  env?: Record<string, string | undefined>;
}

/**
 * The dependency-injected orchestration around `shouldRunDemoSeed`. Pure control
 * flow: cheap env gate → read facts → gate → ATOMIC claim → dispatch → mark.
 * Never throws (soft-fails to an `error` outcome) so the boot phase that calls
 * it is always net-safe.
 */
export async function runPendingDemoSeed(deps: DemoSeedDeps): Promise<DemoSeedOutcome> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});

  // Cheap env pre-gate: never touch the DB off a strict-dev demo instance.
  if (!isStrictDevelopmentRuntime(env) || !isDemoProfile(env)) {
    return { status: "skipped", reason: "not a strict-development demo instance" };
  }

  let facts: DemoSeedFacts;
  try {
    facts = await deps.readFacts();
  } catch (err) {
    return { status: "error", reason: `fact read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!shouldRunDemoSeed(facts, env)) {
    const reason = !facts.humanAdminExists
      ? "awaiting first-human admin registration"
      : "demo dataset already seeded";
    return { status: "skipped", reason };
  }

  // Atomic one-shot claim — the loser of a two-boot race skips here (never
  // double-dispatches the destructive seed).
  let claimed: boolean;
  try {
    claimed = await deps.claim();
  } catch (err) {
    return { status: "error", reason: `seed claim failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!claimed) {
    // Lost the race, OR the marker is terminal (`completed` = done; `failed` =
    // needs an explicit operator reset before it re-attempts — it will NOT
    // silently re-run the destructive wipe).
    return { status: "skipped", reason: "one-shot not claimable (another boot won, or completed/failed)" };
  }

  log("human admin present + demo dataset absent → seeding monolithic ACME demo dataset");
  try {
    await deps.runMonolithicSeed();
  } catch (err) {
    // Latch the one-shot `failed` (TERMINAL). The next boot will NOT auto-retry
    // — that is the fix for the destructive re-claim loop (the seed's opening
    // TRUNCATE must not silently re-run every boot). An operator investigates,
    // fixes the cause, then clears the marker (resetDemoSeedStateInDb) to
    // re-arm the one attempt.
    try {
      await deps.markFailed();
    } catch {
      /* best-effort; a `failed` marker is terminal regardless */
    }
    log(
      "monolithic seed FAILED — the one-shot is now latched `failed` and will NOT auto-retry " +
        "(no destructive re-wipe on the next boot). After fixing the cause, clear the marker to re-arm it: " +
        "DELETE FROM <schema>.metadata WHERE key = 'demo:monolithic-seed:state' AND value = '\"failed\"';",
    );
    return { status: "error", reason: `monolithic seed failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await deps.markCompleted();
  log("monolithic ACME demo dataset seeded");
  return { status: "seeded" };
}

/** The schema-qualified `metadata` table identifier (mirrors the core store's quoting). */
function metadataTable(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"."metadata"`;
}

/**
 * Read the two demo-seed facts from Postgres (synchronous worker query; the same
 * mechanism `dev-fixture-seeder` uses at boot).
 *   - humanAdminExists: a Better Auth user with role containing `admin`, a
 *     non-seed id (seeded ids are `usr-…`; real registrations are not) and a
 *     human userType — exactly the "real registrant admin" the seed requires.
 *   - alreadySeeded: the durable COMPLETION marker is present (NOT the seed's
 *     early-created org, so a mid-seed crash never wedges a permanent skip).
 */
export function readDemoSeedFactsFromDb(): DemoSeedFacts {
  const connectionString = getPostgresConnectionString();
  const [adminResult] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `SELECT 1 FROM public."user"
               WHERE EXISTS (
                 SELECT 1 FROM regexp_split_to_table(COALESCE(role, ''), '\\s*,\\s*') r WHERE r = 'admin'
               )
               AND id NOT LIKE 'usr-%'
               AND COALESCE("userType", 'human') = 'human'
               LIMIT 1`,
      },
    ],
  });
  // readRawMetadataStringFromDatabase ensures the core schema/table exist first.
  const stateRaw = readRawMetadataStringFromDatabase(DEMO_SEED_STATE_KEY);
  return {
    humanAdminExists: (adminResult?.rows.length ?? 0) > 0,
    alreadySeeded: stateRaw === COMPLETED_RAW,
  };
}

/**
 * Build the atomic one-shot claim statement for a given metadata-table
 * identifier. A single statement: INSERT the `running` marker, or on conflict
 * take it over ONLY when the stored marker is none of `running`, `completed`,
 * `failed` (i.e. an absent-race). RETURNING yields a row IFF this boot won.
 *
 * `failed` is TERMINAL (cinatra#1238): a crashed seed does NOT auto-re-claim, so
 * the monolithic seed's opening TRUNCATE never silently re-wipes on every boot.
 * Retry requires an explicit `resetDemoSeedStateInDb`. Extracted as a pure
 * builder so the exact SQL is provable against a real Postgres metadata table.
 */
export function buildDemoSeedClaimQuery(table: string): { text: string; values: string[] } {
  return {
    text: `INSERT INTO ${table} AS m (key, value)
           VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value
           WHERE m.value NOT IN ($3, $4, $5)
           RETURNING m.value`,
    values: [DEMO_SEED_STATE_KEY, RUNNING_RAW, RUNNING_RAW, COMPLETED_RAW, FAILED_RAW],
  };
}

/**
 * Atomically claim the one-shot. RETURNING yields a row IFF this boot won the
 * claim; a `completed` OR `failed` marker is terminal and never re-claims.
 */
export function claimDemoSeedInDb(): boolean {
  const connectionString = getPostgresConnectionString();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [buildDemoSeedClaimQuery(metadataTable())],
  });
  return (result?.rows.length ?? 0) > 0;
}

/** Write the durable COMPLETION marker (only after a clean seed). */
export function markDemoSeedCompletedInDb(): void {
  writeMetadataValueToDatabase(DEMO_SEED_STATE_KEY, "completed");
}

/** Release the claim as `failed`. TERMINAL — a later boot will NOT auto-retry
 *  (no destructive re-wipe); an operator must `resetDemoSeedStateInDb` first. */
export function markDemoSeedFailedInDb(): void {
  writeMetadataValueToDatabase(DEMO_SEED_STATE_KEY, "failed");
}

/**
 * Operator reset: CAS-clear the one-shot marker so the next demo boot re-attempts
 * a previously `failed` seed. Deletes the marker ONLY when it is `failed` (never
 * a `completed` or an in-flight `running` marker), so it can never re-arm a
 * healthy exactly-once state. Returns true when a failed marker was cleared.
 *
 * Manual equivalent (psql):
 *   DELETE FROM <schema>.metadata
 *    WHERE key = 'demo:monolithic-seed:state' AND value = '"failed"';
 */
export function resetDemoSeedStateInDb(): boolean {
  const connectionString = getPostgresConnectionString();
  const [result] = runPostgresQueriesSync({
    connectionString,
    queries: [
      {
        text: `DELETE FROM ${metadataTable()} WHERE key = $1 AND value = $2 RETURNING key`,
        values: [DEMO_SEED_STATE_KEY, FAILED_RAW],
      },
    ],
  });
  return (result?.rows.length ?? 0) > 0;
}

/**
 * Dispatch the monolithic seed as a child `node scripts/seed.mjs`. `seed.mjs`
 * reads `SUPABASE_DB_URL` from the environment (already loaded into the dev
 * server process from `.env.local`), so the inherited env is sufficient — no
 * `--env-file` needed. Resolves on exit 0; rejects otherwise.
 */
export function spawnMonolithicSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/seed.mjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`scripts/seed.mjs exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

/** Boot-time entry: real DB facts + atomic claim + real child-process seed dispatch. */
export async function runPendingDemoSeedFromBoot(): Promise<DemoSeedOutcome> {
  return runPendingDemoSeed({
    readFacts: readDemoSeedFactsFromDb,
    claim: claimDemoSeedInDb,
    runMonolithicSeed: spawnMonolithicSeed,
    markCompleted: markDemoSeedCompletedInDb,
    markFailed: markDemoSeedFailedInDb,
    log: (message) => console.log(`[demo-seed] ${message}`),
  });
}

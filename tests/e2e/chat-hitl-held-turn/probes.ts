// THE OUT-OF-BROWSER PROBES (chat-hitl S9k, cinatra#2824).
//
// The DOM can only ever say what was drawn. #2824's acceptance is about what the
// RUNTIME did — a real held run, no queue job behind it, exactly one job after the
// decision — so every DOM claim in the flow is paired with a claim read straight
// out of Postgres and Redis. That pairing is the whole point: a card drawn over a
// run that was dispatched anyway would satisfy every selector in the spec and
// still be the defect this gate exists to catch.
import { Client } from "pg";
import { Queue } from "bullmq";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DUPLICATE_DISPATCH_CONTROL_DELAY_MS,
  DUPLICATE_DISPATCH_CONTROL_JOB_NAME,
  QUEUE_STATES_NAMING_A_RUN,
  countJobsNamingRun,
  duplicateDispatchControlJobId,
} from "./state-rules";

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();

/**
 * NO PRODUCTION-SHAPED DEFAULTS, DELIBERATELY.
 *
 * The sibling e2e suites fall back to `…@127.0.0.1:5432/postgres` and
 * `cinatra-background-jobs` when a variable is missing. For those suites that is a
 * convenience; for this one it is a correctness hole. This flow counts rows and
 * queue jobs, so a silent fallback would point it at whatever database and queue
 * happen to be on the machine — a developer's own stack, or another lane's — and
 * every count it takes would then describe someone else's runtime while reporting
 * on this one.
 *
 * So a missing variable is a REFUSAL, naming the variable. An unset environment
 * fails immediately and legibly instead of measuring the wrong world.
 */
function required(name: string): string {
  const value = process.env[name] ?? ENV_LOCAL[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is required by the chat-HITL held-turn suite and is not set (checked the ` +
        "environment and .env.local). This suite counts runs and queue jobs, so it refuses " +
        "to fall back to a shared default and measure a database or queue it does not own.",
    );
  }
  return value.trim();
}

export const DATABASE_URL = required("SUPABASE_DB_URL");
export const REDIS_URL = required("REDIS_URL");
/**
 * ITS OWN QUEUE, REQUIRED RATHER THAN DEFAULTED. "Exactly one job names this run"
 * is the load-bearing measurement, and it is only unambiguous on a queue nothing
 * else writes to.
 */
export const QUEUE_NAME = required("BULLMQ_QUEUE_NAME");
export const SCHEMA = process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface RunFacts {
  /** `queued` | `pending_input` | `pending_approval` | … — the run's own status. */
  status: string;
  /**
   * Whether the runtime recorded a present human. It is the carrier that makes a
   * chat-started run eligible to park at all, and it is SERVER-derived from the
   * launch frame — `humanPresent` is Omitted from the create input so no caller can
   * claim presence.
   */
  humanPresent: boolean | null;
}

/** The run row itself. Throws when the run does not exist — an absent run is never a pass. */
export async function readRunFacts(runId: string): Promise<RunFacts> {
  return withClient(async (c) => {
    const r = await c.query<{ status: string; human_present: boolean | null }>(
      `SELECT status, human_present FROM "${SCHEMA}"."agent_runs" WHERE id = $1`,
      [runId],
    );
    if (!r.rowCount) throw new Error(`no agent_runs row for ${runId}`);
    return { status: r.rows[0]!.status, humanPresent: r.rows[0]!.human_present };
  });
}

/**
 * The recommendation checkpoint's park row: `parked` while the person is deciding,
 * `released` once they have. `null` means the run never parked, which is the
 * difference between a real hold and a card drawn over a dispatched run.
 */
export async function readRecommendationParkStatus(runId: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ status: string }>(
      `SELECT status FROM "${SCHEMA}"."lifecycle_continuation_park"
        WHERE run_id = $1 AND checkpoint = 'recommendation'`,
      [runId],
    );
    return r.rowCount ? r.rows[0]!.status : null;
  });
}

export async function countRuns(): Promise<number> {
  return withClient(async (c) => {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${SCHEMA}"."agent_runs"`);
    return Number(r.rows[0]?.n ?? 0);
  });
}

/**
 * Confirm the run the BROWSER named is the run this database has, and that it is
 * the run the flow dispatched.
 *
 * There is no `newestRunId()` here on purpose. "The newest row in the table" is not
 * the run on screen — it is whatever was written last, by anyone — so a concurrent
 * or leftover run could satisfy every status, park and queue assertion in the flow
 * while the card being photographed belonged to something else entirely. That is a
 * VACUOUS PASS of precisely the DOM↔runtime pairing this suite exists to establish.
 *
 * The run id therefore comes from the transcript (the dispatch boundary prints it
 * into the very turn that carries the card), and this function checks the id the
 * browser gave against the template the flow meant to dispatch. Attribution flows
 * browser → database, never database → browser.
 */
export async function assertRunIsForPackage(runId: string, packageName: string): Promise<void> {
  const actual = await withClient(async (c) => {
    const r = await c.query<{ package_name: string | null }>(
      `SELECT t.package_name
         FROM "${SCHEMA}"."agent_runs" r
         JOIN "${SCHEMA}"."agent_templates" t ON t.id = r.template_id
        WHERE r.id = $1`,
      [runId],
    );
    if (!r.rowCount) throw new Error(`no agent_runs row for the run the transcript named: ${runId}`);
    return r.rows[0]!.package_name;
  });
  if (actual !== packageName) {
    throw new Error(
      `the run the transcript named (${runId}) belongs to ${actual}, not ${packageName} — ` +
        "the flow is measuring a different run from the one it dispatched",
    );
  }
}

/** The per-skill rejection evidence a Skip writes. */
export async function readRejectedRecommendations(runId: string): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ skill_id: string; recommendation_source: string }>(
      `SELECT skill_id, recommendation_source FROM "${SCHEMA}"."run_rejected_recommendations"
        WHERE run_id = $1 ORDER BY skill_id`,
      [runId],
    );
    return r.rows.map((row) => `${row.skill_id}:${row.recommendation_source}`);
  });
}

/** The pinned revisions a Confirm writes. */
export async function readSelectedSkillRevisions(runId: string): Promise<string[]> {
  return withClient(async (c) => {
    const r = await c.query<{ skill_id: string }>(
      `SELECT skill_id FROM "${SCHEMA}"."run_selected_skill_revisions" WHERE run_id = $1 ORDER BY skill_id`,
      [runId],
    );
    return r.rows.map((row) => row.skill_id);
  });
}

/**
 * HOW MANY QUEUE JOBS NAME THIS RUN — the number #2824 is actually about, and NOT
 * a queue total, which counts every other run on the lane and answers nothing.
 *
 * `0` while the run is held is the assertion that separates a genuine hold from a
 * run that was dispatched anyway and merely drawn as held; `1` after the decision
 * is the assertion that the decision advanced it, EXACTLY ONCE.
 *
 * The measurement is the PAYLOAD, across every state, not `getJob(runId)`. The
 * release path enqueues with `jobId = runId`, and an id lookup therefore proves
 * only that a job addressable by that id exists — a duplicate added under any
 * other id, carrying the same `runId`, is invisible to it, and a duplicate
 * dispatch is exactly what the "exactly one" arm is sold as catching. The rule
 * itself is pure and unit-covered (`state-rules.ts`, `countJobsNamingRun`); this
 * function only feeds it the queue.
 */
export async function jobsNamingRun(runId: string): Promise<number> {
  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    const jobs = await queue.getJobs([...QUEUE_STATES_NAMING_A_RUN]);
    return countJobsNamingRun(
      jobs.filter((job) => Boolean(job)).map((job) => ({ id: job.id, data: job.data })),
      runId,
    );
  } finally {
    await queue.close();
  }
}

/**
 * THE NEGATIVE CONTROL — add ONE more job naming this run, under a DIFFERENT id.
 *
 * This is what makes `jobsNamingRun` refutable rather than merely asserted: the
 * flow watches the count move 1 -> 2 on a duplicate the old id-lookup probe could
 * not see, and removes it again. It is COUNTABLE and never RUNNABLE — an
 * unregistered job name, added an hour into the future, removed in the same step
 * — because a control that executed would dispatch the run a second time, which
 * is the defect, not the proof.
 */
export async function addDuplicateDispatchControl(runId: string): Promise<string> {
  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    const job = await queue.add(
      DUPLICATE_DISPATCH_CONTROL_JOB_NAME,
      { runId },
      {
        jobId: duplicateDispatchControlJobId(runId),
        delay: DUPLICATE_DISPATCH_CONTROL_DELAY_MS,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return String(job.id);
  } finally {
    await queue.close();
  }
}

/** Take the control back out. Called in a `finally`, so a failed arm leaves no residue. */
export async function removeDuplicateDispatchControl(runId: string): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    const job = await queue.getJob(duplicateDispatchControlJobId(runId));
    if (job) await job.remove();
  } finally {
    await queue.close();
  }
}

/**
 * Poll `fn` until it answers `true`, or throw with `label` naming what never
 * happened.
 *
 * `throwOnError` is the difference between "not yet" and "never". A probe that
 * throws because the database is momentarily busy should be retried; a probe that
 * throws because the turn was REFUSED has answered the question, and retrying it
 * for another fourteen minutes only delays the same report. The caller says which
 * kind of predicate it wrote.
 */
export async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  {
    timeoutMs,
    intervalMs = 1_000,
    throwOnError = false,
  }: { timeoutMs: number; intervalMs?: number; throwOnError?: boolean },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
      lastError = null;
    } catch (err) {
      if (throwOnError) throw err;
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for: ${label}` +
      (lastError ? ` (last error: ${String(lastError).slice(0, 200)})` : ""),
  );
}

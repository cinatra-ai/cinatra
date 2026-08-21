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

export const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  ENV_LOCAL.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
export const SCHEMA = process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";
export const REDIS_URL =
  process.env.REDIS_URL ?? ENV_LOCAL.REDIS_URL ?? "redis://127.0.0.1:6379";
export const QUEUE_NAME =
  process.env.BULLMQ_QUEUE_NAME ?? ENV_LOCAL.BULLMQ_QUEUE_NAME ?? "cinatra-background-jobs";

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

/** The newest run, used to name the run the browser just caused. */
export async function newestRunId(): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM "${SCHEMA}"."agent_runs" ORDER BY created_at DESC LIMIT 1`,
    );
    return r.rowCount ? r.rows[0]!.id : null;
  });
}

export async function countRuns(): Promise<number> {
  return withClient(async (c) => {
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${SCHEMA}"."agent_runs"`);
    return Number(r.rows[0]?.n ?? 0);
  });
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
 * The release path enqueues with `jobId = runId` for BullMQ-level dedup, so a job
 * for this run is addressable by the run id alone. `0` while the run is held is
 * the assertion that separates a genuine hold from a run that was dispatched
 * anyway and merely drawn as held; `1` after the decision is the assertion that
 * the decision actually advanced it, exactly once.
 */
export async function jobsNamingRun(runId: string): Promise<number> {
  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    const job = await queue.getJob(runId);
    return job ? 1 : 0;
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

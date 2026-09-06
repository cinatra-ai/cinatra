// ---------------------------------------------------------------------------
// THE SYNCHRONOUS POSTGRES BRIDGE — and its caller inventory (cinatra#2882).
//
// `runPostgresQueriesSync` spawns a worker thread and parks the CALLING thread
// on `Atomics.wait` until the worker answers or `DEFAULT_TIMEOUT_MS` fires. In
// the server process that calling thread is the main one, so for the whole of
// that wait NO timer, NO abort listener and NO microtask runs anywhere in the
// process: request handling, other timers and the BullMQ job heartbeats are all
// frozen with it. A slow-but-not-dead database turns one keyed statement into
// up to `POSTGRES_SYNC_TIMEOUT_MS` of a completely unresponsive event loop, per
// call. And no `AbortSignal` can ever reach this path — un-abortable BY
// CONSTRUCTION, not by omission (the finding PR #2875 had to design a
// circuit-breaker around instead of real cancellation).
//
// ## Who is still on it (scan at the #2882 head; the ratchet keeps it current)
//
// 371 direct call sites across 83 production files. The machine-generated
// per-file scan is `config/postgres-sync-inventory.json`; the per-file
// classification + justification is `src/lib/postgres-sync-inventory.ts`; the
// ratchet test that keeps both honest and forbids NEW call sites is
// `src/lib/__tests__/postgres-sync-inventory.test.ts`.
//
// Split by whether the call site has an `await` to give:
//
//   76 of 371 sites (21 files) sit inside a function that is ALREADY `async` —
//     they park the loop with a perfectly good `await` in hand. These are
//     mechanically migratable to `@/lib/postgres-async`, one store at a time.
//   295 of 371 sit inside a synchronous function. Those are only migratable by
//     changing the enclosing signature — which is the #303 track's staged,
//     per-store work, NOT something to smuggle in under an unrelated fix.
//
// The third shape is the one #2882 was filed about and is invisible to the
// count above: a SYNCHRONOUS seam function whose production callers are all
// async. `packages/notifications/src/service.ts` is the type specimen — 11 sync
// sites, zero async enclosing functions, yet every caller of the notification
// clear in `src/lib/agent-run-wait-notifications.ts` is an `async` handler that
// was blocking the loop for a single keyed DELETE. The fix for that shape is an
// ADDITIVE async seam beside the sync one, not a rewrite of it:
// `deleteNotificationsByDedupeKeyForUserAsync`, in the async-seam section of
// `packages/notifications/src/service.ts`, drives the SAME statement builder
// over `@/lib/postgres-async`, and the sync twin stays exactly where it is for
// genuinely synchronous hosts.
//
// ## Before you add a call site here
//
// If your caller can `await`, use `@/lib/postgres-async` (`runPostgresQueriesAsync`)
// — same input keys, same `{ rows, rowCount }` results, same build-phase no-op,
// the same settle-or-throw ceiling (30s, `POSTGRES_ASYNC_TIMEOUT_MS`), and no
// frozen loop. This bridge is for callers that genuinely cannot: module-scope
// schema init, the sync-leaf stores under the Turbopack sync-import contract
// (see `src/lib/postgres-schema-init.ts`), and security-critical instant
// decisions where an `await` would open a TOCTOU window.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

type QueryInput = {
  text: string;
  values?: unknown[];
};

type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

// Env-overridable timeout ceiling. Production stays at 30s (a sane
// "something is very wrong" ceiling for a sync query). The `/agents`
// Playwright suite sets POSTGRES_SYNC_TIMEOUT_MS=90000 on its webServer
// because `pnpm dev` + Turbopack compilation + sustained suite load
// starves the sync worker thread — genuine queries that complete in <1s
// normally would blow the 30s ceiling and 500 the request mid-test. The
// ceiling is not a performance target; raising it for the test env only
// prevents false-positive timeouts under pathological dev load.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POSTGRES_SYNC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

/**
 * WHAT A FAILED WORKER REPORTS — and why it is more than a message.
 *
 * The worker answers through a JSON file, so the error has to be flattened to
 * data. It used to be flattened to `{ message, stack }` alone, and the parent
 * threw ONLY when that message was non-empty (`if (payload.error?.message)`).
 * An error that carries no message of its own therefore came back as
 * `results ?? []` — a failure answered as an empty, successful result set.
 * `pg` produces exactly that error: when every address a host name resolves to
 * refuses the connection, Node rejects with an `AggregateError` whose own
 * `message` is the empty string and whose `errors` carry the ECONNREFUSED
 * detail. Unit suites pointed at a placeholder connection string went green
 * over a real socket attempt on the strength of it (cinatra#3254).
 *
 * The payload now carries the fields an error describes itself by, the parent
 * throws for ANY error payload, and `describeWorkerError` derives the message
 * when the error has none of its own.
 */
export type PostgresWorkerErrorDetail = {
  name?: string;
  message?: string;
  code?: string;
  errno?: number | string;
  syscall?: string;
};

export type PostgresWorkerErrorPayload = PostgresWorkerErrorDetail & {
  stack?: string;
  /** The nested errors of an `AggregateError`, flattened one level. */
  errors?: PostgresWorkerErrorDetail[];
};

/**
 * Flatten a thrown value to the payload the response file carries. The WORKER
 * runs this exact function: its source is stringified into `workerSource`
 * below, so both sides of the file describe an error the same way. It must
 * therefore stay self-contained — no imports, no module-scope references.
 */
export function serializeWorkerError(error: unknown): PostgresWorkerErrorPayload {
  const detail = (value: unknown): PostgresWorkerErrorDetail => {
    const e = (value ?? {}) as Record<string, unknown>;
    const out: PostgresWorkerErrorDetail = {};
    if (typeof e.name === "string") out.name = e.name;
    if (typeof e.message === "string") out.message = e.message;
    if (typeof e.code === "string") out.code = e.code;
    if (typeof e.errno === "number" || typeof e.errno === "string") out.errno = e.errno;
    if (typeof e.syscall === "string") out.syscall = e.syscall;
    return out;
  };

  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const payload: PostgresWorkerErrorPayload = detail(error);
  if (typeof error.stack === "string") payload.stack = error.stack;
  const nested = (error as unknown as { errors?: unknown }).errors;
  if (Array.isArray(nested) && nested.length > 0) {
    payload.errors = nested.map(detail);
  }
  return payload;
}

/** What one error describes itself by, or "" when it describes nothing. */
function describeErrorDetail(detail: PostgresWorkerErrorDetail): string {
  const message = typeof detail.message === "string" ? detail.message.trim() : "";
  if (message !== "") return message;
  const parts: string[] = [];
  if (detail.code) parts.push(String(detail.code));
  if (detail.syscall) parts.push(String(detail.syscall));
  if (detail.errno !== undefined && detail.errno !== null) parts.push(`errno ${detail.errno}`);
  if (parts.length === 0 && detail.name) parts.push(String(detail.name));
  return parts.join(" ");
}

/** The message to throw for a worker failure — NEVER the empty string. */
export function describeWorkerError(payload: PostgresWorkerErrorPayload): string {
  const own = describeErrorDetail(payload);
  const nested = (payload.errors ?? []).map(describeErrorDetail).filter((part) => part !== "");
  if (own !== "" && nested.length > 0) return `${own} (${nested.join("; ")})`;
  if (own !== "") return own;
  if (nested.length > 0) return nested.join("; ");
  return "Postgres query worker failed without describing the error.";
}

/**
 * The parent's answer to one worker response: the results, or a throw for ANY
 * error payload. Presence of the payload is the test — never the truthiness of
 * its message.
 */
export function resultsOrThrow(payload: {
  results?: QueryResult[];
  error?: PostgresWorkerErrorPayload;
}): QueryResult[] {
  if (payload.error) {
    const error = new Error(describeWorkerError(payload.error));
    if (payload.error.stack) {
      error.stack = payload.error.stack;
    }
    throw error;
  }
  return payload.results ?? [];
}

const workerSource = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { Client } = require("pg");

// The parent module's own serializer, so both sides describe an error alike.
const serializeWorkerError = (${serializeWorkerError.toString()});

async function main() {
  const signal = new Int32Array(workerData.signalBuffer);
  const client = new Client({ connectionString: workerData.connectionString });

  try {
    await client.connect();
    const results = [];

    if (workerData.transaction) {
      await client.query("BEGIN");
    }

    for (const query of workerData.queries) {
      const result = await client.query(query.text, query.values || []);
      results.push({
        rows: result.rows,
        rowCount: typeof result.rowCount === "number" ? result.rowCount : 0,
      });
    }

    if (workerData.transaction) {
      await client.query("COMMIT");
    }

    fs.writeFileSync(workerData.responsePath, JSON.stringify({ results }));
  } catch (error) {
    try {
      if (workerData.transaction) {
        await client.query("ROLLBACK");
      }
    } catch {}

    fs.writeFileSync(
      workerData.responsePath,
      JSON.stringify({ error: serializeWorkerError(error) }),
    );
  } finally {
    try {
      await client.end();
    } catch {}
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
}

void main();
`;

function getResponsePath() {
  return path.join(os.tmpdir(), `cinatra-postgres-sync-${randomUUID()}.json`);
}

function runWorkerSync(input: {
  connectionString: string;
  queries: QueryInput[];
  transaction?: boolean;
  timeoutMs?: number;
}) {
  const responsePath = getResponsePath();
  const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const signal = new Int32Array(signalBuffer);

  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      connectionString: input.connectionString,
      queries: input.queries,
      transaction: input.transaction === true,
      responsePath,
      signalBuffer,
    },
  });

  const status = Atomics.wait(signal, 0, 0, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (status === "timed-out") {
    // NOTE (cinatra#2882 ceiling review): a timeout here is NOT a rollback.
    // Terminating the worker tears down its pg.Client socket, but Postgres only
    // notices a dead client when it next tries to write — a statement that has
    // already committed stays committed while this caller sees a throw. That
    // divergence is bounded for the 52 call sites that pass `transaction: true`
    // (losing the connection aborts an open transaction) and unbounded for the
    // 319 that autocommit. It is why the 30s ceiling is NOT simply "too high":
    // tightening it globally would raise the rate at which a caller reports
    // failure for a write the database kept. Bound per call site instead, once
    // that site's write is idempotent-by-key or transactional.
    void worker.terminate();
    throw new Error("Timed out while executing Postgres query.");
  }

  const payload = existsSync(responsePath)
    ? JSON.parse(readFileSync(responsePath, "utf8")) as {
        results?: QueryResult[];
        error?: PostgresWorkerErrorPayload;
      }
    : null;

  rmSync(responsePath, { force: true });

  if (!payload) {
    throw new Error("Postgres query worker did not return a response.");
  }

  return resultsOrThrow(payload);
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

// Next.js sets NEXT_PHASE=phase-production-build during `next build`. The
// Dockerfile build step exports a placeholder SUPABASE_DB_URL pointing at
// 127.0.0.1:5432 that never resolves; this guard short-circuits sync DB
// queries during build-phase page-data collection so the build doesn't fail
// with ECONNREFUSED. Runtime queries (NEXT_PHASE=phase-production-server)
// still hit the real DB.
//
// Always skip sync DB queries during `next build`, regardless of connection
// string. Next.js can spawn many worker processes for page-data collection;
// each evaluates route-handler modules whose module-level imports call into
// `ensurePostgresSchema()` / settings reads, and concurrent DDL/UPDATE runs
// can collide on `pg_class` (and equivalents) with `tuple concurrently
// updated`. The cross-thread sentinel in database.ts is PID-scoped so it
// dedups within a worker_thread set but not across worker processes, so the
// only safe path is to no-op all sync DB queries during build, since
// page-data collection doesn't actually need live data.
function isNextBuildPhase(_connectionString: string): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function runPostgresQueriesSync(input: {
  connectionString: string;
  queries: QueryInput[];
  transaction?: boolean;
  timeoutMs?: number;
}) {
  if (isNextBuildPhase(input.connectionString)) {
    // Return one empty result per requested query — callers expect a list of
    // { rows, rowCount } shaped the same as a real query response.
    return input.queries.map(() => ({ rows: [] as Array<Record<string, unknown>>, rowCount: 0 }));
  }
  return runWorkerSync(input);
}

export function buildTruncateTableQuery(schemaName: string, tableName: string) {
  return `TRUNCATE TABLE ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

export function buildSelectAllQuery(schemaName: string, tableName: string) {
  return `SELECT * FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

export function buildDeleteAllQuery(schemaName: string, tableName: string) {
  return `DELETE FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

export function quotePostgresIdentifier(value: string) {
  return quoteIdentifier(value);
}

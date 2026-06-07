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
// "something is very wrong" ceiling for a sync query). The `/agents/run`
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

const workerSource = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { Client } = require("pg");

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
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      }),
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
    void worker.terminate();
    throw new Error("Timed out while executing Postgres query.");
  }

  const payload = existsSync(responsePath)
    ? JSON.parse(readFileSync(responsePath, "utf8")) as {
        results?: QueryResult[];
        error?: { message?: string; stack?: string };
      }
    : null;

  rmSync(responsePath, { force: true });

  if (!payload) {
    throw new Error("Postgres query worker did not return a response.");
  }

  if (payload.error?.message) {
    const error = new Error(payload.error.message);
    if (payload.error.stack) {
      error.stack = payload.error.stack;
    }
    throw error;
  }

  return payload.results ?? [];
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

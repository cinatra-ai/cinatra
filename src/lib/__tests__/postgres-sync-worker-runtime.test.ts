/**
 * Exercise the real worker in a fresh Node process. Vitest's transformed module
 * (or a fake Worker) cannot reproduce the tsx-only serializer failure: tsx adds
 * naming helpers that are absent when a function is copied into a worker.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const SOURCE = path.join(ROOT, "src/lib/postgres-sync.ts");
// Deliberately opt-in: the root unit suite supplies a placeholder app DB URL.
// The database cases perform only SELECTs, including a rolled-back SQL failure.
const DB_URL = process.env.CINATRA_POSTGRES_WORKER_TEST_DB_URL ?? "";
const HAS_DB = DB_URL !== "";

let temporaryDirectory: string;
let runnerPath: string;
let bundledPath: string;

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(path.join(tmpdir(), "cinatra-postgres-worker-test-"));
  runnerPath = path.join(temporaryDirectory, "run-worker.mjs");
  bundledPath = path.join(temporaryDirectory, "postgres-sync.bundle.mjs");
  writeFileSync(runnerPath, `
import { runInNewContext } from "node:vm";
const { runPostgresQueriesSync, serializeWorkerError } = await import(process.env.POSTGRES_WORKER_MODULE);
try {
  if (process.env.POSTGRES_WORKER_SERIALIZE === "1") {
    // Evaluate exactly the source copied into the worker, without any bundler
    // module helpers, and exercise nested fields not produced by every OS.
    const serializeInWorker = runInNewContext("(" + serializeWorkerError.toString() + ")", { Error });
    const refused = Object.assign(new Error(""), {
      code: "ECONNREFUSED", errno: -111, syscall: "connect",
    });
    console.log(JSON.stringify({ payload: serializeInWorker(new AggregateError([refused], "")) }));
  } else {
  const results = runPostgresQueriesSync({
    connectionString: process.env.POSTGRES_WORKER_TEST_URL,
    queries: JSON.parse(process.env.POSTGRES_WORKER_TEST_QUERIES),
    transaction: process.env.POSTGRES_WORKER_TRANSACTION === "1",
    timeoutMs: 10000,
  });
  console.log(JSON.stringify({ results }));
  }
} catch (error) {
  console.log(JSON.stringify({ error: { message: error.message, stack: error.stack } }));
}
`);
  // Same target/format as the shipped schema bootstrap bundle, with the actual
  // bridge as entry point so the regression does not depend on schema setup.
  await build({
    entryPoints: [SOURCE],
    outfile: bundledPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
});

afterAll(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

function runQuery(
  runtime: "tsx" | "bundle",
  connectionString: string,
  queries: Array<{ text: string; values?: unknown[] }>,
  transaction = false,
  serializeOnly = false,
) {
  const child = spawnSync(
    process.execPath,
    [...(runtime === "tsx" ? ["--import", requireFromRoot.resolve("tsx")] : []), runnerPath],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        // A build parent must not silently turn these real queries into no-ops.
        NEXT_PHASE: "phase-production-server",
        POSTGRES_WORKER_MODULE: pathToFileURL(runtime === "tsx" ? SOURCE : bundledPath).href,
        POSTGRES_WORKER_TEST_URL: connectionString,
        POSTGRES_WORKER_TEST_QUERIES: JSON.stringify(queries),
        POSTGRES_WORKER_TRANSACTION: transaction ? "1" : "0",
        POSTGRES_WORKER_SERIALIZE: serializeOnly ? "1" : "0",
      },
    },
  );
  expect(child.error).toBeUndefined();
  const answer = JSON.parse(child.stdout.trim()) as {
    results?: Array<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
    error?: { message: string; stack: string };
    payload?: Record<string, unknown>;
  };
  return { ...child, answer };
}

describe.each(["tsx", "bundle"] as const)("Postgres worker under %s", (runtime) => {
  it("keeps AggregateError details when its serializer is copied outside the module", () => {
    const result = runQuery(runtime, "", [], false, true);
    expect(result.answer.payload).toMatchObject({
      name: "AggregateError",
      message: "",
      stack: expect.stringContaining("AggregateError"),
      errors: [{ name: "Error", message: "", code: "ECONNREFUSED", errno: -111, syscall: "connect" }],
    });
    expect(result.answer.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("returns the connection failure without a missing response or serializer crash", () => {
    // A nonexistent Unix socket is deterministic and needs no database service.
    const missingSocket = path.join(temporaryDirectory, "missing-socket");
    const connectionString = `postgresql://test@localhost/test?host=${encodeURIComponent(missingSocket)}`;
    const result = runQuery(runtime, connectionString, [{ text: "SELECT 1" }]);
    // macOS may reject its long per-user temp path before attempting the socket.
    expect(result.answer.error?.message).toMatch(/ENOENT|EINVAL/);
    expect(result.answer.error?.stack).toMatch(/ENOENT|EINVAL/);
    expect(result.answer.error?.message).not.toMatch(/did not return a response|__name/);
    expect(result.stderr).not.toMatch(/ReferenceError|__name/);
    expect(result.status).toBe(0);
  });

  it.skipIf(!HAS_DB)("returns PostgreSQL's actual SQL error through the worker", () => {
    const result = runQuery(runtime, DB_URL, [{ text: "SELECT 1 / 0" }], true);
    expect(result.answer.error?.message).toBe("division by zero");
    expect(result.answer.error?.stack).toContain("division by zero");
    expect(result.stderr).not.toMatch(/ReferenceError|__name/);
    expect(result.status).toBe(0);
  });

  it.skipIf(!HAS_DB)("preserves successful query results in the same runtime", () => {
    const result = runQuery(runtime, DB_URL, [{ text: "SELECT $1::integer AS answer", values: [42] }]);
    expect(result.answer).toEqual({ results: [{ rows: [{ answer: 42 }], rowCount: 1 }] });
    expect(result.status).toBe(0);
  });
});

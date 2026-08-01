/**
 * THE KILL-BROKER ARM, JOINED END TO END (cinatra#2266 AC8, slice 3).
 *
 * This is the half slice 2 (#2298) named and could not run. Its battery drives
 * the BROKER directly and holds no authorization kernel, so it proved
 * re-delivery of the same delivery keys across a SIGKILL but had no rows to
 * count. The kernel end was proven separately, against a `pg` double. Neither
 * half on its own answers the question the issue actually asks, which is
 * whether an at-least-once transport plus an idempotent kernel add up to
 * EXACTLY ONE ROW PER EXECUTION.
 *
 * This file answers it, with both ends real at once and nothing standing in
 * for the join:
 *
 *   * A REAL broker in a REAL child process (`kill-broker-harness.ts`), holding
 *     a REAL file spool on a REAL directory, reached over REAL mTLS by the REAL
 *     `BrokerServiceClient`.
 *   * REAL records, produced by REAL `openJob` / `exec` RPCs over that wire —
 *     not appended to the spool by the test.
 *   * A REAL Postgres, with the REAL `audit_events` DDL this repo ships, written
 *     through the REAL app drain loop (`drainAuditPasses`) and the REAL strict
 *     kernel path (`createDurableExecutionAuditWriter` →
 *     `logExecutionAuditEventDurable`).
 *   * A REAL `SIGKILL`. Not a graceful stop: no shutdown hook runs, and nothing
 *     but the fsynced spool survives it.
 *
 * THE SEQUENCE IS THE ONE AC8 SPELLS OUT, and each step is an assertion rather
 * than a comment:
 *
 *   1. Run commands → records land in the spool.
 *   2. Drain, WRITE THE ROWS, and then FAIL before acknowledging. This models
 *      the crash the whole contract exists for: the app got the batch, durably
 *      wrote it, and died before it could confirm. The ACK genuinely never
 *      reaches the broker — it is not stubbed out, the pass aborts.
 *   3. SIGKILL the broker and restart it against the SAME spool directory.
 *   4. Drain again. The SAME delivery keys come back, byte-identical, under the
 *      same `spoolId`.
 *   5. Write them AGAIN through the same kernel path, and this time acknowledge.
 *   6. Count rows: EXACTLY ONE per delivery key, from two full deliveries.
 *
 * A run in which zero records or zero executions occurred FAILS this arm rather
 * than passing it — every count below has a nonzero minimum.
 *
 * WHAT IS DOUBLED, stated plainly: the harness's `SandboxWorker` returns a
 * canned result instead of running a container, and its voucher verifier
 * accepts. Neither is on the path under test — this arm is about the durability
 * and identity of audit records across a crash, and sandbox isolation is proven
 * with real containers and real commands by the L5 battery
 * (`packages/execution-plane/src/__tests__/e2e/service-boundary.e2e.test.ts`),
 * whose own kill arm proves the re-delivery half against that topology.
 *
 * RUNNING IT (the repo's `*.integration.test.ts` tier contract — skipped, never
 * silently passed, without a real Postgres):
 *
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run src/lib/execution/__tests__/integration/audit-kill-broker-kernel-rows.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import { sealExecutionSession } from "@cinatra-ai/llm/execution-plane";
import {
  BrokerServiceClient,
  type ExecTlsMaterial,
  type ExecutionAuditRecord,
} from "@cinatra-ai/execution-plane";

import { auditEventsSchemaQueries } from "@/lib/authz/audit-events-schema";
import {
  executionAuditRowId,
  type ExecutionAuditWriteOutcome,
} from "@/lib/authz/audit";
import { createDurableExecutionAuditWriter } from "@/lib/execution/execution-broker-construct";
import { drainAuditPasses } from "@/lib/execution/execution-broker-remote-construct";

// The harness's fixed identities. Imported rather than retyped so a rename on
// either side breaks the build instead of the arm.
const HARNESS_INSTANCE = "kill-arm-inst";
const HARNESS_SERVICE_TOKEN = "kill-arm-service-token-cccccccccccccccc";
const HARNESS_CARRIER_SECRET = "kill-arm-carrier-secret-dddddddddddddddd";
const HARNESS_ORG = "org-kill-arm";
const HARNESS_USER = "user-kill-arm";

/** How many commands the arm runs. Nonzero minimum for every later count. */
const COMMANDS = 4;

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

const SCHEMA = process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra";

const repoRoot = path.resolve(__dirname, "../../../../..");
const HARNESS = path.join(
  repoRoot,
  "packages/execution-plane/src/__tests__/e2e/support/kill-broker-harness.ts",
);

/**
 * THE HARNESS RUNS AS ONE PROCESS, and that is load-bearing rather than tidy.
 *
 * The obvious spawn — `node_modules/.bin/tsx <harness>` — starts a WRAPPER that
 * re-spawns node with its loader flags, so the process holding the spool is the
 * wrapper's CHILD. `child.kill("SIGKILL")` would then kill the wrapper and leave
 * the real broker alive, still holding the single-writer lock: the restart is
 * refused, and the arm reports a lock error instead of testing a crash. (It did
 * exactly that before this note existed — the spool's own single-writer refusal
 * is what caught it.)
 *
 * So the flags tsx would have passed are passed here directly. The SIGKILL then
 * lands on the process that owns the spool, which is the only kill this arm can
 * legitimately claim to be making.
 */
const tsxDist = path.join(path.dirname(require.resolve("tsx/package.json")), "dist");
const NODE_ARGS = [
  "--require",
  path.join(tsxDist, "preflight.cjs"),
  "--import",
  pathToFileURL(path.join(tsxDist, "loader.mjs")).href,
];

let workDir: string;
let spoolDir: string;
let pkiDir: string;
let port: number;
let pool: Pool;
let child: ChildProcessWithoutNullStreams | undefined;

/** A free-ish loopback port. Lane-unique by randomisation, re-used on restart. */
function pickPort(): number {
  return 19_000 + Math.floor(Math.random() * 5_000);
}

/**
 * Start the harness and wait for its READY line.
 *
 * A harness that dies during boot rejects here with whatever it printed, so a
 * broken harness can never be mistaken for "the spool was empty".
 */
function startBroker(): Promise<{ spoolId: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [...NODE_ARGS, HARNESS, spoolDir, pkiDir, String(port)],
      { cwd: repoRoot, env: { ...process.env } },
    );
    child = proc;
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      reject(new Error(`harness did not become READY in 60s.\nstdout:\n${out}\nstderr:\n${err}`));
    }, 60_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = /READY (\d+) (\S+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ spoolId: match[2]! });
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`harness exited early (code ${code}, signal ${signal}).\nstderr:\n${err}`));
    });
  });
}

/** The app's mTLS credential, minted by the harness's CA on its first boot. */
function appClientMaterial(): ExecTlsMaterial {
  return {
    certPem: readFileSync(path.join(pkiDir, "app-client.cert.pem"), "utf8"),
    keyPem: readFileSync(path.join(pkiDir, "app-client.key.pem"), "utf8"),
    caPem: readFileSync(path.join(pkiDir, "ca.pem"), "utf8"),
  };
}

function client(): BrokerServiceClient {
  return new BrokerServiceClient({
    baseUrl: `https://127.0.0.1:${port}`,
    instance: HARNESS_INSTANCE,
    serviceToken: HARNESS_SERVICE_TOKEN,
    tls: appClientMaterial(),
  });
}

/** Rows in the kernel carrying a given delivery key. The load-bearing query. */
async function rowsForKey(key: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${SCHEMA}".audit_events WHERE execution_delivery_key = $1`,
    [key],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

describe.skipIf(!hasDb)("kill the broker mid-drain — exactly one kernel row per delivery key", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "cinatra-kill-arm-"));
    spoolDir = path.join(workDir, "spool");
    pkiDir = path.join(workDir, "pki");
    port = pickPort();

    pool = new Pool({ connectionString: dbUrl });
    // The REAL DDL this repo ships for `audit_events`, including the unique
    // delivery-key index migration core__0088 adds. Asserting against a table
    // the test hand-rolled would be the test agreeing with itself.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    for (const query of auditEventsSchemaQueries(SCHEMA)) {
      await pool.query(query.text);
    }
  }, 120_000);

  afterAll(async () => {
    child?.kill("SIGKILL");
    await pool?.end().catch(() => {});
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it(
    "re-delivers the same delivery keys after a SIGKILL and the kernel collapses them to one row each",
    async () => {
      // ---------------------------------------------------------------------
      // 1. REAL commands over the REAL wire produce REAL records.
      // ---------------------------------------------------------------------
      const { spoolId: spoolIdBefore } = await startBroker();
      expect(spoolIdBefore).toMatch(/[0-9a-f-]{36}/);

      process.env.EXECUTION_BROKER_SECRET = HARNESS_CARRIER_SECRET;
      const runId = `kill-arm-${randomUUID()}`;
      const carrier = await sealExecutionSession(
        { orgId: HARNESS_ORG, userId: HARNESS_USER, surface: "agent_run", runId },
        { secret: HARNESS_CARRIER_SECRET },
      );

      const app = client();
      const opened = await app.openJob(carrier);
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("unreachable");
      for (let i = 0; i < COMMANDS; i += 1) {
        const result = await app.exec(opened.jobId, `echo kill-arm-${i}`, "voucher");
        expect(result.ok).toBe(true);
      }

      // ---------------------------------------------------------------------
      // 2. Drain, WRITE the rows, and die before acknowledging.
      //
      //    THE ASSERTIONS RIDE THE REAL LOOP, not a separate observational
      //    drain (Codex convergence, adopted — finding 1). A test that reads the
      //    batch itself and then lets `drainAuditPasses` read again proves
      //    nothing: if the read were destructive, the observation would succeed,
      //    the loop's own drain would come back EMPTY, the row counts would all
      //    still be 1 and the arm would pass while the property was false. So
      //    the writer is wrapped and every claim below is made about records the
      //    REAL loop actually handed to the REAL kernel path.
      //
      //    The ACK is withheld by making it THROW, which is what a crashed app
      //    looks like from the broker's side: the records were durably written,
      //    and the confirmation never arrived. `drainAuditPasses` writes before
      //    it acknowledges, so the rows are real by the time this fails.
      // ---------------------------------------------------------------------
      const durableWriter = createDurableExecutionAuditWriter();
      type Written = { record: ExecutionAuditRecord; outcome: ExecutionAuditWriteOutcome };

      /** Wraps the REAL writer so the arm can assert what the loop delivered. */
      function capturingWriter(sink: Written[]) {
        return async (record: ExecutionAuditRecord) => {
          const outcome = await durableWriter(record);
          sink.push({ record, outcome });
          return outcome;
        };
      }

      const firstWrites: Written[] = [];
      let ackAttempts = 0;
      await drainAuditPasses(
        {
          drainAudit: app.drainAudit.bind(app),
          ackAudit: async () => {
            ackAttempts += 1;
            throw new Error("the app died before it could acknowledge");
          },
        },
        capturingWriter(firstWrites),
        { maxPasses: 1, onGap: () => {} },
      ).catch(() => {
        /* the withheld ACK — expected, and the point */
      });

      // The blocker was REACHED, exactly once (Codex finding 4). Without this a
      // regression that returned before ever attempting an ACK would look
      // identical to the crash this arm is simulating.
      expect(ackAttempts).toBe(1);

      const firstForJob = firstWrites.filter((w) => w.record.jobId === opened.jobId);
      const firstDelivery = firstForJob.map((w) => w.record.deliveryKey as string);
      // NONZERO MINIMUM: a run that recorded nothing must fail, not pass.
      expect(firstDelivery.length).toBeGreaterThanOrEqual(COMMANDS);
      // DISTINCT keys (Codex finding 2): four records sharing one key would
      // otherwise satisfy the count while making "one row per record" trivial.
      expect(new Set(firstDelivery).size).toBe(firstDelivery.length);
      expect(firstDelivery.every((k) => k.startsWith(spoolIdBefore))).toBe(true);
      // Delivery ONE wrote them, so every outcome is an INSERT, not a duplicate.
      expect(firstForJob.every((w) => w.outcome.state === "inserted")).toBe(true);

      // The rows are in the kernel already, one per key, from delivery ONE.
      for (const key of firstDelivery) expect(await rowsForKey(key)).toBe(1);

      // ---------------------------------------------------------------------
      // 3. SIGKILL, and restart against the SAME spool directory.
      // ---------------------------------------------------------------------
      const killed = child!;
      const exited = new Promise<string | null>((resolve) =>
        killed.once("exit", (_code, signal) => resolve(signal)),
      );
      killed.kill("SIGKILL");
      // Assert the KILL was a kill. A graceful exit here would mean the arm
      // never exercised the crash it exists to test.
      expect(await exited).toBe("SIGKILL");
      app.close();

      const { spoolId: spoolIdAfter } = await startBroker();
      // The SAME volume, so the SAME identity — an ACK routed here still means
      // what it meant before the kill.
      expect(spoolIdAfter).toBe(spoolIdBefore);

      // ---------------------------------------------------------------------
      // 4. The same records come back, and the kernel refuses to double them.
      // ---------------------------------------------------------------------
      const app2 = client();
      const secondWrites: Written[] = [];
      await drainAuditPasses(
        { drainAudit: app2.drainAudit.bind(app2), ackAudit: app2.ackAudit.bind(app2) },
        capturingWriter(secondWrites),
        { maxPasses: 4, onGap: () => {} },
      );

      const secondForJob = secondWrites.filter((w) => w.record.jobId === opened.jobId);
      const secondDelivery = secondForJob.map((w) => w.record.deliveryKey as string);

      // THE SECOND DELIVERY REALLY HAPPENED, and it was the SAME SET — not a
      // superset with fresh keys, not a subset, not empty (Codex findings 1+2).
      expect([...secondDelivery].sort()).toEqual([...firstDelivery].sort());

      // BYTE-IDENTICAL, not merely same-keyed (Codex finding 3). A restart that
      // returned the right keys attached to altered decisions or attribution
      // would be silently discarded by ON CONFLICT and every count below would
      // still pass — so the payloads are compared, not just their identities.
      const byKey = new Map(firstForJob.map((w) => [w.record.deliveryKey as string, w.record]));
      for (const w of secondForJob) {
        expect(JSON.stringify(w.record)).toBe(
          JSON.stringify(byKey.get(w.record.deliveryKey as string)),
        );
      }

      // Every second write was recognized as a DUPLICATE — the kernel's
      // idempotency doing the de-dup, rather than the transport never
      // re-delivering.
      expect(secondForJob.every((w) => w.outcome.state === "duplicate")).toBe(true);

      // THE ASSERTION THE WHOLE ARM EXISTS FOR: two full deliveries of every
      // record, one row each. Queried from the real table, by delivery key.
      for (const key of firstDelivery) {
        expect(await rowsForKey(key)).toBe(1);
      }
      // The whole set, counted once, so an extra row under a key the arm never
      // tracked cannot hide.
      const distinct = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${SCHEMA}".audit_events
          WHERE execution_delivery_key = ANY($1::text[])`,
        [firstDelivery],
      );
      expect(Number.parseInt(distinct.rows[0]!.n, 10)).toBe(firstDelivery.length);

      // And the row id is the derived one, so the second delivery named the
      // same row rather than racing to mint a second id for it.
      const ids = await pool.query<{ id: string }>(
        `SELECT id FROM "${SCHEMA}".audit_events WHERE execution_delivery_key = $1`,
        [firstDelivery[0]!],
      );
      expect(ids.rows[0]?.id).toBe(executionAuditRowId(firstDelivery[0]!));

      // ACKNOWLEDGED this time, so they are gone from the spool for good.
      const finalBatch = await app2.drainAudit({});
      expect(finalBatch.audit.filter((r) => r.jobId === opened.jobId)).toHaveLength(0);
      app2.close();
    },
    300_000,
  );
});

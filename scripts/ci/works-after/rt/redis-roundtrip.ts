// Redis / BullMQ works-after round-trip (cinatra#352).
//
// Functional proof for a Redis (or BullMQ) major bump: enqueue ONE job on the
// candidate Redis, have a real Worker run it, and assert a THREE-WAY result —
// the job reaches `completed`, the returned value's nonce equals the enqueued
// nonce, AND the worker wrote that nonce to a Redis key. A half-working queue
// (accepts but never runs) fails on state; a wrong-result worker fails on nonce.
//
// Uses the SAME underlying libs as src/lib/background-jobs.ts (bullmq + ioredis,
// the exact repo deps) against a THROWAWAY queue — it proves the Redis/bullmq
// contract a major can break, without dragging the "server-only" app graph.
//
// Run: node --import tsx scripts/ci/works-after/rt/redis-roundtrip.ts
// Env: REDIS_URL (required, e.g. redis://127.0.0.1:6390), WORKS_AFTER_DEADLINE_MS.

import { randomBytes } from "node:crypto";
import { Queue, Worker, QueueEvents, type Job } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("redis-roundtrip: REDIS_URL is required");
  process.exit(2);
}
const DEADLINE_MS = Number(process.env.WORKS_AFTER_DEADLINE_MS ?? "30000");
const QUEUE_NAME = "works-after-proof";
// CSPRNG-backed uniqueness token (not Math.random) for the three-way assert.
const NONCE = `wa-${randomBytes(12).toString("hex")}-${Date.now()}`;
const SENTINEL_KEY = `works-after:sentinel:${NONCE}`;

// One ioredis connection per BullMQ role, mirroring background-jobs.ts
// (maxRetriesPerRequest:null is BullMQ's requirement for blocking commands).
function conn(): IORedis {
  const c = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
  // Swallow transient connection errors during teardown so they don't crash
  // the process — the same defensive posture background-jobs.ts takes.
  c.on("error", () => {});
  return c;
}

const queueConn = conn();
const workerConn = conn();
const eventsConn = conn();

const queue = new Queue(QUEUE_NAME, { connection: queueConn });
const queueEvents = new QueueEvents(QUEUE_NAME, { connection: eventsConn });

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job): Promise<{ nonce: string }> => {
    const nonce = String(job.data?.nonce ?? "");
    // Write the nonce to a Redis key from INSIDE the worker — the third leg of
    // the three-way assertion (proves the worker actually executed on Redis).
    const w = new IORedis(REDIS_URL!, { maxRetriesPerRequest: null });
    w.on("error", () => {});
    try {
      await w.set(SENTINEL_KEY, nonce);
    } finally {
      await w.quit().catch(() => {});
    }
    return { nonce };
  },
  { connection: workerConn },
);

async function cleanup(): Promise<void> {
  await worker.close().catch(() => {});
  await queueEvents.close().catch(() => {});
  await queue.close().catch(() => {});
  await Promise.all([
    queueConn.quit().catch(() => {}),
    workerConn.quit().catch(() => {}),
    eventsConn.quit().catch(() => {}),
  ]);
}

async function main(): Promise<void> {
  await queueEvents.waitUntilReady();
  await worker.waitUntilReady();

  // Report the server version so a major-bump failure shows WHICH redis broke.
  const info = await queueConn.info("server");
  const versionLine = info.split("\n").find((l) => l.startsWith("redis_version:"));
  console.log(`redis-roundtrip: ${versionLine?.trim() ?? "redis_version:?"}`);

  // Keep the job in Redis after completion so getState() can read `completed`
  // (removeOnComplete would delete it first → getState() returns 'unknown').
  // The job is removed explicitly at the end of the run.
  const job = await queue.add("proof", { nonce: NONCE });

  // Await completion within the deadline. waitUntilFinished resolves with the
  // worker's return value, or rejects if the job fails / times out.
  const returnValue = (await job.waitUntilFinished(queueEvents, DEADLINE_MS)) as {
    nonce?: string;
  };

  const state = await job.getState();
  if (state !== "completed") {
    throw new Error(`job state is '${state}', expected 'completed' (failedReason=${job.failedReason ?? "<none>"})`);
  }
  if (returnValue?.nonce !== NONCE) {
    throw new Error(`returned nonce '${returnValue?.nonce}' != enqueued nonce '${NONCE}'`);
  }
  const stored = await queueConn.get(SENTINEL_KEY);
  if (stored !== NONCE) {
    throw new Error(`worker-written redis key holds '${stored}', expected '${NONCE}'`);
  }
  await queueConn.del(SENTINEL_KEY).catch(() => {});
  await job.remove().catch(() => {});

  console.log(
    `redis-roundtrip OK — job completed, returned nonce matches, worker-written key matches (nonce=${NONCE})`,
  );
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`redis-roundtrip FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await cleanup();
    process.exit(1);
  });

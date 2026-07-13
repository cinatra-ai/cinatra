import "server-only";

// Chat-capture detection ENQUEUE PRODUCER (cinatra#1367).
//
// A DELIBERATELY registry-free BullMQ producer. The chat-capture enqueue is
// hooked into `upsertChatThreadInDatabase` (src/lib/database.ts) — the universal
// chat-persistence chokepoint reached by the DB-store graph of nearly every
// route (auth -> DB), down to the tiny /sign-in page.
//
// Importing the full `@/lib/background-jobs` runtime from that store-reachable
// path would drag its top-level STATIC `import @/lib/background-jobs-registry`
// (the mega-hub that fans out to EVERY job handler — @cinatra-ai/agents,
// skills, llm, workflows, ...) into the DB-store graph. The route-graph
// analyzer follows dynamic import() too, so the `import("@/lib/background-jobs")`
// escape hatch did NOT keep it out: it exploded every store route's first-party
// graph (/sign-in 142 -> 1400+ modules) and, with it, Turbopack's build peak
// memory (`ResourceExhausted: cannot allocate memory`). The route-graph ratchet
// baseline pins the invariant: the store graph reaches the DB but NOT the
// background-jobs registry.
//
// So this producer talks to the SAME BullMQ queue BY NAME via its own
// lightweight producer connection. `bullmq` + `ioredis` are serverExternalPackages
// (never bundled / traversed by the analyzer), and this module imports NOTHING
// that reaches the registry. The single boot-started worker
// (src/instrumentation.node.ts -> @/lib/background-jobs) drains the queue; a
// producer connection to the same QUEUE_NAME is BullMQ's standard producer/
// consumer fan-in, so the job is processed identically.
//
// Connection config MIRRORS @/lib/background-jobs (the runtime source of truth);
// the two are kept in lockstep on purpose (the values are stable env-derived
// infra constants).

import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { BACKGROUND_JOB_NAMES } from "@/lib/background-jobs-names";

const QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME ?? "cinatra-background-jobs";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

function getRedisUrl(): string {
  return process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
}

// Mirrors @/lib/background-jobs.redisReconnectBackoff: exponential to a 2s cap,
// no silent-drop safety cap (see the note on the runtime copy).
function redisReconnectBackoff(times: number): number {
  return Math.min(2000, 100 * Math.pow(2, Math.min(times - 1, 10)));
}

// Hot-reload guard: hold the producer Queue on globalThis (NOT a module-scoped
// `let`) so a Turbopack/vitest module re-evaluation reuses the one connection
// instead of opening a fresh IORedis every reload — the same dev connection-storm
// hazard @/lib/background-jobs guards with its globalThis runtime singleton.
declare global {
  var __cinatraChatCaptureProducerQueue: Queue | undefined;
}

function getProducerQueue(): Queue {
  if (globalThis.__cinatraChatCaptureProducerQueue) {
    return globalThis.__cinatraChatCaptureProducerQueue;
  }
  const connection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    connectTimeout: 1500,
    enableOfflineQueue: false,
    retryStrategy: redisReconnectBackoff,
  });
  // A missing 'error' listener makes a dropped/refused Redis connection an
  // uncaught exception (Node treats EventEmitter 'error' as fatal). Same guard
  // the runtime's queue connection uses.
  connection.on("error", (err) => {
    console.error("[chat-capture] Redis producer connection error:", err.message);
  });
  const queue = new Queue(QUEUE_NAME, {
    connection,
    // Same cleanup defaults as the shared runtime so chat-capture jobs age out
    // of Redis identically. The per-call `attempts` overrides the default 1.
    defaultJobOptions: { removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
  });
  globalThis.__cinatraChatCaptureProducerQueue = queue;
  return queue;
}

export type ChatCaptureEnqueueOptions = Pick<JobsOptions, "jobId" | "attempts" | "backoff">;

export type ChatCaptureDetectionJobData = {
  threadId: string;
  turnId: string;
  ownerUserId: string;
};

/**
 * Enqueue the CHAT_CAPTURE_DETECTION job onto the shared background-jobs queue
 * via the registry-free producer. Best-effort: the sole caller
 * (`maybeEnqueueChatCaptureForThread`) wraps this in a degrade-to-no-op
 * try/catch, so a queue/Redis failure never affects the thread persist.
 *
 * No actor-context attachment (unlike the generic `enqueueBackgroundJob`): the
 * chat-capture pipeline resolves everything from the payload `ownerUserId` and
 * reads no ALS actor frame, and this is a silent background autosave — a
 * per-turn user-attributed job lifecycle notification would be wrong.
 */
export async function enqueueChatCaptureDetectionJob(
  data: ChatCaptureDetectionJobData,
  options: ChatCaptureEnqueueOptions,
): Promise<void> {
  const queue = getProducerQueue();
  await queue.waitUntilReady();
  await queue.add(BACKGROUND_JOB_NAMES.CHAT_CAPTURE_DETECTION, data, options);
}

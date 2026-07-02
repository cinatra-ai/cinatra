import "server-only";

import type { ChildProcess } from "child_process";
import { Queue, Worker, type JobsOptions, type Job } from "bullmq";
import IORedis from "ioredis";
import { readMetadataValueFromDatabase, writeMetadataValueToDatabase } from "@/lib/database";
import type { ActorContext } from "@/lib/authz/actor-context";
// Side-effect import registers the notifications host adapters before the
// first @cinatra-ai/notifications/server use on the
// worker path (the BullMQ worker is eagerly started from
// src/instrumentation.node.ts:361 -> this module; the :1062/:1114 dynamic
// /server imports reach the writers and import NEITHER the facade NOR the
// stream route). This is a permitted top-level @/lib host import: it pulls
// ONLY the TRUE-LEAF @cinatra-ai/notifications/host-adapters (zero deps, no
// server graph, no @/lib/auth) — the PACKAGE server helpers stay behind the
// existing dynamic await import("@cinatra-ai/notifications/server") calls.
import "@/lib/notifications-host";
import { getActorContext, withActorContext } from "@cinatra-ai/llm/actor-context";
import { dispatchRegisteredJob } from "@/lib/background-jobs-registry";

// The background-job NAME constants, the `BackgroundJobName` type, and the
// canonical recurring-loop jobIds now live in the leaf module
// `background-jobs-names.ts` so both this thin runtime module AND the handler
// registry can import them without an init-time circular import. They are
// RE-EXPORTED here so the public `@/lib/background-jobs` import surface stays
// byte-stable for the existing importers (cinatra#304).
export {
  BACKGROUND_JOB_NAMES,
  type BackgroundJobName,
  GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
  ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
  AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
  LITELLM_PRICING_SYNC_LOOP_JOB_ID,
  MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
  VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
  PM_SCHEDULE_RECONCILE_LOOP_JOB_ID,
} from "@/lib/background-jobs-names";
import type { BackgroundJobName } from "@/lib/background-jobs-names";

type BackgroundJobRuntime = {
  version: string;
  queue: Queue;
  worker?: Worker;
  waitUntilReady: Promise<void>;
  workerWaitUntilReady?: Promise<void>;
  abortControllers: Map<string, AbortController>;
  childProcesses: Map<string, ChildProcess>;
  abortPollers: Map<string, ReturnType<typeof setInterval>>;
  /**
   * Once-per-runtime guard for the boot-time
   * `registerSkillMatchScheduleAtBoot()` call. Set to true the first time
   * `ensureBackgroundJobRuntime()` runs the registration so subsequent
   * invocations skip it (idempotent BullMQ upsertJobScheduler still safe,
   * but skip the DB read on the hot path).
   */
  skillMatchScheduleRegistered?: boolean;
  /**
   * Once-per-runtime guard for the boot-time
   * `registerSkillMatchDriftSamplerAtBoot()` call. Same structure as
   * `skillMatchScheduleRegistered` above. Independent flag because the drift
   * sampler can be toggled separately from the batch scheduler (see
   * drift-sampler-boot.ts).
   */
  skillMatchDriftSamplerRegistered?: boolean;
};

export const QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME ?? "cinatra-background-jobs";
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
// Use pid + boot timestamp instead of randomUUID() so re-imports of this
// module under Turbopack/vitest hot-reload share the same RUNTIME_VERSION
// within a single Node process. Per-import UUIDs would make getRuntime()
// recreate the queue/worker on each module re-evaluation and trigger Redis
// connection storms during dev hot-reload.
const RUNTIME_VERSION = `${process.pid}-${process.env.CINATRA_RUNTIME_BOOT_TS ?? "boot"}`;
const BACKGROUND_JOB_CANCELLATION_METADATA_KEY = "background_job_cancellation_requests";
const BACKGROUND_JOB_ABORT_POLL_INTERVAL_MS = 750;

declare global {
  var __cinatraBackgroundJobRuntime: BackgroundJobRuntime | undefined;
  var __cinatraBackgroundJobExecutionDepth: number | undefined;
}

function getRedisUrl() {
  return process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL;
}

function createRedisUnavailableError(error: unknown) {
  const reason = error instanceof Error ? error.message : "Unknown Redis connection error.";
  return new Error(
    `BullMQ requires a reachable Redis server at ${getRedisUrl()}. ${reason}`,
  );
}

function readCancellationRequests() {
  return readMetadataValueFromDatabase<Record<string, boolean>>(BACKGROUND_JOB_CANCELLATION_METADATA_KEY, {});
}

function writeCancellationRequests(value: Record<string, boolean>) {
  writeMetadataValueToDatabase(BACKGROUND_JOB_CANCELLATION_METADATA_KEY, value);
}

function markBackgroundJobCancellationRequested(jobId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return;
  }

  const current = readCancellationRequests();
  writeCancellationRequests({
    ...current,
    [normalizedJobId]: true,
  });
}

function clearBackgroundJobCancellationRequested(jobId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return;
  }

  const current = readCancellationRequests();
  if (!(normalizedJobId in current)) {
    return;
  }

  const next = { ...current };
  delete next[normalizedJobId];
  writeCancellationRequests(next);
}

function isBackgroundJobCancellationRequested(jobId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return false;
  }

  return readCancellationRequests()[normalizedJobId] === true;
}

/**
 * Attach a serialized ActorContext to a job-data payload under the
 * platform-managed key `__actorContext`. The leading double underscore
 * signals this is owned by the queue infrastructure, not the handler.
 * Returns a shallow copy; never mutates the input.
 */
export function attachActorContextToJobData<T extends Record<string, unknown>>(
  data: T,
  ctx: ActorContext | undefined,
): T & { __actorContext?: ActorContext } {
  // When no ctx is provided, strip any pre-existing `__actorContext` from the
  // input rather than silently inheriting the parent job's actor. Workers that
  // re-enqueue child jobs must thread the current actor explicitly; silent
  // inheritance would make the contract ambiguous.
  if (!ctx) {
    const { __actorContext: _strip, ...rest } = data as T & {
      __actorContext?: ActorContext;
    };
    return { ...(rest as T) };
  }
  return { ...data, __actorContext: ctx };
}

/**
 * Run a handler inside a withActorContext frame when the job payload carries
 * `__actorContext`. Otherwise run the handler directly for jobs without
 * actor attribution.
 */
export function runJobHandlerWithActorContext<T>(
  jobData: unknown,
  handler: () => T | Promise<T>,
): T | Promise<T> {
  const ctx = (jobData as { __actorContext?: ActorContext } | null)?.__actorContext;
  if (ctx) {
    return withActorContext(ctx, handler);
  }
  return handler();
}

// The canonical recurring-loop jobId constants
// (`GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID` et al.) are defined in
// `background-jobs-names.ts` and re-exported from this module's import block at
// the top, so the boot seed (instrumentation.node.ts), the registry handlers,
// and the existing importers all share one source of truth (cinatra#304).

async function dispatchBackgroundJob(job: Job, token?: string) {
  return runJobHandlerWithActorContext(job.data, () => dispatchBackgroundJobImpl(job, token));
}

/**
 * Inner dispatch body: bumps the execution-depth counter, validates the
 * payload against the registered handler's schema, and invokes the handler.
 * The name-keyed handler table + per-job payload schemas + the shared
 * recurring-loop helper live in `background-jobs-registry.ts`; this function
 * is the thin runtime seam that wraps the registry dispatch with the
 * execution-depth bookkeeping the old monolithic switch carried.
 */
async function dispatchBackgroundJobImpl(job: Job, _token?: string) {
  globalThis.__cinatraBackgroundJobExecutionDepth =
    (globalThis.__cinatraBackgroundJobExecutionDepth ?? 0) + 1;
  const jobId = String(job.id ?? "");
  try {
    await dispatchRegisteredJob(job, jobId);
  } finally {
    globalThis.__cinatraBackgroundJobExecutionDepth = Math.max(
      0,
      (globalThis.__cinatraBackgroundJobExecutionDepth ?? 1) - 1,
    );
  }
}

/**
 * Test-only export of the inner dispatch body. Bypasses the ALS-frame
 * wrapper (`runJobHandlerWithActorContext`) so unit tests can drive a
 * single registered handler without standing up the full BullMQ runtime + an
 * outer actor context. Production paths must continue to call
 * `dispatchBackgroundJob` (above), not this.
 */
export const __dispatchBackgroundJobForTests = dispatchBackgroundJobImpl;

export function isBackgroundJobExecutionContext() {
  return (globalThis.__cinatraBackgroundJobExecutionDepth ?? 0) > 0;
}

/**
 * Capped exponential backoff for Redis client reconnect — RETRIES FOREVER.
 *
 * Returning `null` here would tell IORedis to STOP reconnecting after the
 * first failure — the original silent-drop pattern that made the worker
 * effectively dead after any Redis blip (network hiccup, container restart,
 * brief network partition). Visible symptom: jobs piled up in BullMQ `wait`
 * forever while `active` stayed at 0.
 *
 * We never give up automatically. The exponential climb plateaus at the
 * 2000ms ceiling so a long outage doesn't eat CPU on retry. Sustained
 * outages stay visible through the rate-limited `worker.on("error")`
 * listener below, which logs + Sentry-captures without forcing a runtime
 * tear-down (transient IORedis errors during reconnect must not create
 * duplicate workers on the next `ensureBackgroundJobRuntime()` call).
 *
 * A `if (times > 50) return null` "safety" cap is intentionally NOT used —
 * it would reintroduce silent-drop after ~93s.
 */
export function redisReconnectBackoff(times: number): number {
  return Math.min(2000, 100 * Math.pow(2, Math.min(times - 1, 10)));
}

function createRuntime() {
  const queueConnection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    connectTimeout: 1500,
    enableOfflineQueue: false,
    retryStrategy: redisReconnectBackoff,
  });
  // Prevent Redis connection errors from killing the process.
  // IORedis emits 'error' when the connection drops or is refused. Without a
  // listener, Node.js treats EventEmitter 'error' as an uncaught exception.
  queueConnection.on("error", (err) => {
    console.error("[background-jobs] Redis queue connection error:", err.message);
  });

  const queue = new Queue(QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: 200,
      removeOnFail: 500,
      attempts: 1,
    },
  });

  const runtime: BackgroundJobRuntime = {
    version: RUNTIME_VERSION,
    queue,
    abortControllers: new Map(),
    childProcesses: new Map(),
    abortPollers: new Map(),
    waitUntilReady: queue.waitUntilReady().then(() => undefined),
  };

  return runtime;
}

async function closeRuntime(runtime: BackgroundJobRuntime | undefined) {
  if (!runtime) {
    return;
  }

  runtime.abortControllers.clear();
  runtime.childProcesses.clear();
  for (const poller of runtime.abortPollers.values()) {
    clearInterval(poller);
  }
  runtime.abortPollers.clear();

  try {
    await runtime.worker?.close();
  } catch {
    // noop
  }

  try {
    await runtime.queue.close();
  } catch {
    // noop
  }
}

function ensureWorker(runtime: BackgroundJobRuntime) {
  if (runtime.worker && runtime.workerWaitUntilReady) {
    return runtime.workerWaitUntilReady;
  }

  const workerConnection = new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    connectTimeout: 1500,
    enableOfflineQueue: false,
    retryStrategy: redisReconnectBackoff,
  });
  // Same guard as queueConnection above — prevents dropped Redis connections
  // from emitting unhandled 'error' events that kill the process.
  workerConnection.on("error", (err) => {
    console.error("[background-jobs] Redis worker connection error:", err.message);
  });

  const worker = new Worker(QUEUE_NAME, dispatchBackgroundJob, {
    connection: workerConnection,
    concurrency: 4,
  });

  // Emit an in-progress notification when the worker picks a job up. The same
  // recipient policy gates the row, so users only see running rows for jobs
  // whose terminal events they'd also see.
  worker.on("active", (job) => {
    void notifyJobStarted(job).catch(() => {
      // Notification failures must never break the worker.
    });
  });

  worker.on("completed", (job) => {
    const key = String(job.id ?? "");
    runtime.abortControllers.delete(key);
    runtime.childProcesses.delete(key);
    const poller = runtime.abortPollers.get(key);
    if (poller) {
      clearInterval(poller);
      runtime.abortPollers.delete(key);
    }
    clearBackgroundJobCancellationRequested(key);

    // Fire-and-forget notification for user-initiated jobs.
    // Per the recipient policy, system jobs return null on success and emit
    // nothing here. The dynamic import keeps the notifications module out of
    // the worker boot graph when it's never used.
    void notifyJobLifecycle(job, undefined, "completed").catch(() => {
      // Notification failures must never break the worker.
    });
  });
  worker.on("failed", (job, err) => {
    const key = String(job?.id ?? "");
    runtime.abortControllers.delete(key);
    runtime.childProcesses.delete(key);
    const poller = runtime.abortPollers.get(key);
    if (poller) {
      clearInterval(poller);
      runtime.abortPollers.delete(key);
    }
    clearBackgroundJobCancellationRequested(key);

    // Capture worker failures in Sentry. No-op when SENTRY_DSN is unset;
    // helper has its own try/catch and never throws.
    // Kept dynamic to avoid a new top-level import in background-jobs.
    void import("@cinatra-ai/errors/server").then(({ captureBackgroundJobError }) =>
      captureBackgroundJobError(err, {
        jobName: job?.name,
        jobId: job?.id,
        queueName: QUEUE_NAME,
      }),
    ).catch(() => {
      // Sentry helper unavailable — never break the worker.
    });

    // Fire-and-forget user/admin notification for failed jobs.
    void notifyJobLifecycle(job, err, "failed").catch(() => {
      // Notification failures must never break the worker.
    });
  });

  // Surface non-job worker failures (Redis disconnects, dispatcher throws
  // before the handler, internal BullMQ exceptions). Without this listener,
  // worker errors hit an unhandled-error path that silently kills the
  // worker — observed live as jobs piling up in BullMQ `wait` while
  // `active` stayed at 0. RATE-LIMITED to once per 30s so a sustained
  // Redis outage doesn't flood the log. Crucially this does NOT clear
  // `runtime.worker` — transient IORedis errors during reconnect must not
  // create duplicate live Workers on the next `ensureWorker` call (each
  // Worker holds its own Redis connection + concurrency slots).
  let lastWorkerErrorLogAt = 0;
  worker.on("error", (err) => {
    const now = Date.now();
    if (now - lastWorkerErrorLogAt < 30_000) return;
    lastWorkerErrorLogAt = now;
    console.error("[background-jobs] worker.on('error'):", err);
    void import("@cinatra-ai/errors/server").then(({ captureBackgroundJobError }) =>
      captureBackgroundJobError(err, {
        jobName: "<worker-runtime-error>",
        queueName: QUEUE_NAME,
      }),
    ).catch(() => {
      // Sentry helper unavailable — never break the worker.
    });
  });
  // The actual unhealthy-runtime signal: BullMQ's "closed" event fires once
  // the Worker has fully shut down (it fires from inside `Worker.close()`
  // completion, including any path that calls `close()` internally — not a
  // reliable Redis-EOF signal on its own). Clear the runtime slots here so
  // the next `ensureWorker(runtime)` rebuilds a fresh Worker against a
  // healthy connection. The Worker close itself ran inside BullMQ, so we
  // don't re-call `.close()` (would double-end the Redis client).
  worker.on("closed", () => {
    console.warn(
      "[background-jobs] worker emitted 'closed' — clearing runtime so next ensureWorker rebuilds",
    );
    runtime.worker = undefined;
    runtime.workerWaitUntilReady = undefined;
  });

  runtime.worker = worker;
  runtime.workerWaitUntilReady = worker.waitUntilReady().then(() => undefined);
  return runtime.workerWaitUntilReady;
}

function getRuntime() {
  const currentRuntime = globalThis.__cinatraBackgroundJobRuntime;
  if (currentRuntime && currentRuntime.version !== RUNTIME_VERSION) {
    void closeRuntime(currentRuntime);
    globalThis.__cinatraBackgroundJobRuntime = undefined;
  }

  if (!globalThis.__cinatraBackgroundJobRuntime) {
    globalThis.__cinatraBackgroundJobRuntime = createRuntime();
  }

  return globalThis.__cinatraBackgroundJobRuntime;
}

export async function ensureBackgroundJobRuntime() {
  const runtime = getRuntime();
  try {
    await runtime.waitUntilReady;
    await ensureWorker(runtime);
    // Register the optional skill-match batch scheduler exactly once per
    // runtime when enabled in DB.
    // Idempotent: BullMQ `upsertJobScheduler` is safe to call repeatedly, but
    // the once-per-runtime guard avoids the DB read on the hot path.
    // Never crash boot on schedule registration failure — log and continue.
    if (!runtime.skillMatchScheduleRegistered) {
      runtime.skillMatchScheduleRegistered = true;
      try {
        const { registerSkillMatchScheduleAtBoot } = await import("@cinatra-ai/skills");
        await registerSkillMatchScheduleAtBoot();
      } catch (err) {
        console.warn("[background-jobs] skill-match schedule registration failed:", err);
      }
    }
    // Register the optional drift sampler scheduler exactly once per runtime.
    // Independent flag from the batch scheduler above (the operator can enable
    // one without the other). Never crash boot — log and continue.
    if (!runtime.skillMatchDriftSamplerRegistered) {
      runtime.skillMatchDriftSamplerRegistered = true;
      try {
        const { registerSkillMatchDriftSamplerAtBoot } = await import("@cinatra-ai/skills");
        await registerSkillMatchDriftSamplerAtBoot();
      } catch (err) {
        console.warn(
          "[background-jobs] skill-match drift sampler registration failed:",
          err,
        );
      }
    }
    return runtime;
  } catch (error) {
    await closeRuntime(runtime);
    globalThis.__cinatraBackgroundJobRuntime = undefined;
    throw createRedisUnavailableError(error);
  }
}

/**
 * Exposes the IORedis instance owned by the BullMQ queue runtime.
 *
 * Used by the trigger-gate fast-path (`packages/agent-builder/src/trigger-gate.ts`)
 * to read/write `trigger:released:{runId}` flags without spinning up a second
 * Redis connection. Lazily boots the runtime if not already initialised — safe to
 * call from server actions, MCP handlers, and worker handlers alike.
 */
export async function getRedisConnection(): Promise<IORedis> {
  const runtime = await ensureBackgroundJobRuntime();
  // BullMQ queues hold an IORedis instance on opts.connection.
  const conn = runtime.queue.opts.connection as unknown;
  if (!conn || typeof conn !== "object") {
    throw new Error("getRedisConnection: BullMQ runtime has no Redis connection");
  }
  // The connection object is an IORedis instance — has .exists, .set, .del methods.
  return conn as IORedis;
}

export async function getQueueDashContext() {
  const runtime = getRuntime();
  try {
    await runtime.waitUntilReady;
  } catch (error) {
    await closeRuntime(runtime);
    globalThis.__cinatraBackgroundJobRuntime = undefined;
    throw createRedisUnavailableError(error);
  }

  return {
    queues: [
      {
        queue: runtime.queue,
        displayName: "Cinatra Background Jobs",
        type: "bullmq" as const,
      },
    ],
  };
}

export async function enqueueBackgroundJob(
  name: BackgroundJobName,
  data: Record<string, unknown>,
  // `attempts` and `backoff` are opt-in per call. Existing callers that omit
  // them keep BullMQ's default (`attempts: 1`, i.e. run-once) so jobs that
  // send email / trigger webhooks / publish blog posts retain their
  // intentional single-shot behavior. Only callers that explicitly want
  // retry-on-transient-failure, such as the artifact matcher worker whose LLM
  // calls fail intermittently, pass them. Both the `skipWorker` and normal
  // paths already spread `...jobOpts` into `queue.add`, so widening the Pick is
  // sufficient — no path change.
  options?: Pick<
    JobsOptions,
    "jobId" | "priority" | "delay" | "attempts" | "backoff"
  > & {
    skipWorker?: boolean;
    // When true and a completed/failed job with the same jobId exists, removes
    // it before adding the new entry so BullMQ HSETNX doesn't silently no-op.
    // Use only with skipWorker:true bootstrap calls (crash-restart dedup).
    overwriteIfStale?: boolean;
    /**
     * When provided, the ActorContext is serialized onto the job payload under
     * `__actorContext`. The worker dispatcher reads this back and
     * re-establishes the AsyncLocalStorage frame before invoking the
     * registered handler so downstream MCP / scope filtering code can read the
     * originating actor.
     *
     * When this is undefined, an auto-attribution cascade attaches a HumanUser
     * ActorContext if the caller is inside an ALS frame (route handler /
     * server action) or has a better-auth session in scope. See
     * `resolveImplicitActorContext()` below. The cascade ONLY ever yields
     * HumanUser principals — never auto-attributes ServiceAccount /
     * InternalWorker / System / ExternalA2AAgent contexts.
     */
    actorContext?: ActorContext;
    /**
     * Set to `false` to opt out of the auto-attribution cascade entirely. Use
     * this from clearly-system-context enqueues (e.g. instrumentation cron,
     * worker-internal child-job re-enqueues that shouldn't inherit the
     * parent's user attribution).
     *
     * Default `true`. The cascade only fires when `actorContext === undefined`.
     */
    inheritActorContext?: boolean;
  },
) {
  const explicitCtx = options?.actorContext;
  const ctx =
    explicitCtx ??
    (options?.inheritActorContext !== false
      ? await resolveImplicitActorContext()
      : undefined);
  const payload = attachActorContextToJobData(data, ctx);
  if (options?.skipWorker) {
    // Only create the queue connection (no worker) — used by instrumentation to
    // schedule delayed jobs without resuming stale Redis jobs at startup.
    const runtime = getRuntime();
    await runtime.waitUntilReady;
    const {
      skipWorker: _,
      overwriteIfStale,
      actorContext: _ac,
      inheritActorContext: _ih,
      ...jobOpts
    } = options;
    if (overwriteIfStale && jobOpts.jobId) {
      const existing = await runtime.queue.getJob(jobOpts.jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "completed" || state === "failed") {
          await existing.remove();
        }
      }
    }
    const job = await runtime.queue.add(name, payload, jobOpts);
    return String(job.id);
  }
  const {
    actorContext: _ac,
    inheritActorContext: _ih,
    ...jobOpts
  } = options ?? {};
  const runtime = await ensureBackgroundJobRuntime();
  const job = await runtime.queue.add(name, payload, jobOpts);
  return String(job.id);
}

/**
 * Resolve a HumanUser ActorContext for the calling request scope, used when
 * an enqueue site does not explicitly pass one.
 *
 * Cascade:
 *   1. Active ALS frame (`getActorContext()`) — but only when principalType
 *      is "HumanUser". Worker child-enqueues running under ServiceAccount /
 *      InternalWorker / System / ExternalA2AAgent frames must thread the
 *      actor explicitly via `options.actorContext` — silent inheritance of
 *      non-user principals would mis-attribute notifications and any other
 *      downstream scope-filtered reads.
 *   2. Request scope via `resolveRequestActorContext()` — works inside
 *      server actions / route handlers where Next's `headers()` is callable.
 *
 * Returns `undefined` outside both contexts (system / instrumentation /
 * worker without a user frame). Downstream code treats undefined as "no
 * actor attribution" — the notifications recipient policy already routes
 * those to admin fanout on failure and silence on success.
 */
async function resolveImplicitActorContext(): Promise<ActorContext | undefined> {
  const frameCtx = getActorContext();
  if (frameCtx?.principalType === "HumanUser" && frameCtx.principalId) {
    return frameCtx;
  }
  if (frameCtx && frameCtx.principalType !== "HumanUser") {
    // Non-user frame — never auto-attribute. Caller must pass explicitly if
    // a user-scoped enqueue is intended from here.
    return undefined;
  }
  // Dynamic-import the request helper so a hypothetical worker bundle that
  // can't resolve `server-only` still loads background-jobs.ts cleanly; the
  // helper itself catches `headers()`/`getAuthSession()` failures inside its
  // try/catch. Module-load failure here also returns undefined.
  try {
    const { resolveRequestActorContext } = await import(
      "@cinatra-ai/notifications/server"
    );
    return await resolveRequestActorContext();
  } catch {
    return undefined;
  }
}

/**
 * Enqueues a child job linked to the given parent job, then parks the parent
 * in BullMQ's `waiting-children` state so it releases its worker slot.
 * When the child completes (or fails with failParentOnFailure), the parent
 * is automatically re-queued and the worker picks it up again.
 *
 * Returns `true` if the parent was successfully parked (worker slot released).
 * Returns `false` if the child already completed before the parent could park —
 * in this case the caller must NOT return immediately; it should continue to the
 * next step inline so the pipeline is not silently stalled.
 *
 * Use `job.data.step` (or similar) in the parent handler to track which
 * resumption pass is running.
 */
export async function enqueueChildJob(
  parentJob: Job,
  token: string,
  childName: BackgroundJobName,
  childData: Record<string, unknown>,
  options?: { failParentOnFailure?: boolean },
): Promise<boolean> {
  const runtime = getRuntime();
  await runtime.waitUntilReady;

  // Derive queue prefix from BullMQ runtime instead of hardcoding "bull:".
  // queue.qualifiedName returns `${prefix}:${queueName}` (verified in bullmq@5.71.1 queue-base.js).
  const qualifiedParentQueue = runtime.queue.qualifiedName;

  const shouldFailParent = options?.failParentOnFailure ?? true;

  await runtime.queue.add(childName, childData, {
    parent: {
      id: String(parentJob.id),
      queue: qualifiedParentQueue,
    },
    failParentOnFailure: shouldFailParent,
    removeOnComplete: 200,
    removeOnFail: 500,
    attempts: 1,
  });

  const moved = await parentJob.moveToWaitingChildren(token);
  if (!moved) {
    // Child already completed before the parent could park — the parent remains
    // active in the current activation. The caller must NOT return here; it
    // should fall through to the next step so the pipeline is not stalled.
    console.log(
      `[background-jobs] enqueueChildJob: child already completed before parent could park (parentId: ${parentJob.id})`,
    );
  }
  return moved;
}

export async function isBackgroundJobActive(jobId: string): Promise<boolean> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return false;
  }
  try {
    const runtime = await ensureBackgroundJobRuntime();
    const job = await runtime.queue.getJob(normalizedJobId);
    if (!job) {
      return false;
    }
    const state = await job.getState();
    return state === "active" || state === "waiting" || state === "delayed" || state === "waiting-children";
  } catch {
    return false;
  }
}

export async function cancelBackgroundJob(jobId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return false;
  }

  markBackgroundJobCancellationRequested(normalizedJobId);

  const runtime = await ensureBackgroundJobRuntime();
  const controller = runtime.abortControllers.get(normalizedJobId);
  if (controller) {
    controller.abort();
  }

  const child = runtime.childProcesses.get(normalizedJobId);
  if (child?.pid) {
    try {
      child.kill("SIGTERM");
    } catch {
      // noop
    }
  }

  const queuedJob = await runtime.queue.getJob(normalizedJobId);
  if (!queuedJob) {
    return Boolean(controller || child);
  }

  const state = await queuedJob.getState();
  if (state === "waiting-children") {
    // Parent is parked waiting for children. BullMQ's job.remove() only cascades
    // to waiting/delayed children — it does NOT terminate active child jobs.
    // Explicitly cancel each child so active child workers receive the abort signal.
    // getDependencies() with no opts returns all processed+unprocessed children in one call.
    let processed: Record<string, unknown> = {};
    let unprocessed: string[] = [];
    try {
      const deps = await queuedJob.getDependencies();
      processed = (deps.processed as Record<string, unknown>) ?? {};
      unprocessed = (deps.unprocessed as string[]) ?? [];
    } catch {
      // noop — if getDependencies fails, fall through to remove the parent anyway
    }
    const allChildIds = [
      ...Object.keys(processed),
      ...unprocessed,
    ];
    for (const childId of allChildIds) {
      markBackgroundJobCancellationRequested(childId);
      try {
        const childJob = await runtime.queue.getJob(childId);
        const childState = await childJob?.getState();
        if (childJob && childState !== "active") {
          await childJob.remove().catch(() => undefined);
        }
        // Active children: cancellation flag above ensures the abort-poll
        // mechanism signals them; we cannot forcibly terminate an active worker.
      } catch {
        // noop — best effort per child
      }
    }
    try {
      await queuedJob.remove();
    } catch {
      // Removal may fail if children are still active; cancellation flag is set.
    }
  } else if (state !== "active") {
    try {
      await queuedJob.remove();
    } catch {
      // noop
    }
  }

  return true;
}

export function registerBackgroundJobAbortController(jobId: string, controller: AbortController) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return;
  }
  const runtime = getRuntime();
  runtime.abortControllers.set(normalizedJobId, controller);

  const existingPoller = runtime.abortPollers.get(normalizedJobId);
  if (existingPoller) {
    clearInterval(existingPoller);
  }

  if (isBackgroundJobCancellationRequested(normalizedJobId)) {
    controller.abort();
    return;
  }

  const poller = setInterval(() => {
    if (controller.signal.aborted) {
      clearInterval(poller);
      runtime.abortPollers.delete(normalizedJobId);
      return;
    }

    if (isBackgroundJobCancellationRequested(normalizedJobId)) {
      controller.abort();
      clearInterval(poller);
      runtime.abortPollers.delete(normalizedJobId);
    }
  }, BACKGROUND_JOB_ABORT_POLL_INTERVAL_MS);

  runtime.abortPollers.set(normalizedJobId, poller);
}

export function unregisterBackgroundJobAbortController(jobId: string) {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    return;
  }
  const runtime = getRuntime();
  runtime.abortControllers.delete(normalizedJobId);
  const poller = runtime.abortPollers.get(normalizedJobId);
  if (poller) {
    clearInterval(poller);
    runtime.abortPollers.delete(normalizedJobId);
  }
  clearBackgroundJobCancellationRequested(normalizedJobId);
}

export function registerBackgroundJobChildProcess(jobId: string, child: ChildProcess) {
  if (!jobId.trim()) {
    return;
  }
  getRuntime().childProcesses.set(jobId, child);
}

export function unregisterBackgroundJobChildProcess(jobId: string) {
  if (!jobId.trim()) {
    return;
  }
  getRuntime().childProcesses.delete(jobId);
}

// ---------------------------------------------------------------------------
// Notify on job lifecycle.
//
// Called from the BullMQ worker.on('completed' | 'failed') hooks. Resolves a
// recipient via the policy in packages/notifications/src/recipient-policy.ts and
// fans out to per-user rows. Defensive in every direction: any thrown error
// is swallowed; helper failures must never kill the worker.
// ---------------------------------------------------------------------------
async function notifyJobLifecycle(
  job:
    | { id?: string | number | null; name?: string; data?: unknown }
    | undefined,
  err: unknown,
  status: "completed" | "failed",
): Promise<void> {
  try {
    const {
      getRecipientForJob,
      createNotificationForRecipient,
      resolveAgentRunHref,
    } = await import("@cinatra-ai/notifications/server");
    const recipient = getRecipientForJob({
      jobName: job?.name,
      jobData: job?.data,
      status,
    });
    if (!recipient) return;

    // Resolve the agent-run deep-link from job.data BEFORE the INSERT. The
    // LISTEN/NOTIFY trigger is AFTER INSERT only and the dedupe index is ON
    // CONFLICT DO NOTHING (first write wins, no UPDATE/repair path) — the href
    // must be correct on this first terminal insert. Resolver returns
    // undefined for non-agent jobs (link-less, unchanged).
    const href = await resolveAgentRunHref(job?.data);

    const isError = status === "failed";
    const title = isError
      ? `${prettyJobName(job?.name)} failed`
      : `${prettyJobName(job?.name)} completed`;
    const body = isError ? errorToBody(err) : "Background job finished.";
    await createNotificationForRecipient(recipient, {
      title,
      body,
      kind: isError ? "error" : "success",
      href,
      sourceJobId: job?.id != null ? String(job.id) : undefined,
      sourceJobName: job?.name,
    });
  } catch (notifyErr) {
    console.warn(
      "[background-jobs] notifyJobLifecycle skipped:",
      notifyErr instanceof Error ? notifyErr.message : notifyErr,
    );
  }
}

// ---------------------------------------------------------------------------
// Notify on job start (BullMQ worker.on("active")).
//
// Inserts an `info`-kind, auto-read notification row carrying
// `metadata.progress.status = "running"`. The flyout's In-progress tab
// renders this row with a spinner; once `notifyJobLifecycle` fires for the
// same `sourceJobId` (different `kind`, dedupe-safe per the partial unique
// index), `collapseByJobId` in the client replaces the running row with
// the terminal one.
//
// active fires on every "picked by worker" event, including BullMQ retries
// and waiting-children re-entry. The partial idx makes that idempotent: the
// second running insert for the same (user, jobId, kind="info") is a no-op
// via ON CONFLICT DO NOTHING.
// ---------------------------------------------------------------------------
async function notifyJobStarted(
  job: { id?: string | number | null; name?: string; data?: unknown } | undefined,
): Promise<void> {
  try {
    if (!job?.id || !job?.name) return;
    const {
      getRecipientForJob,
      createBackgroundProgressNotification,
      resolveAgentRunHref,
    } = await import("@cinatra-ai/notifications/server");
    const recipient = getRecipientForJob({
      jobName: job.name,
      jobData: job.data,
      status: "started",
    });
    if (!recipient) return;
    // Resolve the agent-run deep-link from job.data and set it inline on the
    // running INSERT (worker.on("active") fires before the dispatcher;
    // resolution is awaited so the href is present on the first — and only —
    // running row, since ON CONFLICT DO NOTHING means there is no later repair
    // path). Non-agent jobs resolve to undefined -> link-less, unchanged.
    const href = await resolveAgentRunHref(job.data);
    await createBackgroundProgressNotification({
      recipient,
      jobId: String(job.id),
      jobName: job.name,
      title: `${prettyJobName(job.name)} in progress`,
      body: "Started.",
      href,
    });
  } catch (notifyErr) {
    console.warn(
      "[background-jobs] notifyJobStarted skipped:",
      notifyErr instanceof Error ? notifyErr.message : notifyErr,
    );
  }
}

function prettyJobName(name: string | undefined): string {
  if (!name) return "Background job";
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function errorToBody(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "string") return err;
  return "Unknown error";
}

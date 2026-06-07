import "server-only";

import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { ENGINE_OPS } from "./ops";
import { reconcileWorkflow, type ReconcileDeps } from "./reconciler";
import { reconcileDueWorkflows } from "./lifecycle";

// Dedicated, worktree-isolated BullMQ runtime for the reconciler.
// Self-contained in the package (its own Queue + Worker on ENGINE_OPS.queueName)
// so the host only calls ensureWorkflowEngine() once at boot. A repeatable
// tick reconciles all due workflows; an on-demand job reconciles a single one
// (enqueued after edits/start/events/agent completion).

let booted = false;
let queueRef: Queue | undefined;

function connection(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
}

export type EngineRuntime = { queue: Queue; worker: Worker };

/** Boot the reconciler runtime (idempotent; soft-fails if Redis is unreachable). */
export async function ensureWorkflowEngine(deps: ReconcileDeps = {}): Promise<EngineRuntime | null> {
  if (booted) return null;
  booted = true;
  try {
    const queue = new Queue(ENGINE_OPS.queueName, { connection: connection() });
    const worker = new Worker(
      ENGINE_OPS.queueName,
      async (job: Job) => {
        const wfId = (job.data as { workflowId?: string } | undefined)?.workflowId;
        if (wfId) await reconcileWorkflow(wfId, deps);
        else await reconcileDueWorkflows(deps);
      },
      { connection: connection(), concurrency: 1 },
    );
    worker.on("error", (err) =>
      console.error("[release-workflows:engine] worker error:", err.message),
    );
    await queue.upsertJobScheduler(
      "workflows-reconciler-tick",
      { every: ENGINE_OPS.tickEveryMs },
      { name: "tick", data: {}, opts: { removeOnComplete: 50, removeOnFail: 100 } },
    );
    queueRef = queue;
    return { queue, worker };
  } catch (err) {
    booted = false;
    console.error("[release-workflows:engine] boot failed:", (err as Error).message);
    return null;
  }
}

/** Enqueue an on-demand reconcile for one workflow (after edit/start/event). */
export async function enqueueWorkflowReconcile(workflowId: string): Promise<boolean> {
  if (!queueRef) return false;
  await queueRef.add(
    "reconcile",
    { workflowId },
    { jobId: `reconcile-${workflowId}`, removeOnComplete: 100, removeOnFail: 100 },
  );
  return true;
}

/** Test seam — reset the module-level boot guard. */
export function __resetEngineRuntimeForTests(): void {
  booted = false;
  queueRef = undefined;
}

// System-loops boot phases (engineering #302).
//
// The BullMQ recurring-loop seeds + the eager worker registration + the durable
// workflow reconciler + the skills relocation worker, extracted verbatim from
// `instrumentation.node.ts`. Each seed dedups by a stable jobId (BullMQ-level
// crash-restart dedup) and self-reschedules in the handler — the boot job only
// PRIMES the loop. All `retryable`/`degraded`: each had its own log+swallow
// ("Redis unavailable -> non-fatal"); none aborted boot.
//
// ORDERING preserved: the loop seeds run with skipWorker:true FIRST, then the
// eager worker registration runs AFTER so queued jobs from a prior process are
// drained without waiting for the first user request.
//
// Deliberately NOT importing "server-only": unit tests import the phase list.

import type { BootPhase } from "@/lib/boot/boot-phase";

export function systemLoopPhases(): BootPhase[] {
  return [
    {
      name: "seed-litellm-pricing-sync",
      policy: "retryable",
      run: async () => {
        // Schedule weekly LiteLLM pricing sync (one-time at startup). BullMQ
        // deduplicates by jobId, so restarts don't create duplicates.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          LITELLM_PRICING_SYNC_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC,
          {},
          {
            jobId: LITELLM_PRICING_SYNC_LOOP_JOB_ID,
            delay: 7 * 24 * 60 * 60 * 1000, // 7 days
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log("[metric-cost-api] LiteLLM weekly sync scheduled (7-day delay)");
      },
    },
    {
      name: "seed-audit-retention-sweep",
      policy: "retryable",
      run: async () => {
        // Seed the daily audit-log retention sweep (one-time at startup; BullMQ
        // dedups by jobId). The worker handler self-reschedules at 24h cadence.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.AUDIT_RETENTION_ENFORCE,
          {},
          {
            jobId: AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
            delay: 24 * 60 * 60 * 1000, // 24h
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log("[authz/audit] daily retention sweep scheduled (24h delay)");
      },
    },
    {
      name: "seed-marketplace-catalog-sync",
      policy: "retryable",
      run: async () => {
        // Seed the marketplace catalog sync's hourly full-sweep loop. The handler
        // self-reschedules at 1h cadence after each run via moveToDelayed.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.MARKETPLACE_CATALOG_SYNC,
          {},
          {
            jobId: MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
            delay: 60 * 60 * 1000, // 1h
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log("[marketplace-catalog-sync] hourly full-sweep loop scheduled (1h delay)");
      },
    },
    {
      name: "seed-vendor-application-reconcile",
      policy: "retryable",
      run: async () => {
        // Seed the vendor-application state reconcile loop. The handler
        // self-reschedules at 5-min cadence after each run via moveToDelayed.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.VENDOR_APPLICATION_STATE_RECONCILE,
          {},
          {
            jobId: VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
            delay: 5 * 60 * 1000, // 5m
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log(
          "[vendor-application-state-reconcile] 5-minute reconcile loop scheduled (5m delay)",
        );
      },
    },
    {
      name: "seed-pm-schedule-reconcile",
      policy: "retryable",
      run: async () => {
        // Seed the PM schedule reconcile loop (cinatra#318). The handler self-
        // reschedules at ~10-min cadence after each run via moveToDelayed.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          PM_SCHEDULE_RECONCILE_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.PM_SCHEDULE_RECONCILE,
          {},
          {
            jobId: PM_SCHEDULE_RECONCILE_LOOP_JOB_ID,
            delay: 10 * 60 * 1000, // 10m
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log(
          "[pm-schedule-reconcile] ~10-minute reconcile loop scheduled (10m delay)",
        );
      },
    },
    {
      name: "seed-graphiti-projection-repair",
      policy: "retryable",
      run: async () => {
        // Schedule the Graphiti projection repair loop. The shared jobId is the
        // BullMQ-level dedup key: on crash-restart, re-enqueuing the same jobId
        // returns the existing delayed job rather than creating a duplicate loop.
        const { enqueueBackgroundJob, BACKGROUND_JOB_NAMES, GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR,
          {},
          {
            jobId: GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
            delay: 30_000,
            skipWorker: true,
            overwriteIfStale: true,
            inheritActorContext: false,
          },
        );
        console.log("[graphiti-projection-repair] repair loop scheduled (30s delay)");
      },
    },
    {
      name: "seed-artifact-provider-cache-evict",
      policy: "retryable",
      run: async () => {
        // Schedule the provider-file ref-cache eviction sweep (4h period, 5min
        // initial delay so boot traffic settles first). The handler re-delays THIS
        // canonical job in place (moveToDelayed) each cycle.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT,
          {},
          {
            jobId: ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
            delay: 5 * 60_000,
            skipWorker: true,
            overwriteIfStale: true,
            inheritActorContext: false,
          },
        );
        console.log(
          "[artifact-provider-cache-evict] loop scheduled (5m initial delay, 4h period)",
        );
      },
    },
    {
      name: "eager-background-worker",
      policy: "degraded",
      run: async () => {
        // Eager BullMQ worker registration. The bootstrap enqueues above use
        // skipWorker:true, which never registers the BullMQ Worker. Calling
        // ensureBackgroundJobRuntime() AFTER them registers the Worker before any
        // user request lands, so queued jobs from a prior process drain promptly.
        // Idempotent; Redis unavailable -> degraded (jobs wait until the runtime
        // comes up via a later lazy enqueue).
        const { ensureBackgroundJobRuntime } = await import("@/lib/background-jobs");
        await ensureBackgroundJobRuntime();
        console.log("[background-jobs] worker registered eagerly at boot");
      },
    },
    {
      name: "workflow-reconciler-engine",
      policy: "degraded",
      run: async () => {
        // Boot the durable release-workflow reconciler runtime on its own
        // dedicated BullMQ queue. Soft-fails if Redis is unavailable (degraded).
        const { ensureWorkflowEngine, buildExecutorRegistry } = await import(
          "@cinatra-ai/workflows/engine"
        );
        const { buildWorkflowAgentTaskExecutor, getWorkflowChildRunStatus } = await import(
          "@/lib/workflow-agent-executor"
        );
        const { buildWorkflowNotifier } = await import("@/lib/workflow-notifier");
        const { updateAgentRunStatus } = await import("@cinatra-ai/agents");
        await ensureWorkflowEngine({
          executors: buildExecutorRegistry({ agent_task: buildWorkflowAgentTaskExecutor() }),
          getChildRunStatus: getWorkflowChildRunStatus,
          notify: buildWorkflowNotifier(),
          // Tear down in-flight child runs when a reject-cancel cancels the
          // workflow (best-effort; mirrors the cancelWorkflowAction teardown).
          cancelChildRun: async (childRunId: string) => {
            try {
              await updateAgentRunStatus(childRunId, "stopped", { error: "workflow_cancelled" });
            } catch {
              /* best-effort */
            }
          },
        });
        console.log("[workflows] reconciler runtime registered at boot");
      },
    },
    {
      name: "skills-relocation-worker",
      policy: "degraded",
      run: async () => {
        // Relocation worker boot. The crash-recovery sweep MUST run BEFORE
        // startRelocationWorker(): the recovery pass reconciles 'in_progress' rows
        // left over from a crash mid-rename; if the worker started first it would
        // ignore those rows and silently leak partial renames forever.
        const { recoverPendingMoves, startRelocationWorker } = await import(
          "@cinatra-ai/skills"
        );
        await recoverPendingMoves();
        await startRelocationWorker();
        console.log("[skills-relocation] relocation worker started at boot");
      },
    },
  ];
}

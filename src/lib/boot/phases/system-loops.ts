// System-loops boot phases (engineering #302).
//
// The BullMQ recurring-loop seeds + the eager worker registration + the skills
// relocation worker, extracted verbatim from
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
      name: "seed-extension-store-gc-reap",
      policy: "retryable",
      run: async () => {
        // Seed the extension-store GC reaper loop (cinatra#796). The GC itself
        // NEVER runs at boot — boot only creates this delayed job; the worker
        // handler enforces the `current + 2` per-{kind, slug} retention and
        // self-reschedules at 24h cadence via moveToDelayed.
        //
        // The reaper IMPLEMENTATION is registered here (boot-only graph)
        // rather than imported by the handler registry: the registry sits in
        // the locked dev-perf routes' reachable graph (route-graph ratchet),
        // and maintenance-only code must not ride in every enqueuer's
        // request-path graph. Register BEFORE seeding so the loop can never
        // fire against an empty slot in this process.
        const { registerExtensionStoreReaper } = await import("@/lib/background-jobs-registry");
        const { reapExtensionStore } = await import("@/lib/extension-store-reaper");
        registerExtensionStoreReaper(() => reapExtensionStore());
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          EXTENSION_STORE_GC_REAP_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.EXTENSION_STORE_GC_REAP,
          {},
          {
            jobId: EXTENSION_STORE_GC_REAP_LOOP_JOB_ID,
            delay: 24 * 60 * 60 * 1000, // 24h
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log("[extension-store-gc-reap] daily store GC reap scheduled (24h delay)");
      },
    },
    {
      name: "seed-extension-auto-update",
      policy: "retryable",
      run: async () => {
        // Seed the in-app extension auto-update loop (cinatra#1042) — ONLY
        // when the master flag is enabled. Default OFF: with the flag unset
        // the loop is NOT seeded at all this boot (no job, no runner) and
        // this phase only logs the fact. NOTE: a canonical job left over from
        // a previously-ENABLED boot is not removed here — it keeps re-delaying
        // as an inert no-op (the runner slot stays empty and the cycle
        // re-checks the flag), which is safer than boot-time queue removal.
        //
        // The cycle IMPLEMENTATION is registered here (boot-only graph)
        // rather than imported by the handler registry — same route-graph-
        // ratchet posture as the GC reaper above. Register BEFORE seeding so
        // the loop can never fire against an empty slot in this process.
        const { isExtensionAutoUpdateEnabled, runExtensionAutoUpdateCycle } =
          await import("@/lib/extension-auto-update");
        if (!isExtensionAutoUpdateEnabled()) {
          console.log(
            "[extension-auto-update] disabled (CINATRA_EXTENSION_AUTO_UPDATE is not \"true\") — loop not seeded this boot",
          );
          return;
        }
        const { registerExtensionAutoUpdateRunner } = await import(
          "@/lib/background-jobs-registry"
        );
        registerExtensionAutoUpdateRunner(() => runExtensionAutoUpdateCycle());
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.EXTENSION_AUTO_UPDATE,
          {},
          {
            jobId: EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
            delay: 60 * 60 * 1000, // 1h initial (post-boot settle + one catalog-sync sweep first); 24h cadence thereafter
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log(
          "[extension-auto-update] enabled — daily auto-update loop scheduled (1h initial delay)",
        );
      },
    },
    {
      name: "seed-environment-layer-gc-reap",
      policy: "retryable",
      run: async () => {
        // Seed the L1 environment-layer retention GC reaper loop (exec-plane S3
        // A3, cinatra#1708). The GC NEVER runs at boot — boot only creates this
        // delayed job; the worker handler runs the advisory-lock-serialized
        // delete→commit→rmi reap over the durable layer store (reached via the
        // A2 DI slot, no-op when the slot is not `ready`) and self-reschedules at
        // 24h cadence via moveToDelayed. Unlike the extension-store reaper this
        // seed registers NO runner — the reap implementation lives in the A2
        // execution service registered by the environment-execution-service boot
        // phase, so this phase only PRIMES the delayed loop.
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          ENVIRONMENT_LAYER_GC_REAP_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.ENVIRONMENT_LAYER_GC_REAP,
          {},
          {
            jobId: ENVIRONMENT_LAYER_GC_REAP_LOOP_JOB_ID,
            delay: 24 * 60 * 60 * 1000, // 24h
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log("[environment-layer-gc-reap] daily L1 layer GC reap scheduled (24h delay)");
      },
    },
    {
      name: "seed-unbound-output-derive-sweep",
      policy: "retryable",
      run: async () => {
        // Seed the unbound-output derivation reconciliation sweep (cinatra#1893,
        // epic #1883 A5). The sweep NEVER runs at boot — boot only creates this
        // delayed job; the worker handler drains `pending` outbox rows / reclaims
        // expired `deriving` leases and self-reschedules at ~5-min cadence via
        // moveToDelayed. It is the backstop for a lost/crashed one-shot derive
        // enqueue.
        //
        // The derivation IMPLEMENTATION is registered here (boot-only graph)
        // through the runner slot rather than imported into
        // background-jobs-registry — same route-graph-ratchet posture as the
        // GC reaper / auto-update runners: the registry sits in the LOCKED
        // dev-perf routes' graph, so the derivation core must not be reachable
        // (even dynamically) from it. Register BEFORE seeding so neither the loop
        // NOR the one-shot derive handler can observe an empty slot on a healthy
        // boot.
        const { registerUnboundOutputDerivationRunner } = await import(
          "@/lib/background-jobs-registry"
        );
        const { deriveUnboundRunOutput, sweepPendingUnboundDerivations } =
          await import("@/lib/artifacts/unbound-output-derivation");
        registerUnboundOutputDerivationRunner({
          derive: (input) => deriveUnboundRunOutput(input),
          sweep: () => sweepPendingUnboundDerivations(),
        });
        const {
          enqueueBackgroundJob,
          BACKGROUND_JOB_NAMES,
          UNBOUND_OUTPUT_DERIVE_SWEEP_LOOP_JOB_ID,
        } = await import("@/lib/background-jobs");
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.UNBOUND_OUTPUT_DERIVE_SWEEP,
          {},
          {
            jobId: UNBOUND_OUTPUT_DERIVE_SWEEP_LOOP_JOB_ID,
            delay: 5 * 60 * 1000, // 5m
            overwriteIfStale: true,
            skipWorker: true,
            inheritActorContext: false,
          },
        );
        console.log(
          "[unbound-output-derive-sweep] ~5-minute reconcile loop scheduled (5m delay)",
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

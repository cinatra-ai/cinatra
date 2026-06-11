import "server-only";

import type { ChildProcess } from "child_process";
import { Queue, Worker, DelayedError, type JobsOptions, type Job } from "bullmq";
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
// CRM integration surfaces resolve through the capability registry at job
// time (lazy/guarded host-access cutover) — never a named connector import.
import {
  ensureCrmSyncRegistrations,
  resolveCrmPointerWriter,
} from "@/lib/crm-integration-providers";

export const BACKGROUND_JOB_NAMES = {
  // Text jobs 1, 2, and 5 are retired:
  // - `BLOG_POST_IDEA_GENERATION`   → `blog-idea-generator-agent`
  //                                    (via `blog-pipeline-agent` `idea_flow`)
  // - `BLOG_POST_DRAFT_GENERATION`  → `blog-draft-writer-agent`
  //                                    (`draft_flow`)
  // - `BLOG_POST_LINKEDIN_DRAFT_CREATION` → `blog-linkedin-writer-agent`
  //                                    (`linkedin_flow`)
  // Image-byte job 3 (`BLOG_POST_IMAGE_REGENERATION`) remains on this queue.
  BLOG_POST_IMAGE_REGENERATION: "blog-post-image-regeneration",
  BLOG_POST_WORDPRESS_DRAFT_CREATION: "blog-post-wordpress-draft-creation",
  BLOG_POST_LINKEDIN_DRAFT_PUBLISH: "blog-post-linkedin-draft-publish",
  LITELLM_PRICING_SYNC: "litellm-pricing-sync",
  GRAPHITI_PROJECTION_REPAIR: "graphiti-projection-repair",
  // Durable repair for Twenty→cinatra pointer writes. When a
  // crm_account_*/crm_contact_*_{create,update} handler fails to materialise
  // the pointer row after Twenty has already accepted the write, the handler
  // enqueues this job so the projection chain (pointer row → outbox →
  // Graphiti episode) heals out of band rather than leaving the Twenty record
  // unreachable from cinatra. Idempotent on Twenty's external_id via the
  // pointer's identityKey; per-call attempts/backoff configured at enqueue.
  TWENTY_POINTER_REPAIR: "twenty-pointer-repair",
  AGENT_BUILDER_EXECUTION: "agent-builder-execution",
  SKILL_PREFILL_GENERATION: "skill-prefill-generation",
  AGENT_RUN_TRIGGER_RELEASE: "agent-run-trigger-release",
  // Public-registry polling driver. Registered here so the dispatcher,
  // worker handler, and enqueue sites can all import `BACKGROUND_JOB_NAMES`
  // without circular coupling.
  REGISTRY_POLL: "registry-poll",
  // LLM-based skill matching jobs reuse the shared background-jobs queue.
  // Inline kinds fan out per skill / per agent on install/upsert events; batch
  // kinds drive the OpenAI Batch API submit/poll loop. Worker concurrency is
  // shared; these jobs do not introduce a second worker.
  SKILL_MATCH_INLINE_FOR_SKILL: "skill-match-inline-for-skill",
  SKILL_MATCH_INLINE_FOR_AGENT: "skill-match-inline-for-agent",
  SKILL_MATCH_BATCH_SUBMIT: "skill-match-batch-submit",
  SKILL_MATCH_BATCH_POLL: "skill-match-batch-poll",
  // Production drift sampler for persisted skill-match rows.
  // Re-evaluates a small random sample of llm/ok skill_matches rows per run
  // and emits a structured `skill-match-drift` log event when the new
  // decision differs from the persisted decision OR the score shifts beyond
  // SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD. Disabled by default at the
  // schedule-row level; the boot hook is a no-op until an admin enables it.
  SKILL_MATCH_DRIFT_SAMPLE: "skill-match-drift-sample",
  // Production scheduler for the provider-file ref-cache eviction sweep.
  // Iterates (orgId, provider) pairs and drives `evictExpiredProviderFiles`
  // so the cache (`artifact_provider_cache`) does not accumulate expired rows
  // forever. Self-scheduling at 4h cadence, matching the
  // LITELLM_PRICING_SYNC / GRAPHITI_PROJECTION_REPAIR pattern. Enabled by
  // default with no admin toggle.
  //
  // NOTE: `runResourceBlobGc` is NOT yet scheduled here. Activating it would
  // materialize the known GC vs pin-INSERT race window because
  // pin/representation writers do not yet share the resource-level advisory
  // lock.
  ARTIFACT_PROVIDER_CACHE_EVICT: "artifact-provider-cache-evict",
  // Async LLM artifact matcher.
  // Enqueued POST-COMMIT from createSemanticArtifact for every
  // non-agent-produced artifact (agent-produced ones are already
  // typed deterministically at creation). NOT self-rescheduling — it is a
  // one-shot per-artifact classification.
  ARTIFACT_MATCH_RUN: "artifact-match-run",
  // Durable audit-log retention sweep. Deletes authz
  // audit events older than the configured window (default 12 months;
  // admin-configurable). Self-scheduling at 24h cadence, matching the
  // LITELLM_PRICING_SYNC pattern. Seeded once at boot in
  // instrumentation.node.ts (jobId "audit-retention-daily" dedups restarts).
  AUDIT_RETENTION_ENFORCE: "audit-retention-enforce",
  // Periodic Verdaccio → Cinatra Marketplace
  // catalog reconciliation. Pulls `/-/all` from the configured Verdaccio
  // registry, normalises each package's metadata + extracts the README
  // (via `getPackageReadme` from `@cinatra-ai/registries`, size-capped),
  // and POSTs `marketplace_package_sync_from_registry` per package to the
  // marketplace MCP endpoint. Idempotent — re-runs converge.
  MARKETPLACE_CATALOG_SYNC: "marketplace-catalog-sync",
  // Vendor-application lifecycle. Periodic recovery
  // sweep for namespace-reservation rows stuck in the `applied` state on the
  // cm side — broker (Verdaccio user) + WP cap-grant succeeded marketplace-
  // side but the final DB flip from `applied` → `approved` did not land.
  // Calls the `vendor_application_complete_recovery` ability (PRINCIPAL_SYNC_
  // WORKER-only) under the sync-worker bearer, idempotent, self-rescheduling
  // at 5-min cadence. See `@cinatra-ai/marketplace-application-reconcile`.
  VENDOR_APPLICATION_STATE_RECONCILE: "vendor-application-state-reconcile",
} as const;

export type BackgroundJobName = (typeof BACKGROUND_JOB_NAMES)[keyof typeof BACKGROUND_JOB_NAMES];

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

/**
 * Canonical jobId for the SINGLE graphiti-projection-repair loop. The boot seed
 * (instrumentation.node.ts) creates the job with this id; the handler re-delays
 * THIS job via moveToDelayed each cycle. Any job whose id differs is a legacy
 * anonymous duplicate and runs once WITHOUT rescheduling, so the loop can never
 * multiply across server restarts. Exported so the boot seed and the handler
 * guard share one source of truth (drift here would re-introduce the storm).
 */
export const GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID = "graphiti-projection-repair-loop";

/**
 * Canonical loop-job ids for the other boot-seeded self-rescheduling system
 * loops. Same contract as GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID: the boot seed
 * (instrumentation.node.ts) creates the job under this id and the handler
 * re-delays THIS job via moveToDelayed each cycle; any other id is a legacy
 * anonymous duplicate that runs once WITHOUT rescheduling. The literals MUST
 * match the boot-seed jobIds — drift re-introduces the per-restart queue storm.
 */
export const ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID =
  "artifact-provider-cache-evict-loop";
export const AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID = "audit-retention-daily";
export const LITELLM_PRICING_SYNC_LOOP_JOB_ID = "litellm-pricing-sync-weekly";
/**
 * Canonical loop-job id for the marketplace catalog sync's periodic full
 * sweep. Per-promotion single-package reconciles are queued with their own
 * per-package id (`marketplace-catalog-sync:<package>@<version>`) so they
 * don't collide with the recurring loop's stable id.
 */
export const MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID = "marketplace-catalog-sync-loop";
/**
 * Canonical loop-job id for the vendor-application state reconcile sweep.
 * Same contract as `MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID`: the boot seed
 * (instrumentation.node.ts) creates the job under this id and the handler
 * re-delays THIS job via moveToDelayed each cycle; any other id is a
 * legacy anonymous duplicate that runs once WITHOUT rescheduling. Drift
 * here re-introduces the per-restart queue storm guarded by the BullMQ-
 * loop-recurrence CI gate.
 */
export const VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID =
  "vendor-application-state-reconcile-loop";

async function dispatchBackgroundJob(job: Job, token?: string) {
  return runJobHandlerWithActorContext(job.data, () => dispatchBackgroundJobImpl(job, token));
}

/**
 * Test-only export of the inner dispatch body. Bypasses the ALS-frame
 * wrapper (`runJobHandlerWithActorContext`) so unit tests can drive a
 * single case from the switch without standing up the full BullMQ
 * runtime + an outer actor context. Production paths must continue to
 * call `dispatchBackgroundJob` (above), not this.
 */
export const __dispatchBackgroundJobForTests = dispatchBackgroundJobImpl;

/**
 * Host-side CatalogProvider for the four SKILL_MATCH_* BullMQ job handlers.
 *
 * This is the SOLE place where `@cinatra-ai/skills` and `@/lib/agents-store`
 * collaborate via lazy dependency injection. Lifting
 * `readAgentsCatalog` / `listInstalledSkills` / `getInstalledSkillById`
 * out of `packages/skills/src/llm-matching/jobs.ts` and into a host-app
 * provider breaks the Skills ⇄ Agents circular dependency that would tie
 * `@cinatra-ai/skills/llm-matching/jobs.ts` to `@/lib/agents-store` (which
 * itself imports `@cinatra-ai/skills` for matches/store reads).
 *
 * Everything is lazy-imported at provider-method invocation time so this
 * module-level helper does not eagerly pull `@cinatra-ai/skills` or
 * `@/lib/agents-store` at background-jobs.ts module-init.
 */
async function buildSkillMatchCatalogProvider(): Promise<
  import("@cinatra-ai/skills").CatalogProvider
> {
  return {
    async readAgents() {
      // Agents axis = installed runnable agents (readInstalledAgentTemplates),
      // not workspace packages. The matcher's batch / inline / per-pair paths
      // all flow through this seam, so this canonical reader covers every
      // write path at once.
      const { readAgentsForSkillMatching } = await import("@/lib/agents-store");
      return readAgentsForSkillMatching();
    },
    async listSkills() {
      const { listInstalledSkills } = await import("@cinatra-ai/skills");
      return listInstalledSkills();
    },
    async getSkillById(skillId: string) {
      const { getInstalledSkillById } = await import("@cinatra-ai/skills");
      return getInstalledSkillById(skillId);
    },
  };
}

async function dispatchBackgroundJobImpl(job: Job, token?: string) {
  globalThis.__cinatraBackgroundJobExecutionDepth = (globalThis.__cinatraBackgroundJobExecutionDepth ?? 0) + 1;
  const jobId = String(job.id ?? "");

  try {
    switch (job.name as BackgroundJobName) {
      // `BLOG_POST_IDEA_GENERATION` and `BLOG_POST_DRAFT_GENERATION` worker
      // cases are retired; replacements live in `blog-pipeline-agent`.
      case BACKGROUND_JOB_NAMES.BLOG_POST_IMAGE_REGENERATION: {
        const { runBlogPostImageRegenerationJob } = await import("@/lib/blog");
        await runBlogPostImageRegenerationJob(job.data as { projectId: string; postId: string; customPrompt?: string }, jobId);
        return;
      }
      case BACKGROUND_JOB_NAMES.BLOG_POST_WORDPRESS_DRAFT_CREATION: {
        const { runWordPressDraftCreationJob } = await import("@/lib/blog");
        await runWordPressDraftCreationJob(job.data as { projectId: string; postId: string; wordpressInstanceId: string }, jobId);
        return;
      }
      // `BLOG_POST_LINKEDIN_DRAFT_CREATION` worker case is retired; the
      // replacement is `blog-linkedin-writer-agent` `linkedin_flow`.
      case BACKGROUND_JOB_NAMES.BLOG_POST_LINKEDIN_DRAFT_PUBLISH: {
        const { runLinkedInDraftPublishJob } = await import("@/lib/blog");
        await runLinkedInDraftPublishJob(job.data as { projectId: string; postId: string; draftId: string }, jobId);
        return;
      }
      case BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC: {
        try {
          const { runLiteLlmPricingSyncJob } = await import("@cinatra-ai/metric-cost-api");
          const result = await runLiteLlmPricingSyncJob(job.data as Record<string, never>);
          console.log("[litellm-sync] BullMQ job complete:", result);
        } catch (err) {
          console.error("[litellm-sync] cycle failed:", err);
        }
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        // Legacy/anonymous duplicate (id !== canonical loop id): run once and do
        // NOT perpetuate. Drains any pre-fix duplicates down to a single loop
        // (matches GRAPHITI_PROJECTION_REPAIR).
        if (String(job.id ?? "") !== LITELLM_PRICING_SYNC_LOOP_JOB_ID) {
          return;
        }
        try {
          // Re-delay the active canonical job in place. moveToDelayed needs
          // job.token to release the active slot. The previous stable-jobId
          // self-reschedule via `queue.add` was vulnerable to BullMQ's HSETNX
          // silently dropping the delayed entry while the active hash existed;
          // the loop relied on server restarts to re-seed. moveToDelayed
          // sidesteps that entirely.
          await job.moveToDelayed(Date.now() + ONE_WEEK_MS, job.token);
        } catch (rescheduleErr) {
          console.warn("[litellm-sync] re-delay failed:", rescheduleErr);
          return;
        }
        // BullMQ v5 contract: after a successful moveToDelayed from an active
        // processor, throw DelayedError so the worker acknowledges the move and
        // does NOT also try to complete/fail the (now-delayed) job.
        throw new DelayedError();
      }
      case BACKGROUND_JOB_NAMES.AUDIT_RETENTION_ENFORCE: {
        // Delete authz audit events older than the configured retention
        // window, then self-reschedule for tomorrow.
        try {
          const { enforceAuditRetention } = await import("@/lib/authz/audit");
          const result = await enforceAuditRetention();
          console.log(
            `[audit-retention] swept: cutoff=${result.cutoffIso} retentionDays=${result.retentionDays} deleted=${result.deleted}`,
          );
        } catch (retentionErr) {
          console.warn("[audit-retention] sweep failed:", retentionErr);
        }
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        // Legacy/anonymous duplicate (id !== canonical loop id): run once and do
        // NOT perpetuate. This drains any pre-fix storm down to a single loop
        // (matches GRAPHITI_PROJECTION_REPAIR).
        if (String(job.id ?? "") !== AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID) {
          return;
        }
        try {
          // Re-delay the active canonical job in place via moveToDelayed (needs
          // job.token to release the active slot). This sidesteps the HSETNX
          // active-hash collision a fresh `queue.add` with a stable jobId would
          // hit, WITHOUT the anonymous successor that re-introduced the
          // per-restart queue storm (the previous no-jobId behavior here).
          await job.moveToDelayed(Date.now() + ONE_DAY_MS, job.token);
        } catch (rescheduleErr) {
          console.warn("[audit-retention] re-delay failed:", rescheduleErr);
          return;
        }
        // BullMQ v5 contract: after a successful moveToDelayed from an active
        // processor, throw DelayedError so the worker acknowledges the move and
        // does NOT also try to complete/fail the (now-delayed) job.
        throw new DelayedError();
      }
      case BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR: {
        // Outbox repair worker. Re-delays the SINGLE canonical loop job (id ===
        // GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID) via moveToDelayed each cycle —
        // it must NOT queue.add a fresh anonymous successor (the old behavior),
        // because the boot seed's stable-jobId dedup stops matching once the
        // loop goes anonymous, so every server restart seeded ANOTHER independent
        // loop -> ~450-job queue storm. Anonymous duplicates run once + die below.
        //
        // Ensure the CRM object-sync adapters are registered before the
        // outbox runs so the projector can route adapter-owned CRM types
        // (account/contact) to the Twenty→Graphiti adapter, which hydrates
        // via the crm_* facade before composing the episode. Resolved through
        // the `crm-sync-bootstrap` capability the crm-connector registers at
        // activation (idempotent connector-side; the MCP-server boot path
        // registers the same adapters via createCrmModule()) — the dispatcher
        // names no connector package (lazy/guarded host-access cutover). The
        // Twenty CRM provider needs no bootstrap call here: it registers
        // behind the `crm-provider` capability at its own activation and
        // resolves through the SDK registry's external resolver. With no
        // provider registered (crm-connector genuinely absent/inactive) this
        // is a no-op and adapter-owned rows FALL THROUGH to the projector's
        // GENERIC projection (terminal episodes without Twenty hydration —
        // the accepted degraded mode for an absent connector; rows that DID
        // route through a registered adapter keep the per-entry retry/failure
        // semantics). Never a worker crash either way.
        ensureCrmSyncRegistrations();
        const { processProjectionOutbox } = await import("@cinatra-ai/objects/graphiti-projector");
        try {
          const result = await processProjectionOutbox({ batchSize: 20, maxAttempts: 5 });
          if (result.processed > 0 || result.failed > 0) {
            console.log("[graphiti-projection-repair] processed:", result);
          }
        } catch (err) {
          console.error("[graphiti-projection-repair] cycle failed:", err);
        }
        const THIRTY_SECONDS_MS = 30_000;
        // Legacy/anonymous duplicate (id !== canonical loop id): run once and do
        // NOT perpetuate. This drains any pre-fix storm down to a single loop.
        if (String(job.id ?? "") !== GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID) {
          return;
        }
        try {
          // Re-delay the active canonical job in place. moveToDelayed needs
          // job.token to release the active slot (same pattern as the
          // trigger-gate re-queue path above).
          await job.moveToDelayed(Date.now() + THIRTY_SECONDS_MS, job.token);
        } catch (rescheduleErr) {
          console.warn("[graphiti-projection-repair] re-delay failed:", rescheduleErr);
          return;
        }
        // BullMQ v5 contract: after a successful moveToDelayed from an active
        // processor, throw DelayedError so the worker acknowledges the move and
        // does NOT also try to complete/fail the (now-delayed) job.
        throw new DelayedError();
      }
      case BACKGROUND_JOB_NAMES.TWENTY_POINTER_REPAIR: {
        // Durable-repair handler. One-shot per enqueue (NOT
        // self-rescheduling). BullMQ's `attempts`/`backoff` cover transient
        // retries — see the enqueue site in extensions/cinatra-ai/crm-connector/
        // src/mcp/module.ts. The write resolves through the
        // `crm-pointer-writer` capability the crm-connector registers at
        // activation (lazy/guarded host-access cutover) — the impl owns the
        // register-types-before-write ordering (the objects_save classifier
        // fast-path) and loads the heavy MCP module at write time, so the
        // dispatcher names no connector package and the host bundle stays off
        // crm-connector's synchronous graph at boot.
        //
        // Payload MUST carry orgId/userId because the worker process has
        // no `mcpRequestContextStorage` frame. Without them, the pointer
        // write would synthesise an actor with `orgId === null`, which
        // `objects_save` rejects on entry, causing every retry to fail
        // deterministically.
        const writer = resolveCrmPointerWriter();
        if (!writer) {
          // Degraded mode: connector absent/inactive. Complete the job (a
          // structurally-absent connector must not become a retry storm).
          console.warn(
            "[twenty-pointer-repair] no crm-pointer-writer capability registered " +
              "(crm-connector absent or not activated) — skipping pointer write.",
          );
          return;
        }
        const payload = job.data as {
          type: "account" | "contact";
          externalId: string;
          name: string;
          orgId: string | null;
          userId: string | null;
        };
        await writer.writePointer(payload);
        return;
      }
      case BACKGROUND_JOB_NAMES.REGISTRY_POLL: {
        // Public-registry polling driver. The handler owns its own
        // state-machine reschedule semantics (200-pending +
        // 429 + 5xx all self-reschedule via enqueueBackgroundJob). We do
        // NOT add a dispatcher-level try/catch here: a thrown error would
        // re-trigger BullMQ retry on top of our state-machine retry, which
        // would double-process the just-persisted lastPolledAt/nextPollAt.
        // The 200-pending branch INSIDE the handler wraps its reschedule
        // call in try/catch + redacted warn for the Redis-outage case.
        //
        // Payload optionally carries `scheduledFor` (set by self-reschedules
        // for the app-level stale-attempt guard). The initial enqueue from
        // `requestRemoteAccessAction` does not set it.
        const { runRegistryPollJob } = await import("@/lib/registry-poll-job");
        await runRegistryPollJob(job.data as { requestId: string; scheduledFor?: number });
        return;
      }
      case BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION: {
        // TriggerGateClosedError catch + re-queue.
        // The gate fires inside runAgentBuilderExecutionJob immediately before
        // the WayFlow A2A dispatch (transitionRunStatus queued→running). When
        // closed, the function throws TriggerGateClosedError without changing
        // the DB status. Here we catch the sentinel, increment the gateAttempt
        // counter, and move the job to delayed via job.moveToDelayed (BullMQ
        // flow control — does NOT consume a retry attempt). The Redis worker
        // concurrency slot is released between gate-checks.
        const { runAgentBuilderExecutionJob, TriggerGateClosedError } =
          await import("@cinatra-ai/agents");
        try {
          await runAgentBuilderExecutionJob(
            job.data as { runId: string; gateAttempt?: number },
            jobId,
          );
        } catch (err) {
          if (err instanceof TriggerGateClosedError) {
            console.log(
              `[trigger-gate] run ${err.runId} gated — re-queuing in ${err.delayMs}ms (attempt ${err.nextAttempt})`,
            );
            await job.updateData({
              ...(job.data as Record<string, unknown>),
              gateAttempt: err.nextAttempt,
            });
            // moveToDelayed requires the job.token (BullMQ active-slot release).
            await job.moveToDelayed(Date.now() + err.delayMs, job.token);
            // BullMQ v5 contract: throw DelayedError after moveToDelayed so the
            // worker acknowledges the move (no retry consumed) instead of trying
            // to complete the now-delayed job (which logs a "missing lock" error).
            throw new DelayedError();
          }
          throw err;
        }
        return;
      }
      // Trigger release job: opens the gate (Redis flag + DB releasedAt),
      // transitions armed -> queued, and enqueues AGENT_BUILDER_EXECUTION.
      // Recurring triggers create a fresh pending run + arm immediate.
      case BACKGROUND_JOB_NAMES.AGENT_RUN_TRIGGER_RELEASE: {
        const { runAgentRunTriggerReleaseJob } = await import("@cinatra-ai/agents");
        await runAgentRunTriggerReleaseJob(job.data as { runId: string }, jobId);
        return;
      }
      case BACKGROUND_JOB_NAMES.SKILL_PREFILL_GENERATION: {
        const { runSkillPrefillGenerationJob } = await import("@cinatra-ai/skills");
        await runSkillPrefillGenerationJob(job.data as { skillIds: string[] }, jobId);
        return;
      }
      case BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_SKILL: {
        // Inline-for-skill fan-out (one skill x all matchable agents).
        // Lazy-imported to avoid module-load cycles between background-jobs.ts and @cinatra-ai/skills.
        // Catalog provider injected via the CatalogProvider seam; the handler
        // no longer reaches into the host app's stores directly.
        const { handleInlineForSkill } = await import("@cinatra-ai/skills");
        const catalog = await buildSkillMatchCatalogProvider();
        await handleInlineForSkill(
          job.data as { skillId: string; jobStartedAt: string },
          { catalog },
        );
        return;
      }
      case BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_AGENT: {
        // Inline-for-agent fan-out (one agent x all matchable skills).
        const { handleInlineForAgent } = await import("@cinatra-ai/skills");
        const catalog = await buildSkillMatchCatalogProvider();
        await handleInlineForAgent(
          job.data as { agentId: string; jobStartedAt: string },
          { catalog },
        );
        return;
      }
      case BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_SUBMIT: {
        // Submit a single OpenAI batch covering all current pairs.
        const { handleBatchSubmit } = await import("@cinatra-ai/skills");
        const catalog = await buildSkillMatchCatalogProvider();
        await handleBatchSubmit(job.data as { submittedBy: string }, { catalog });
        return;
      }
      case BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL: {
        // Poll an in-flight batch; self-reschedule until terminal
        // status; on completion, download results and upsert via the shared evaluator core.
        const { handleBatchPoll } = await import("@cinatra-ai/skills");
        const catalog = await buildSkillMatchCatalogProvider();
        await handleBatchPoll(
          job.data as { batchId: string; jobStartedAt: string },
          { catalog },
        );
        return;
      }
      case BACKGROUND_JOB_NAMES.SKILL_MATCH_DRIFT_SAMPLE: {
        // Production drift sampler.
        // Re-evaluates SKILL_MATCH_DRIFT_SAMPLE_SIZE random llm/ok rows and
        // emits structured `skill-match-drift` log events when the decision
        // flipped or the score moved beyond
        // SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD. The handler is invoked
        // via the same CatalogProvider seam as the inline + batch transports
        // so this dispatcher case has no new structural coupling to
        // host-side stores.
        const { handleDriftSample } = await import("@cinatra-ai/skills");
        const catalog = await buildSkillMatchCatalogProvider();
        await handleDriftSample({ catalog });
        return;
      }
      case BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT: {
        // Sweep expired rows from the provider-file ref cache.
        // `evictExpiredProviderFiles` is
        // tenant+provider-scoped by design; we enumerate (orgId,
        // provider) pairs via `listOrgProvidersWithExpiredCache` and
        // call it per pair. `deleteRemote` routes through the
        // orchestration-layer `deleteFile` so each provider's
        // own SDK handles the remote delete (no per-provider switch
        // here). Self-reschedules with a 4h delay.
        try {
          const { listOrgProvidersWithExpiredCache, evictExpiredProviderFiles } =
            await import("@/lib/artifacts/provider-file-cache");
          const { deleteFile } = await import("@cinatra-ai/llm");
          const pairs = listOrgProvidersWithExpiredCache();
          // Provider values come from the DB column (plain `text`); narrow
          // to the known `LlmProvider` literal union before handing them
          // to the orchestration layer's typed deleteFile. An unknown
          // provider is benign — just no remote delete; the DB row is
          // still reaped on the next sweep (note: `evictExpiredProviderFiles`
          // deletes the row AFTER awaiting `deleteRemote`, so a no-op
          // adapter is the right fallback).
          const KNOWN_PROVIDERS = new Set(["openai", "anthropic", "gemini"]);
          let totalReaped = 0;
          let totalRemoteDeleteFailures = 0;
          for (const { orgId, provider } of pairs) {
            try {
              const isKnown = KNOWN_PROVIDERS.has(provider);
              const r = await evictExpiredProviderFiles({
                orgId,
                provider,
                deleteRemote: async (providerFileId) => {
                  if (!isKnown) return;
                  await deleteFile({
                    id: providerFileId,
                    provider: provider as "openai" | "anthropic" | "gemini",
                  });
                },
                limit: 100,
              });
              totalReaped += r.reaped;
              totalRemoteDeleteFailures += r.remoteDeleteFailures;
            } catch (perPairErr) {
              // Single tenant/provider failure must not block the rest
              // of the sweep — log + continue.
              console.error(
                `[artifact-provider-cache-evict] pair ${orgId}/${provider} failed:`,
                perPairErr,
              );
            }
          }
          if (totalReaped > 0) {
            console.log(
              `[artifact-provider-cache-evict] reaped ${totalReaped} expired rows across ${pairs.length} (org, provider) pair(s)`,
            );
          }
          // Surface a systemic remote-delete failure. If every reaped row's
          // deleteRemote threw, the DB rows are still gone but the remote
          // provider files leak. A WARN (not an error throw) keeps the loop
          // running while making the situation visible to operators.
          //
          // KNOWN LIMITATION: the production provider adapters currently
          // SWALLOW delete errors inside their own `.catch(() => {})` (see
          // openai.ts:deleteFile, anthropic.ts:deleteFile,
          // gemini.ts:deleteFile). So a broken provider SDK / expired
          // credentials path NEVER throws up to the loop here —
          // `totalRemoteDeleteFailures` stays at zero and this warn never
          // fires. The instrumentation is ready for a strict-delete refactor
          // that lets the adapters propagate real errors (only swallowing
          // 404 / already-deleted). Until then, this WARN is a forward-looking
          // safety net rather than an active observability signal.
          if (totalRemoteDeleteFailures > 0) {
            console.warn(
              `[artifact-provider-cache-evict] ${totalRemoteDeleteFailures} of ${totalReaped} remote deletes FAILED — provider SDK or credentials may be misconfigured; DB rows were still removed`,
            );
          }
        } catch (err) {
          console.error("[artifact-provider-cache-evict] cycle failed:", err);
        }
        const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
        // Legacy/anonymous duplicate (id !== canonical loop id): run once and do
        // NOT perpetuate. This drains any pre-fix storm down to a single loop
        // (matches GRAPHITI_PROJECTION_REPAIR).
        if (
          String(job.id ?? "") !== ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID
        ) {
          return;
        }
        try {
          // Re-delay the active canonical job in place. moveToDelayed needs
          // job.token to release the active slot. A fresh anonymous successor
          // here (the old behavior) re-introduced the per-restart queue storm.
          await job.moveToDelayed(Date.now() + FOUR_HOURS_MS, job.token);
        } catch (rescheduleErr) {
          console.warn(
            "[artifact-provider-cache-evict] re-delay failed:",
            rescheduleErr,
          );
          return;
        }
        // BullMQ v5 contract: after a successful moveToDelayed from an active
        // processor, throw DelayedError so the worker acknowledges the move and
        // does NOT also try to complete/fail the (now-delayed) job.
        throw new DelayedError();
      }
      case BACKGROUND_JOB_NAMES.ARTIFACT_MATCH_RUN: {
        // Async LLM artifact matcher.
        // One-shot per artifact (NOT self-rescheduling). The worker
        // is fully best-effort: every failure path inside
        // `runArtifactMatch` leaves the artifact at its default-floor
        // type (no throw past the boundary). attempts/backoff on the
        // enqueue cover transient LLM failures.
        const p = job.data as {
          orgId?: string;
          artifactId?: string;
          representationRevisionId?: string;
          createdByRunId?: string | null;
        };
        if (!p.orgId || !p.artifactId || !p.representationRevisionId) {
          console.warn(
            "[artifact-matcher] malformed ARTIFACT_MATCH_RUN payload — skipping:",
            p,
          );
          return;
        }
        const { runArtifactMatch, buildArtifactMatcherActorContext } =
          await import("@/lib/artifacts/matcher-runtime");
        await runArtifactMatch(
          {
            orgId: p.orgId,
            artifactId: p.artifactId,
            representationRevisionId: p.representationRevisionId,
            createdByRunId: p.createdByRunId ?? null,
          },
          {
            actorContext: buildArtifactMatcherActorContext({
              orgId: p.orgId,
            }),
          },
        );
        return;
      }
      case BACKGROUND_JOB_NAMES.MARKETPLACE_CATALOG_SYNC: {
        // Reconciles the Verdaccio registry → marketplace catalog. Two
        // modes determined by the job payload shape:
        //   - Full sweep (no `packageName`): walks every package the
        //     registry exposes and syncs each one's metadata + README
        //     into the marketplace catalog. Logs per-package failures
        //     but does NOT throw on individual rejections — the next
        //     periodic sweep retries naturally. Self-reschedules at 1h.
        //     Top-level errors (Verdaccio unavailable, marketplace token
        //     missing) are caught and logged so the canonical loop ALWAYS
        //     re-delays (matching audit-retention-enforce + the BullMQ
        //     perpetual-loop doctrine).
        //   - Single-package (`{ packageName, packageVersion }`): fast
        //     freshness path enqueued from the admin Approve action.
        //     Throws on failure so BullMQ's retry/backoff kicks in.
        const ONE_HOUR_MS = 60 * 60 * 1000;
        const payload = (job.data ?? {}) as {
          packageName?: string;
          packageVersion?: string;
        };
        const singlePackageMode = typeof payload.packageName === "string" && payload.packageName !== "";

        // Single-package mode: run the work, throw on any failure so
        // BullMQ retries the one-shot via attempts/backoff. Does NOT
        // wrap in try/catch.
        if (singlePackageMode) {
          const { buildMarketplaceSyncDeps } = await import("@/lib/marketplace-sync-deps");
          const deps = await buildMarketplaceSyncDeps({
            packageName: payload.packageName,
            packageVersion: payload.packageVersion,
          });
          if (deps === null) {
            throw new Error(
              "MARKETPLACE_CATALOG_SYNC: marketplace credential unavailable; single-package reconcile cannot run.",
            );
          }
          const { runMarketplaceSync } = await import("@cinatra-ai/marketplace-sync");
          const summary = await runMarketplaceSync(deps);
          console.log(
            `[marketplace-catalog-sync] mode=single synced=${summary.syncedCount} scope-rejected=${summary.scopeRejectedCount} fetch-failed=${summary.fetchFailedCount} map-failed=${summary.mapFailedCount} sync-failed=${summary.syncFailedCount} total=${summary.totalPackages}`,
          );
          if (summary.fetchFailedCount > 0 || summary.mapFailedCount > 0 || summary.syncFailedCount > 0) {
            const reasons = summary.perPackage
              .filter((p) => p.status === "fetch-failed" || p.status === "map-failed" || p.status === "sync-failed")
              .map((p) => `${p.packageName}: ${p.rejectionReason ?? "unknown"}`)
              .join("; ");
            throw new Error(
              `MARKETPLACE_CATALOG_SYNC single-package reconcile failed: ${reasons || "no detail"}`,
            );
          }
          // scope-rejected is a terminal policy decision (not retried).
          return;
        }

        // Full-sweep mode: run the work inside a try/catch so transient
        // failures (Verdaccio unreachable, marketplace 500s) log + the
        // canonical loop still re-delays for the next tick. Without this
        // wrap, an early throw bypasses moveToDelayed and the loop dies.
        try {
          const { buildMarketplaceSyncDeps } = await import("@/lib/marketplace-sync-deps");
          const deps = await buildMarketplaceSyncDeps({});
          if (deps === null) {
            console.warn(
              "[marketplace-catalog-sync] full sweep skipped: marketplace credential unavailable.",
            );
          } else {
            const { runMarketplaceSync } = await import("@cinatra-ai/marketplace-sync");
            const summary = await runMarketplaceSync(deps);
            console.log(
              `[marketplace-catalog-sync] mode=full synced=${summary.syncedCount} scope-rejected=${summary.scopeRejectedCount} fetch-failed=${summary.fetchFailedCount} map-failed=${summary.mapFailedCount} sync-failed=${summary.syncFailedCount} total=${summary.totalPackages}`,
            );
          }
        } catch (sweepErr) {
          console.warn(
            "[marketplace-catalog-sync] full sweep failed:",
            sweepErr instanceof Error ? sweepErr.message : sweepErr,
          );
        }

        // Re-delay the canonical loop job. Legacy / anonymous duplicates
        // (id !== loop id) run-once-and-die.
        if (String(job.id ?? "") !== MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID) {
          return;
        }
        try {
          await job.moveToDelayed(Date.now() + ONE_HOUR_MS, job.token);
        } catch (rescheduleErr) {
          console.warn("[marketplace-catalog-sync] re-delay failed:", rescheduleErr);
          return;
        }
        throw new DelayedError();
      }
      case BACKGROUND_JOB_NAMES.VENDOR_APPLICATION_STATE_RECONCILE: {
        // 5-minute sweep that drives `vendor_application_complete_recovery`
        // for namespace-reservation rows stuck in the `applied` state
        // (broker + cap-grant succeeded marketplace-side but the DB flip
        // did not land). Per-application failures are logged + counted but
        // do not throw — one bad row must not stop the rest, and the
        // canonical loop must always re-delay so the perpetual-loop
        // doctrine is preserved (matches the marketplace-catalog-sync
        // full-sweep mode catch above).
        const FIVE_MINUTES_MS = 5 * 60 * 1000;
        try {
          const { buildVendorApplicationReconcileDeps } = await import(
            "@/lib/marketplace-application-reconcile-deps"
          );
          const deps = await buildVendorApplicationReconcileDeps();
          if (deps === null) {
            console.warn(
              "[vendor-application-state-reconcile] sweep skipped: marketplace sync-worker bearer unavailable.",
            );
          } else {
            const { runVendorApplicationStateReconcile } = await import(
              "@cinatra-ai/marketplace-application-reconcile"
            );
            const summary = await runVendorApplicationStateReconcile(deps);
            if (summary.attempted > 0 || summary.recovered > 0 || summary.failed > 0) {
              console.log(
                `[vendor-application-state-reconcile] attempted=${summary.attempted} recovered=${summary.recovered} failed=${summary.failed}`,
              );
            }
          }
        } catch (sweepErr) {
          console.warn(
            "[vendor-application-state-reconcile] sweep failed:",
            sweepErr instanceof Error ? sweepErr.message : sweepErr,
          );
        }

        // Re-delay the canonical loop job. Legacy / anonymous duplicates
        // (id !== loop id) run-once-and-die (mirrors marketplace-catalog-
        // sync's reschedule guard).
        if (String(job.id ?? "") !== VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID) {
          return;
        }
        try {
          await job.moveToDelayed(Date.now() + FIVE_MINUTES_MS, job.token);
        } catch (rescheduleErr) {
          console.warn(
            "[vendor-application-state-reconcile] re-delay failed:",
            rescheduleErr,
          );
          return;
        }
        throw new DelayedError();
      }
      default:
        throw new Error(`Unsupported background job "${job.name}".`);
    }
  } finally {
    globalThis.__cinatraBackgroundJobExecutionDepth = Math.max(
      0,
      (globalThis.__cinatraBackgroundJobExecutionDepth ?? 1) - 1,
    );
  }
}

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

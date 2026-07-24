import "server-only";

import { DelayedError, type Job } from "bullmq";
import { z } from "zod";
// CRM integration surfaces resolve through the capability registry at job
// time (lazy/guarded host-access cutover) — never a named connector import.
import {
  ensureCrmSyncRegistrations,
  resolveCrmPointerWriter,
} from "@/lib/crm-integration-providers";
import {
  BACKGROUND_JOB_NAMES,
  type BackgroundJobName,
  GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
  ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
  AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
  LITELLM_PRICING_SYNC_LOOP_JOB_ID,
  MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
  VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
  PM_SCHEDULE_RECONCILE_LOOP_JOB_ID,
  EXTENSION_STORE_GC_REAP_LOOP_JOB_ID,
  EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
  ENVIRONMENT_LAYER_GC_REAP_LOOP_JOB_ID,
  UNBOUND_OUTPUT_DERIVE_SWEEP_LOOP_JOB_ID,
  ARTIFACT_REVIEW_RESUME_DELIVERY_LOOP_JOB_ID,
} from "@/lib/background-jobs-names";
// TYPE-ONLY (erased at compile; not a route-graph edge) — the reaper VALUE is
// boot-registered through the slot below, never imported here.
import type { ExtensionStoreReapReport } from "@/lib/extension-store-reaper";
// TYPE-ONLY (erased at compile; not a route-graph edge) — the auto-update
// cycle VALUE is boot-registered through its slot below, never imported here.
import type { ExtensionAutoUpdateRunSummary } from "@/lib/extension-auto-update";
// TYPE-ONLY (erased at compile; not a route-graph edge) — the unbound-output
// derivation VALUE is boot-registered through its slot below, never imported
// here (see the slot block for the route-graph-ratchet rationale).
import type { UnboundDerivationSweepSummary } from "@/lib/artifacts/unbound-output-derivation";
// TYPE-ONLY (erased at compile; not a route-graph edge) — the artifact-review
// resume-delivery VALUE is boot-registered through its slot below, never imported
// here (the drain reaches the agents A2A/execution graph; keeping it out of this
// registry's static + dynamic import surface preserves the route-graph ratchet).
import type { ResumeSweepSummary } from "@cinatra-ai/agents/artifact-review-resume-delivery";

// ---------------------------------------------------------------------------
// Extension-store GC reaper slot (cinatra#796).
//
// The reaper implementation is BOOT-REGISTERED (the system-loops seed phase
// dynamic-imports `@/lib/extension-store-reaper` and registers the runner)
// instead of being imported here: this registry sits in the reachable
// first-party graph of the LOCKED dev-perf routes (route-graph ratchet), and
// even a dynamic `import("@/lib/extension-store-reaper")` specifier would pull
// the reaper + lease/GC modules into every enqueuer's request-path graph.
// Maintenance-only code stays out of the locked graphs; the handler below
// no-ops LOUDLY (and re-delays) when the slot is empty — GC is maintenance,
// a skipped cycle is safe, and the boot seed always registers before it seeds
// the loop job. globalThis-backed so a worker dispatching from a different
// bundle's module instance still sees the boot registration.
// ---------------------------------------------------------------------------

type ExtensionStoreReaperRunner = () => Promise<ExtensionStoreReapReport>;

declare global {
  // eslint-disable-next-line no-var
  var __cinatraExtensionStoreReaperRunner: ExtensionStoreReaperRunner | undefined;
}

/** Boot-time registration (system-loops phase). Idempotent (last write wins). */
export function registerExtensionStoreReaper(runner: ExtensionStoreReaperRunner): void {
  globalThis.__cinatraExtensionStoreReaperRunner = runner;
}

function resolveExtensionStoreReaper(): ExtensionStoreReaperRunner | null {
  return globalThis.__cinatraExtensionStoreReaperRunner ?? null;
}

// ---------------------------------------------------------------------------
// Extension auto-update runner slot (cinatra#1042).
//
// Same posture as the GC-reaper slot above: the cycle implementation
// (`@/lib/extension-auto-update`, which reaches the planner/batch + dispatcher
// graph) is BOOT-REGISTERED by the system-loops seed phase — never imported
// here, even dynamically, so the locked routes' reachable graph stays free of
// the update machinery (route-graph ratchet). The handler below no-ops LOUDLY
// (and re-delays) when the slot is empty: auto-update is maintenance, a
// skipped cycle is safe, and the boot seed registers before it seeds the loop
// job. The slot stays empty on every boot where the master flag
// (CINATRA_EXTENSION_AUTO_UPDATE, default OFF) is disabled.
// ---------------------------------------------------------------------------

type ExtensionAutoUpdateRunner = () => Promise<ExtensionAutoUpdateRunSummary>;

declare global {
  var __cinatraExtensionAutoUpdateRunner: ExtensionAutoUpdateRunner | undefined;
}

/** Boot-time registration (system-loops phase). Idempotent (last write wins). */
export function registerExtensionAutoUpdateRunner(runner: ExtensionAutoUpdateRunner): void {
  globalThis.__cinatraExtensionAutoUpdateRunner = runner;
}

function resolveExtensionAutoUpdateRunner(): ExtensionAutoUpdateRunner | null {
  return globalThis.__cinatraExtensionAutoUpdateRunner ?? null;
}

// ---------------------------------------------------------------------------
// Unbound-output derivation runner slot (cinatra#1893, epic #1883 A5).
//
// Same posture as the GC-reaper / auto-update slots above: the derivation core
// (`@/lib/artifacts/unbound-output-derivation`, which reaches the run-artifact
// materializer / artifact-authoring / pooled-db graph) is BOOT-REGISTERED by
// the system-loops seed phase — never imported here, even dynamically, because
// this registry sits in the reachable first-party graph of the LOCKED dev-perf
// routes (route-graph ratchet) and even a dynamic
// `import("@/lib/artifacts/unbound-output-derivation")` specifier would pull the
// derivation + materializer + db modules into every enqueuer's request-path
// graph. BOTH the one-shot UNBOUND_OUTPUT_DERIVE handler and the recurring
// UNBOUND_OUTPUT_DERIVE_SWEEP handler resolve through this single slot; each
// no-ops LOUDLY when the slot is empty — a missed one-shot derive is recovered
// by the reconciliation sweep, and a skipped sweep cycle is safe — and the boot
// seed always registers the runner BEFORE it seeds the sweep loop job.
// globalThis-backed so a worker dispatching from a different bundle's module
// instance still sees the boot registration.
// ---------------------------------------------------------------------------

type UnboundOutputDerivationRunner = {
  derive: (input: { runId: string; orgId: string }) => Promise<unknown>;
  sweep: () => Promise<UnboundDerivationSweepSummary>;
};

declare global {
  // eslint-disable-next-line no-var
  var __cinatraUnboundOutputDerivationRunner: UnboundOutputDerivationRunner | undefined;
}

/** Boot-time registration (system-loops phase). Idempotent (last write wins). */
export function registerUnboundOutputDerivationRunner(
  runner: UnboundOutputDerivationRunner,
): void {
  globalThis.__cinatraUnboundOutputDerivationRunner = runner;
}

function resolveUnboundOutputDerivationRunner(): UnboundOutputDerivationRunner | null {
  return globalThis.__cinatraUnboundOutputDerivationRunner ?? null;
}

// ---------------------------------------------------------------------------
// Artifact-review resume-delivery runner slot (cinatra#1796, epic #1620 S13).
//
// Same posture as the slots above: the drain implementation
// (`@cinatra-ai/agents/artifact-review-resume-delivery`, which reaches the agents
// A2A/execution/store graph) is BOOT-REGISTERED by the system-loops seed phase —
// never imported here, even dynamically, because this registry sits in the
// reachable first-party graph of the LOCKED dev-perf routes (route-graph ratchet)
// and even a dynamic import specifier would pull the A2A/execution modules into
// every enqueuer's request-path graph. The recurring handler resolves through
// this single slot; it no-ops LOUDLY (and re-delays) when the slot is empty — a
// skipped drain cycle is safe (the outbox intent is durable and the next cycle
// re-claims it), and the boot seed always registers the runner BEFORE it seeds
// the loop job. globalThis-backed so a worker dispatching from a different
// bundle's module instance still sees the boot registration.
// ---------------------------------------------------------------------------

type ArtifactReviewResumeDeliveryRunner = {
  sweep: () => Promise<ResumeSweepSummary>;
};

declare global {
  // eslint-disable-next-line no-var
  var __cinatraArtifactReviewResumeDeliveryRunner:
    | ArtifactReviewResumeDeliveryRunner
    | undefined;
}

/** Boot-time registration (system-loops phase). Idempotent (last write wins). */
export function registerArtifactReviewResumeDeliveryRunner(
  runner: ArtifactReviewResumeDeliveryRunner,
): void {
  globalThis.__cinatraArtifactReviewResumeDeliveryRunner = runner;
}

function resolveArtifactReviewResumeDeliveryRunner(): ArtifactReviewResumeDeliveryRunner | null {
  return globalThis.__cinatraArtifactReviewResumeDeliveryRunner ?? null;
}

// ---------------------------------------------------------------------------
// Background-job handler registry (cinatra#304).
//
// One name-keyed registry replaces the monolithic `switch(job.name)` that
// previously lived inline in `background-jobs.ts`. Each entry declares:
//   - `payloadSchema`: a zod schema validated against `job.data` at DISPATCH
//     time (fail-fast with a clear error on a malformed payload). Every schema
//     is `.passthrough()` so the platform-managed `__actorContext` key and any
//     pre-existing loose fields survive untouched — this is a pure additive
//     validation boundary, NOT a behavior change to the payloads themselves.
//   - `handle(job, jobId)`: the SAME handler body that previously lived in the
//     switch case, moved verbatim (same lazy imports, same try/catch shape,
//     same logging, same recurring-loop semantics).
//
// Recurring (self-rescheduling) handlers route their run -> id-guard ->
// moveToDelayed -> throw DelayedError sequence through the single shared
// `runRecurringLoop` helper (replacing 7 hand-rolled copies). One-shot
// handlers do not.
//
// `background-jobs.ts` stays the thin runtime/registry module: it owns the
// queue/worker lifecycle, the public `enqueueBackgroundJob` API, cancellation,
// and the dispatcher that validates the payload then calls the registered
// handler. Unknown job names throw the same `Unsupported background job
// "<name>"` error the switch's `default` arm produced.
// ---------------------------------------------------------------------------

/**
 * A registered background-job handler: a dispatch-time payload schema plus the
 * handler body. The dispatcher validates `job.data` with `payloadSchema`
 * before invoking `handle`.
 */
export type JobHandler = {
  /**
   * Zod schema validated against `job.data` at dispatch time. MUST be a
   * `.passthrough()` object schema so platform-managed keys (`__actorContext`)
   * and any extra fields a handler reads via a loose cast are preserved. A
   * failure here is surfaced as a clear `Invalid payload for background job
   * "<name>"` error so a malformed payload fails fast instead of crashing
   * deep inside the handler.
   */
  payloadSchema: z.ZodTypeAny;
  /**
   * Handler body. Receives the BullMQ `Job` and the normalised string jobId
   * (`String(job.id ?? "")`) — identical inputs to the old switch arms.
   */
  handle: (job: Job, jobId: string) => Promise<void>;
};

/**
 * Shared recurring-loop helper (cinatra#304; error policy hardened cinatra#849).
 *
 * Replaces the 7 hand-rolled copies of the self-rescheduling loop pattern AND
 * owns the loop's ERROR POLICY centrally:
 *   1. run the work (`run()`) inside a try/catch — this happens for EVERY
 *      invocation, including a legacy/anonymous duplicate (one unit of work,
 *      then it dies without rescheduling). A throw from `run()` — a pre-work
 *      dynamic-import/registration failure, or any cycle error the handler did
 *      not swallow — is REPORTED to the error reporter (Sentry) and then
 *      SWALLOWED so control falls through to the re-delay below. Before
 *      cinatra#849 `run()` was awaited with NO wrapping try/catch, so a throw
 *      skipped `moveToDelayed`, the job was marked failed, and with the default
 *      `attempts: 1` it was NOT retried — the loop silently died until the next
 *      boot re-seeded it. The re-delay-in-all-cases guarantee now lives HERE, so
 *      individual recurring handlers no longer wrap their whole cycle.
 *   2. id-guard: if `job.id` is NOT the canonical loop id, RETURN without
 *      rescheduling (drains pre-fix anonymous duplicates down to one loop);
 *   3. re-delay the active canonical job in place via `moveToDelayed` (needs
 *      `job.token` to release the active slot). On a re-delay FAILURE, log a
 *      WARN and RETURN (do not throw) so a transient Redis blip doesn't fail
 *      the job — the boot seed re-establishes the loop on restart;
 *   4. on a successful move, throw `DelayedError` so the BullMQ v5 worker
 *      acknowledges the move and does not also try to complete/fail the
 *      now-delayed job.
 *
 * Reporting is fire-and-forget via a dynamic import of
 * `@cinatra-ai/errors/server` (mirrors the worker.on("failed") hook and keeps
 * the errors package off this module's synchronous boot graph). It is naturally
 * rate-limited by the loop's own re-delay cadence (30s–1w): worker.on("failed")
 * never fires for a re-delaying loop, so this is the ONLY path that surfaces a
 * failing cycle to Sentry.
 */
export async function runRecurringLoop(args: {
  job: Job;
  /** Canonical loop jobId. Any other id runs once and does NOT reschedule. */
  loopJobId: string;
  /** Delay until the next cycle, in milliseconds. */
  delayMs: number;
  /** Human label for the cycle-failed / re-delay-failed log lines. */
  label: string;
  /** The work to run this cycle. May throw — the helper reports + re-delays. */
  run: () => Promise<void>;
}): Promise<void> {
  const { job, loopJobId, delayMs, label, run } = args;
  try {
    await run();
  } catch (cycleErr) {
    // A throw from run() must NOT kill the loop: report it, then fall through
    // to the re-delay below so the next cycle still runs (cinatra#849). This is
    // the single choke point that surfaces recurring-loop cycle failures to the
    // error reporter — worker.on("failed") never fires for them because the job
    // re-delays instead of failing.
    console.error(`[${label}] cycle failed:`, cycleErr);
    void import("@cinatra-ai/errors/server")
      .then(({ captureBackgroundJobError }) =>
        captureBackgroundJobError(cycleErr, {
          jobName: job.name,
          jobId: job.id,
          queueName: job.queueName,
        }),
      )
      .catch(() => {
        // Error reporter unavailable — never let it break the loop.
      });
  }
  // Legacy/anonymous duplicate (id !== canonical loop id): run once and do NOT
  // perpetuate. Drains any pre-fix duplicates down to a single loop.
  if (String(job.id ?? "") !== loopJobId) {
    return;
  }
  try {
    // Re-delay the active canonical job in place. moveToDelayed needs
    // job.token to release the active slot.
    await job.moveToDelayed(Date.now() + delayMs, job.token);
  } catch (rescheduleErr) {
    console.warn(`[${label}] re-delay failed:`, rescheduleErr);
    return;
  }
  // BullMQ v5 contract: after a successful moveToDelayed from an active
  // processor, throw DelayedError so the worker acknowledges the move and does
  // NOT also try to complete/fail the (now-delayed) job.
  throw new DelayedError();
}

/**
 * Host-side CatalogProvider for the four SKILL_MATCH_* BullMQ job handlers.
 *
 * This is the SOLE place where `@cinatra-ai/skills` and `@/lib/agents-store`
 * collaborate via lazy dependency injection. Lifting the agents-catalog /
 * `listInstalledSkills` / `getInstalledSkillById` reads
 * out of `packages/skills/src/llm-matching/jobs.ts` and into a host-app
 * provider breaks the Skills ⇄ Agents circular dependency that would tie
 * `@cinatra-ai/skills/llm-matching/jobs.ts` to `@/lib/agents-store` (which
 * itself imports `@cinatra-ai/skills` for matches/store reads).
 *
 * Everything is lazy-imported at provider-method invocation time so this
 * module-level helper does not eagerly pull `@cinatra-ai/skills` or
 * `@/lib/agents-store` at module-init.
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

/**
 * A3 (cinatra#1363): a lifecycle-gated wrapper of `buildSkillMatchCatalogProvider`
 * for the candidate-CREATION handlers ONLY (inline-for-skill, inline-for-agent,
 * batch-submit). It EXCLUDES non-runtime-deliverable (archived/draft/unknown)
 * skills so the matcher never evaluates them — no wasted LLM cost and no new
 * match rows for a retired skill. FAIL-CLOSED: a lifecycle-read error yields an
 * EMPTY candidate set (`listSkills`) / a null single-skill lookup (`getSkillById`)
 * — a safe no-op matching run retried on the next trigger, never an archived
 * skill entering the match store.
 *
 * The maintenance + drift + batch-poll handlers deliberately keep the UNFILTERED
 * provider: maintenance orphan-GC keys liveness off `listSkills()` (a filtered
 * list would tombstone archived skills' match rows — and on a read error, EVERY
 * row), drift observes existing rows, and batch-poll persists an
 * already-submitted, already-gated batch. Two providers = the safety boundary.
 *
 * Lazy-imports inside each method mirror the base provider so this module never
 * eagerly pulls `@cinatra-ai/skills` / `@/lib/database` at init.
 */
async function buildDeliverableSkillMatchCatalogProvider(): Promise<
  import("@cinatra-ai/skills").CatalogProvider
> {
  const base = await buildSkillMatchCatalogProvider();
  return {
    readAgents: () => base.readAgents(),
    async listSkills() {
      const skills = await base.listSkills();
      const { readSkillLifecycleStates } = await import("@/lib/database");
      const { isRuntimeDeliverableLifecycleState } = await import("@cinatra-ai/skills");
      const lifecycle = readSkillLifecycleStates(skills.map((s) => s.id));
      // Fail-closed: an ambiguous lifecycle read yields NO candidates this run
      // (a safe no-op — never a match row for an unresolved/archived skill).
      if (!lifecycle.ok) return [];
      return skills.filter((s) =>
        isRuntimeDeliverableLifecycleState(
          lifecycle.states.has(s.id) ? lifecycle.states.get(s.id) : undefined,
        ),
      );
    },
    async getSkillById(skillId: string) {
      const skill = await base.getSkillById(skillId);
      if (!skill) return skill;
      const { readSkillLifecycleStates } = await import("@/lib/database");
      const { isRuntimeDeliverableLifecycleState } = await import("@cinatra-ai/skills");
      const lifecycle = readSkillLifecycleStates([skillId]);
      const deliverable =
        lifecycle.ok &&
        isRuntimeDeliverableLifecycleState(
          lifecycle.states.has(skillId) ? lifecycle.states.get(skillId) : undefined,
        );
      // Fail-closed: withhold a non-deliverable / unresolved skill so the
      // inline-for-skill handler no-ops on it.
      return deliverable ? skill : null;
    },
  };
}

// A permissive passthrough schema for handlers that read no required fields up
// front (they cast `job.data` loosely or take an empty payload). Validating
// these as "any object, extra keys preserved" keeps the platform-managed
// `__actorContext` key intact and never rejects a previously-accepted payload.
const looseObject = () => z.object({}).passthrough();

export const BACKGROUND_JOB_REGISTRY: Record<BackgroundJobName, JobHandler> = {
  // `BLOG_POST_IDEA_GENERATION` and `BLOG_POST_DRAFT_GENERATION` handlers are
  // retired; replacements live in `blog-pipeline-agent`.
  [BACKGROUND_JOB_NAMES.BLOG_POST_IMAGE_REGENERATION]: {
    payloadSchema: z
      .object({
        projectId: z.string(),
        postId: z.string(),
        customPrompt: z.string().optional(),
      })
      .passthrough(),
    async handle(job, jobId) {
      const { runBlogPostImageRegenerationJob } = await import("@/lib/blog");
      await runBlogPostImageRegenerationJob(
        job.data as { projectId: string; postId: string; customPrompt?: string },
        jobId,
      );
    },
  },
  [BACKGROUND_JOB_NAMES.BLOG_POST_WORDPRESS_DRAFT_CREATION]: {
    payloadSchema: z
      .object({
        projectId: z.string(),
        postId: z.string(),
        wordpressInstanceId: z.string(),
      })
      .passthrough(),
    async handle(job, jobId) {
      const { runWordPressDraftCreationJob } = await import("@/lib/blog");
      await runWordPressDraftCreationJob(
        job.data as { projectId: string; postId: string; wordpressInstanceId: string },
        jobId,
      );
    },
  },
  // `BLOG_POST_LINKEDIN_DRAFT_CREATION` handler is retired; the replacement is
  // `blog-linkedin-writer-agent` `linkedin_flow`.
  [BACKGROUND_JOB_NAMES.BLOG_POST_LINKEDIN_DRAFT_PUBLISH]: {
    payloadSchema: z
      .object({
        projectId: z.string(),
        postId: z.string(),
        draftId: z.string(),
      })
      .passthrough(),
    async handle(job, jobId) {
      const { runLinkedInDraftPublishJob } = await import("@/lib/blog");
      await runLinkedInDraftPublishJob(
        job.data as { projectId: string; postId: string; draftId: string },
        jobId,
      );
    },
  },
  [BACKGROUND_JOB_NAMES.LITELLM_PRICING_SYNC]: {
    payloadSchema: looseObject(),
    async handle(job) {
      const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: LITELLM_PRICING_SYNC_LOOP_JOB_ID,
        delayMs: ONE_WEEK_MS,
        label: "litellm-sync",
        run: async () => {
          // Cycle errors propagate to runRecurringLoop, which reports them to
          // the error reporter and always re-delays (cinatra#849).
          const { runLiteLlmPricingSyncJob } = await import("@cinatra-ai/metric-cost-api");
          const result = await runLiteLlmPricingSyncJob(job.data as Record<string, never>);
          console.log("[litellm-sync] BullMQ job complete:", result);
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.AUDIT_RETENTION_ENFORCE]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // Delete authz audit events older than the configured retention window,
      // then self-reschedule for tomorrow.
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: AUDIT_RETENTION_ENFORCE_LOOP_JOB_ID,
        delayMs: ONE_DAY_MS,
        label: "audit-retention",
        run: async () => {
          // Cycle errors propagate to runRecurringLoop, which reports them to
          // the error reporter and always re-delays (cinatra#849).
          const { enforceAuditRetention } = await import("@/lib/authz/audit");
          const result = await enforceAuditRetention();
          console.log(
            `[audit-retention] swept: cutoff=${result.cutoffIso} retentionDays=${result.retentionDays} deleted=${result.deleted}`,
          );
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.GRAPHITI_PROJECTION_REPAIR]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // Outbox repair worker. Re-delays the SINGLE canonical loop job each
      // cycle via the shared loop helper — it must NOT queue.add a fresh
      // anonymous successor (the old behavior), because the boot seed's
      // stable-jobId dedup stops matching once the loop goes anonymous, so
      // every server restart seeded ANOTHER independent loop -> ~450-job queue
      // storm. Anonymous duplicates run once + die (id-guard in the helper).
      //
      // Ensure the CRM object-sync adapters are registered before the outbox
      // runs so the projector can route adapter-owned CRM types
      // (account/contact) to the Twenty→Graphiti adapter, which hydrates via
      // the crm_* facade before composing the episode. Resolved through the
      // `crm-sync-bootstrap` capability the crm-connector registers at
      // activation (idempotent connector-side; the MCP-server boot path
      // registers the same adapters via createCrmModule()) — the dispatcher
      // names no connector package (lazy/guarded host-access cutover). The
      // Twenty CRM provider needs no bootstrap call here: it registers behind
      // the `crm-provider` capability at its own activation and resolves
      // through the SDK registry's external resolver. With no provider
      // registered (crm-connector genuinely absent/inactive) this is a no-op
      // and adapter-owned rows FALL THROUGH to the projector's GENERIC
      // projection (terminal episodes without Twenty hydration — the accepted
      // degraded mode for an absent connector; rows that DID route through a
      // registered adapter keep the per-entry retry/failure semantics). Never
      // a worker crash either way.
      const THIRTY_SECONDS_MS = 30_000;
      await runRecurringLoop({
        job,
        loopJobId: GRAPHITI_PROJECTION_REPAIR_LOOP_JOB_ID,
        delayMs: THIRTY_SECONDS_MS,
        label: "graphiti-projection-repair",
        run: async () => {
          // No cycle-level try/catch here (cinatra#849): runRecurringLoop reports
          // a throw to the error reporter and always re-delays. Both the pre-work
          // `ensureCrmSyncRegistrations()` / dynamic import AND processProjectionOutbox
          // now propagate — a load-time import rejection or an outbox failure
          // surfaces to Sentry and the 30s loop survives, instead of the throw
          // (formerly outside the inner try) skipping moveToDelayed and silently
          // killing the loop until the next reboot re-seeded it.
          ensureCrmSyncRegistrations();

          // Binding-reconcile queue drain (cinatra#1429, epic #1424). The claim
          // registry enqueues a durable 'binding-reconcile' row on every winner
          // transition; drain it in the SAME 30s repair cadence so a claim
          // winner change reconciles every affected row's binding. Drained
          // BEFORE the projection cycle so (a) the freshly-reconciled bindings
          // project THIS cycle, and (b) a later projection-cycle throw cannot
          // starve binding reconciliation (codex Q4). The sweep is idempotent +
          // FOR UPDATE SKIP LOCKED. Lazy-imported (same alias pattern as the
          // cycle) to keep the objects binding graph off the registry's
          // module-load path. A throw surfaces to the loop's error reporter and
          // the loop re-delays — the #849 no-cycle-try/catch contract.
          const { processBindingReconcileQueue } = await import(
            "@/lib/objects/binding-reconcile-sweep"
          );
          const drain = processBindingReconcileQueue({ limit: 50 });
          if (drain.processed > 0 || drain.failed > 0) {
            console.log("[graphiti-projection-repair] binding-reconcile drain:", drain);
          }

          // Full projection cycle (#1427): batch pending claim-set changes
          // into projection-policy epoch bumps, advance open epoch-fenced
          // rebuild journals, then drain the outbox (stale-epoch fencing
          // inside the worker). Same alias pattern as the projector — the
          // rebuild module is a sub-path export, never the barrel.
          const { processGraphitiProjectionCycle } = await import(
            "@cinatra-ai/objects/graphiti-rebuild"
          );
          const result = await processGraphitiProjectionCycle({ batchSize: 20, maxAttempts: 5 });
          if (
            result.processed > 0 ||
            result.failed > 0 ||
            result.epochBumps > 0 ||
            result.journalsAdvanced > 0 ||
            result.journalsOpen > 0
          ) {
            console.log("[graphiti-projection-repair] cycle:", result);
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.TWENTY_POINTER_REPAIR]: {
    payloadSchema: z
      .object({
        type: z.enum(["account", "contact"]),
        externalId: z.string(),
        name: z.string(),
        orgId: z.string().nullable(),
        userId: z.string().nullable(),
      })
      .passthrough(),
    async handle(job) {
      // Durable-repair handler. One-shot per enqueue (NOT self-rescheduling).
      // BullMQ's `attempts`/`backoff` cover transient retries — see the enqueue
      // site in extensions/cinatra-ai/crm-connector/src/mcp/module.ts. The
      // write resolves through the `crm-pointer-writer` capability the
      // crm-connector registers at activation (lazy/guarded host-access
      // cutover) — the impl owns the register-types-before-write ordering (the
      // objects_save classifier fast-path) and loads the heavy MCP module at
      // write time, so the dispatcher names no connector package and the host
      // bundle stays off crm-connector's synchronous graph at boot.
      //
      // Payload MUST carry orgId/userId because the worker process has no
      // `mcpRequestContextStorage` frame. Without them, the pointer write would
      // synthesise an actor with `orgId === null`, which `objects_save` rejects
      // on entry, causing every retry to fail deterministically.
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
    },
  },
  [BACKGROUND_JOB_NAMES.REGISTRY_POLL]: {
    payloadSchema: z
      .object({
        requestId: z.string(),
        scheduledFor: z.number().optional(),
      })
      .passthrough(),
    async handle(job) {
      // Public-registry polling driver. The handler owns its own state-machine
      // reschedule semantics (200-pending + 429 + 5xx all self-reschedule via
      // enqueueBackgroundJob). We do NOT add a dispatcher-level try/catch here:
      // a thrown error would re-trigger BullMQ retry on top of our
      // state-machine retry, which would double-process the just-persisted
      // lastPolledAt/nextPollAt. The 200-pending branch INSIDE the handler
      // wraps its reschedule call in try/catch + redacted warn for the
      // Redis-outage case.
      //
      // Payload optionally carries `scheduledFor` (set by self-reschedules for
      // the app-level stale-attempt guard). The initial enqueue from
      // `requestRemoteAccessAction` does not set it.
      const { runRegistryPollJob } = await import("@/lib/registry-poll-job");
      await runRegistryPollJob(job.data as { requestId: string; scheduledFor?: number });
    },
  },
  [BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION]: {
    payloadSchema: z
      .object({
        runId: z.string(),
        gateAttempt: z.number().optional(),
      })
      .passthrough(),
    async handle(job, jobId) {
      // TriggerGateClosedError catch + re-queue.
      // The gate fires inside runAgentBuilderExecutionJob immediately before
      // the WayFlow A2A dispatch (transitionRunStatus queued→running). When
      // closed, the function throws TriggerGateClosedError without changing the
      // DB status. Here we catch the sentinel, increment the gateAttempt
      // counter, and move the job to delayed via job.moveToDelayed (BullMQ flow
      // control — does NOT consume a retry attempt). The Redis worker
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
          // to complete the now-delayed job (which logs a "missing lock"
          // error).
          throw new DelayedError();
        }
        throw err;
      }
    },
  },
  // Trigger release job: opens the gate (Redis flag + DB releasedAt),
  // transitions armed -> queued, and enqueues AGENT_BUILDER_EXECUTION.
  // Recurring triggers create a fresh pending run + arm immediate.
  [BACKGROUND_JOB_NAMES.AGENT_RUN_TRIGGER_RELEASE]: {
    payloadSchema: z.object({ runId: z.string() }).passthrough(),
    async handle(job, jobId) {
      const { runAgentRunTriggerReleaseJob } = await import("@cinatra-ai/agents");
      await runAgentRunTriggerReleaseJob(job.data as { runId: string }, jobId);
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_PREFILL_GENERATION]: {
    payloadSchema: z.object({ skillIds: z.array(z.string()) }).passthrough(),
    async handle(job, jobId) {
      const { runSkillPrefillGenerationJob } = await import("@cinatra-ai/skills");
      await runSkillPrefillGenerationJob(job.data as { skillIds: string[] }, jobId);
    },
  },
  // Chat-capture detection (cinatra#1367): one-shot per persisted chat user
  // turn. The pipeline is idempotent via the chat_capture_turns ledger claim,
  // so re-deliveries / enqueue-site retries are safe. Lazy-imported to keep
  // the LLM + skills graph out of the registry's module load.
  [BACKGROUND_JOB_NAMES.CHAT_CAPTURE_DETECTION]: {
    payloadSchema: z
      .object({ threadId: z.string(), turnId: z.string(), ownerUserId: z.string() })
      .passthrough(),
    async handle(job, jobId) {
      const { runChatCaptureDetectionJob } = await import("@/lib/chat-capture/pipeline");
      await runChatCaptureDetectionJob(
        job.data as { threadId: string; turnId: string; ownerUserId: string },
        jobId,
      );
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_SKILL]: {
    payloadSchema: z
      .object({ skillId: z.string(), jobStartedAt: z.string() })
      .passthrough(),
    async handle(job) {
      // Inline-for-skill fan-out (one skill x all matchable agents).
      // Lazy-imported to avoid module-load cycles between background-jobs.ts
      // and @cinatra-ai/skills. Catalog provider injected via the
      // CatalogProvider seam; the handler no longer reaches into the host
      // app's stores directly.
      const { handleInlineForSkill } = await import("@cinatra-ai/skills");
      // A3 (cinatra#1363): candidate-creation path — gate out non-deliverable skills.
      const catalog = await buildDeliverableSkillMatchCatalogProvider();
      await handleInlineForSkill(
        job.data as { skillId: string; jobStartedAt: string },
        { catalog },
      );
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_AGENT]: {
    payloadSchema: z
      .object({ agentId: z.string(), jobStartedAt: z.string() })
      .passthrough(),
    async handle(job) {
      // Inline-for-agent fan-out (one agent x all matchable skills).
      const { handleInlineForAgent } = await import("@cinatra-ai/skills");
      // A3 (cinatra#1363): candidate-creation path — gate out non-deliverable skills.
      const catalog = await buildDeliverableSkillMatchCatalogProvider();
      await handleInlineForAgent(
        job.data as { agentId: string; jobStartedAt: string },
        { catalog },
      );
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_SUBMIT]: {
    payloadSchema: z.object({ submittedBy: z.string() }).passthrough(),
    async handle(job) {
      // Submit a single OpenAI batch covering all current pairs.
      const { handleBatchSubmit } = await import("@cinatra-ai/skills");
      // A3 (cinatra#1363): candidate-creation path — gate out non-deliverable skills.
      const catalog = await buildDeliverableSkillMatchCatalogProvider();
      await handleBatchSubmit(job.data as { submittedBy: string }, { catalog });
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_POLL]: {
    payloadSchema: z
      .object({ batchId: z.string(), jobStartedAt: z.string() })
      .passthrough(),
    async handle(job) {
      // Poll an in-flight batch; self-reschedule until terminal status; on
      // completion, download results and upsert via the shared evaluator core.
      const { handleBatchPoll } = await import("@cinatra-ai/skills");
      const catalog = await buildSkillMatchCatalogProvider();
      await handleBatchPoll(
        job.data as { batchId: string; jobStartedAt: string },
        { catalog },
      );
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_MATCH_DRIFT_SAMPLE]: {
    payloadSchema: looseObject(),
    async handle() {
      // Production drift sampler.
      // Re-evaluates SKILL_MATCH_DRIFT_SAMPLE_SIZE random llm/ok rows and emits
      // structured `skill-match-drift` log events when the decision flipped or
      // the score moved beyond SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD. The
      // handler is invoked via the same CatalogProvider seam as the inline +
      // batch transports so this has no new structural coupling to host-side
      // stores.
      const {
        handleDriftSample,
        recordDriftObservations,
        readSkillMatchDriftFlags,
        writeSkillMatchDriftFlags,
      } = await import("@cinatra-ai/skills");
      const catalog = await buildSkillMatchCatalogProvider();
      await handleDriftSample({
        catalog,
        // Persist per-pair drift observations (cinatra #1365) so repeatedly
        // drifting pairs are auto-flagged. The KV read/write is host-side; the
        // sampler stays decoupled behind this injected recorder.
        recordDriftObservations: async (observations) => {
          await recordDriftObservations(observations, {
            readDriftFlags: async () => readSkillMatchDriftFlags(),
            writeDriftFlags: async (map) => writeSkillMatchDriftFlags(map),
          });
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.SKILL_MATCH_MAINTENANCE_TICK]: {
    payloadSchema: looseObject(),
    async handle() {
      // Matching-maintenance tick (cinatra #1365): tombstoned orphan GC then the
      // hash staleness sweep. Invoked via the same CatalogProvider seam as the
      // inline / batch / drift transports; the tombstone / drift-flag / manual-
      // stale KV are host-side and injected here so the package stays decoupled.
      const {
        handleMaintenanceTick,
        enqueueInlineForSkill,
        readSkillMatchOrphanTombstones,
        writeSkillMatchOrphanTombstones,
        clearSkillMatchDriftFlagsForPairKeys,
        writeSkillMatchManualStale,
      } = await import("@cinatra-ai/skills");
      const catalog = await buildSkillMatchCatalogProvider();
      await handleMaintenanceTick({
        catalog,
        // --- orphan GC deps ---
        readTombstones: async () => readSkillMatchOrphanTombstones(),
        writeTombstones: async (map) => writeSkillMatchOrphanTombstones(map),
        clearDriftFlags: async (pairKeys) => clearSkillMatchDriftFlagsForPairKeys(pairKeys),
        // A pair that reappeared after a delete gets a fresh inline eval. The
        // per-skill fan-out covers the pair (skill × all agents) and is
        // idempotent by jobId, so multiple reappearances coalesce.
        enqueueReeval: async (_agentId, skillId) => {
          await enqueueInlineForSkill(skillId);
        },
        // --- sweep deps ---
        recordManualStale: async (pairs) => writeSkillMatchManualStale(pairs),
      });
    },
  },
  [BACKGROUND_JOB_NAMES.ARTIFACT_PROVIDER_CACHE_EVICT]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // Sweep expired rows from the provider-file ref cache.
      // `evictExpiredProviderFiles` is tenant+provider-scoped by design; we
      // enumerate (orgId, provider) pairs via
      // `listOrgProvidersWithExpiredCache` and call it per pair. `deleteRemote`
      // routes through the orchestration-layer `deleteFile` so each provider's
      // own SDK handles the remote delete (no per-provider switch here).
      // Self-reschedules with a 4h delay.
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: ARTIFACT_PROVIDER_CACHE_EVICT_LOOP_JOB_ID,
        delayMs: FOUR_HOURS_MS,
        label: "artifact-provider-cache-evict",
        run: async () => {
          // Cycle errors propagate to runRecurringLoop, which reports them to
          // the error reporter and always re-delays (cinatra#849). The inner
          // per-(org, provider) try/catch below still isolates a single tenant's
          // failure so one bad pair does not abort the whole sweep.
          const { listOrgProvidersWithExpiredCache, evictExpiredProviderFiles } =
            await import("@/lib/artifacts/provider-file-cache");
          const { deleteFile } = await import("@cinatra-ai/llm");
          const pairs = listOrgProvidersWithExpiredCache();
          // Provider values come from the DB column (plain `text`); narrow to
          // the known `LlmProvider` literal union before handing them to the
          // orchestration layer's typed deleteFile. An unknown provider is
          // benign — just no remote delete; the DB row is still reaped on the
          // next sweep (note: `evictExpiredProviderFiles` deletes the row
          // AFTER awaiting `deleteRemote`, so a no-op adapter is the right
          // fallback).
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
              // Single tenant/provider failure must not block the rest of the
              // sweep — log + continue.
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
          // that lets the adapters propagate real errors (only swallowing 404
          // / already-deleted). Until then, this WARN is a forward-looking
          // safety net rather than an active observability signal.
          if (totalRemoteDeleteFailures > 0) {
            console.warn(
              `[artifact-provider-cache-evict] ${totalRemoteDeleteFailures} of ${totalReaped} remote deletes FAILED — provider SDK or credentials may be misconfigured; DB rows were still removed`,
            );
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.EXTENSION_STORE_GC_REAP]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // Explicit content-addressed extension-store GC reaper (cinatra#796).
      // Enforces the epic-#790 retention contract over the V2 runtime store:
      // keep the DB-anchored ACTIVE digest + the 2 newest priors per
      // {kind, slug}; delete the rest — never anything active, leased,
      // undatable, too young, or belonging to a fail-closed slug. The delete
      // loop re-verifies BOTH the lease AND the DB/journal active binding
      // against FRESH reads immediately before each rm (TOCTOU, cinatra#850).
      // Self-reschedules with a 24h delay; a cycle error propagates to
      // runRecurringLoop, which reports it and always re-delays (cinatra#849).
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: EXTENSION_STORE_GC_REAP_LOOP_JOB_ID,
        delayMs: TWENTY_FOUR_HOURS_MS,
        label: "extension-store-gc-reap",
        run: async () => {
          // Resolve the BOOT-REGISTERED runner (see the slot above) — never a
          // direct import (route-graph ratchet: the locked routes reach this
          // registry). An empty slot no-ops loudly; runRecurringLoop re-delays.
          const reap = resolveExtensionStoreReaper();
          if (!reap) {
            console.warn(
              "[extension-store-gc-reap] no reaper registered (the boot system-loops phase did not run in this process) — skipping this cycle",
            );
            return;
          }
          const report = await reap();
          const summary =
            `deleted=${report.deleted.length} retained=${report.retained.length} ` +
            `protected=${report.protectedEntries.length} scanned=${report.scannedDigests} ` +
            `racedLease=${report.skippedForRacedLease.length} racedActive=${report.skippedForRacedActive.length} ` +
            `failedDeletes=${report.failedDeletes.length} unsafeSlugs=${report.unsafeSlugs.length}`;
          if (report.deleted.length > 0 || report.failedDeletes.length > 0) {
            console.log(`[extension-store-gc-reap] ${summary}`, {
              deleted: report.deleted,
              failedDeletes: report.failedDeletes,
            });
          } else {
            console.log(`[extension-store-gc-reap] ${summary}`);
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.EXTENSION_AUTO_UPDATE]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // In-app extension auto-update loop (cinatra#1042). The cycle itself
      // (candidate selection through the cached update read model, the
      // scope/ABI/signature gates, and the planner/batch execution under the
      // system Actor) lives in the BOOT-REGISTERED runner (see the slot
      // above — route-graph ratchet). The runner re-checks the master flag
      // (default OFF) and no-ops when disabled; a cycle error propagates to
      // runRecurringLoop, which reports it and always re-delays (cinatra#849).
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
        delayMs: TWENTY_FOUR_HOURS_MS,
        label: "extension-auto-update",
        run: async () => {
          const runner = resolveExtensionAutoUpdateRunner();
          if (!runner) {
            console.warn(
              "[extension-auto-update] no runner registered (the boot system-loops phase did not run — or ran with the flag disabled — in this process); skipping this cycle",
            );
            return;
          }
          const summary = await runner();
          if (!summary.enabled) {
            console.log(
              "[extension-auto-update] master flag disabled at cycle time — skipped cycle",
            );
            return;
          }
          const line =
            `readModelWired=${summary.readModelWired} signatureReady=${summary.signatureReady ?? "n/a"} ` +
            `scanned=${summary.scanned} applied=${summary.applied.length} ` +
            `failed=${summary.failed.length} skipped=${summary.skipped.length} ` +
            `auditWriteFailures=${summary.auditWriteFailures}`;
          if (summary.applied.length > 0 || summary.failed.length > 0) {
            console.log(`[extension-auto-update] ${line}`, {
              applied: summary.applied,
              failed: summary.failed,
            });
          } else {
            console.log(`[extension-auto-update] ${line}`);
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.ENVIRONMENT_LAYER_GC_REAP]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // L1 environment-layer retention GC reaper (exec-plane S3 A3,
      // cinatra#1708). Reaps zero-reference layers past the retention window
      // from the durable environment-layer store via the advisory-lock-
      // serialized delete→commit→rmi protocol on the A2 execution service. The
      // reaper is reached through the boot-registered DI slot (route-graph
      // ratchet: this registry sits in the locked routes' reachable graph, so
      // only a TYPE-erased, lightweight slot accessor is imported — never the
      // heavy execution-plane graph). An unregistered / non-`ready` slot no-ops
      // loudly; runRecurringLoop always re-delays. Self-reschedules at 24h.
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: ENVIRONMENT_LAYER_GC_REAP_LOOP_JOB_ID,
        delayMs: TWENTY_FOUR_HOURS_MS,
        label: "environment-layer-gc-reap",
        run: async () => {
          const { getEnvironmentLayerReaper } = await import(
            "@/lib/execution/register-execution-environment-service"
          );
          const reap = getEnvironmentLayerReaper();
          if (!reap) {
            console.warn(
              "[environment-layer-gc-reap] execution-environment service not `ready` in this process (slot disabled/unavailable) — skipping this cycle",
            );
            return;
          }
          const report = await reap();
          console.log(
            `[environment-layer-gc-reap] reaped=${report.reaped.length}`,
            report.reaped.length > 0 ? { reaped: report.reaped } : undefined,
          );
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.ARTIFACT_MATCH_RUN]: {
    payloadSchema: z
      .object({
        orgId: z.string().optional(),
        artifactId: z.string().optional(),
        representationRevisionId: z.string().optional(),
        createdByRunId: z.string().nullable().optional(),
      })
      .passthrough(),
    async handle(job) {
      // Async LLM MEANING-matcher (cinatra#1891, epic #1883 A3).
      // One-shot per artifact (NOT self-rescheduling). Honest-retry semantics:
      // a TRANSIENT failure inside `runArtifactMatch` (a DB read/write blip, an
      // LLM provider hiccup) throws `MatcherRetryableError` PAST this boundary,
      // so BullMQ retries the job per the enqueue's `ARTIFACT_MATCH_RETRY_POLICY`
      // (attempts/backoff). TERMINAL conditions (no runtime configured, orphan
      // row, a malformed LLM response for one candidate) resolve cleanly and are
      // NOT retried; the row simply stays at its structural identity.
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
    },
  },
  [BACKGROUND_JOB_NAMES.UNBOUND_OUTPUT_DERIVE]: {
    payloadSchema: z
      .object({
        runId: z.string().optional(),
        orgId: z.string().optional(),
      })
      .passthrough(),
    async handle(job) {
      // Post-terminal unbound agent-output derivation (cinatra#1893, epic #1883
      // A5). ONE-SHOT per run. A TRANSIENT failure inside `deriveUnboundRunOutput`
      // (a DB blip, a classifier hiccup) throws `UnboundDerivationRetryableError`
      // PAST this boundary — BullMQ retries per the enqueue's
      // UNBOUND_OUTPUT_DERIVE_RETRY_POLICY; the reconciliation sweep is the final
      // backstop. A settled row (missing/terminal/held/exhausted) resolves cleanly
      // as `skipped` and is NOT retried.
      const p = job.data as { runId?: string; orgId?: string };
      if (!p.runId || !p.orgId) {
        console.warn(
          "[unbound-output] malformed UNBOUND_OUTPUT_DERIVE payload — skipping:",
          p,
        );
        return;
      }
      // The derivation core is boot-registered through the runner slot (kept out
      // of this registry's route graph). `runner.derive` IS `deriveUnboundRunOutput`
      // when registered, so the retry/settle semantics above hold unchanged. An
      // empty slot means the boot seed has not run in this bundle yet — skip the
      // one-shot; the durable outbox row + reconciliation sweep are the backstop.
      const runner = resolveUnboundOutputDerivationRunner();
      if (!runner) {
        console.warn(
          `[unbound-output] derivation runner slot empty — one-shot derive skipped for run ${p.runId} (the reconciliation sweep backstops)`,
        );
        return;
      }
      await runner.derive({ runId: p.runId, orgId: p.orgId });
    },
  },
  [BACKGROUND_JOB_NAMES.UNBOUND_OUTPUT_DERIVE_SWEEP]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // ~5-minute reconciliation sweep over the unbound-output outbox
      // (cinatra#1893). Drains `pending` rows + reclaims expired `deriving` leases
      // whose one-shot enqueue was lost / crashed. The worker never throws
      // per-row (deriveUnboundRunOutput's retryable failures are tallied, not
      // rethrown); any unexpected throw propagates to runRecurringLoop, which
      // reports it and always re-delays (cinatra#849).
      const FIVE_MINUTES_MS = 5 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: UNBOUND_OUTPUT_DERIVE_SWEEP_LOOP_JOB_ID,
        delayMs: FIVE_MINUTES_MS,
        label: "unbound-output-derive-sweep",
        run: async () => {
          // Boot-registered slot (kept out of this registry's route graph). A
          // skipped maintenance cycle is safe; the boot seed registers the runner
          // before it seeds this loop, so a healthy boot never sees an empty slot.
          const runner = resolveUnboundOutputDerivationRunner();
          if (!runner) {
            console.warn(
              "[unbound-output-derive-sweep] runner slot empty — skipping cycle",
            );
            return;
          }
          const summary = await runner.sweep();
          if (summary.attempted > 0) {
            console.log(
              `[unbound-output-sweep] attempted=${summary.attempted} done=${summary.done} no_match=${summary.no_match} no_produces=${summary.no_produces} skipped=${summary.skipped} failed=${summary.failed}`,
            );
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.ARTIFACT_REVIEW_RESUME_DELIVERY]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // ~30-second drain of the artifact-review resume outbox (cinatra#1796).
      // Leases pending review-decision resume intents (and reclaims expired
      // `delivering` leases from a crashed worker) and delivers each typed
      // approve/reject payload to its paused WayFlow run. The drain never throws
      // per-intent (sweepArtifactReviewResumeIntents tallies per-row failures and
      // leaves the row pending for re-claim); any unexpected throw propagates to
      // runRecurringLoop, which reports it and always re-delays (cinatra#849).
      const THIRTY_SECONDS_MS = 30 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: ARTIFACT_REVIEW_RESUME_DELIVERY_LOOP_JOB_ID,
        delayMs: THIRTY_SECONDS_MS,
        label: "artifact-review-resume-delivery",
        run: async () => {
          // Boot-registered slot (kept out of this registry's route graph). A
          // skipped drain cycle is safe — the outbox intent is durable and the
          // next cycle re-claims it — and the boot seed registers the runner
          // before it seeds this loop, so a healthy boot never sees an empty slot.
          const runner = resolveArtifactReviewResumeDeliveryRunner();
          if (!runner) {
            console.warn(
              "[artifact-review-resume-delivery] runner slot empty — skipping cycle",
            );
            return;
          }
          const summary = await runner.sweep();
          if (summary.attempted > 0) {
            console.log(
              `[artifact-review-resume-delivery] attempted=${summary.attempted} delivered=${summary.delivered} already_advanced=${summary.alreadyAdvanced} retryable=${summary.retryable} failed=${summary.failed}`,
            );
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.MARKETPLACE_CATALOG_SYNC]: {
    payloadSchema: z
      .object({
        packageName: z.string().optional(),
        packageVersion: z.string().optional(),
      })
      .passthrough(),
    async handle(job) {
      // Reconciles the Verdaccio registry → marketplace catalog. Two modes
      // determined by the job payload shape:
      //   - Full sweep (no `packageName`): walks every package the registry
      //     exposes and syncs each one's metadata + README into the
      //     marketplace catalog. Logs per-package failures but does NOT throw
      //     on individual rejections — the next periodic sweep retries
      //     naturally. Self-reschedules at 1h. Top-level errors (Verdaccio
      //     unavailable, marketplace token missing) are caught and logged so
      //     the canonical loop ALWAYS re-delays (matching
      //     audit-retention-enforce + the BullMQ perpetual-loop doctrine).
      //   - Single-package (`{ packageName, packageVersion }`): fast freshness
      //     path enqueued from the admin Approve action. Throws on failure so
      //     BullMQ's retry/backoff kicks in.
      const payload = (job.data ?? {}) as {
        packageName?: string;
        packageVersion?: string;
      };
      const singlePackageMode =
        typeof payload.packageName === "string" && payload.packageName !== "";

      // Single-package mode: run the work, throw on any failure so BullMQ
      // retries the one-shot via attempts/backoff. Does NOT wrap in try/catch
      // and does NOT self-reschedule.
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
        if (
          summary.fetchFailedCount > 0 ||
          summary.mapFailedCount > 0 ||
          summary.syncFailedCount > 0
        ) {
          const reasons = summary.perPackage
            .filter(
              (p) =>
                p.status === "fetch-failed" ||
                p.status === "map-failed" ||
                p.status === "sync-failed",
            )
            .map((p) => `${p.packageName}: ${p.rejectionReason ?? "unknown"}`)
            .join("; ");
          throw new Error(
            `MARKETPLACE_CATALOG_SYNC single-package reconcile failed: ${reasons || "no detail"}`,
          );
        }
        // scope-rejected is a terminal policy decision (not retried).
        return;
      }

      // Full-sweep mode. Transient failures (Verdaccio unreachable, marketplace
      // 500s) propagate to runRecurringLoop, which reports them to the error
      // reporter and always re-delays for the next tick (cinatra#849) — the
      // re-delay-on-throw guarantee lives in the helper now, not in a per-arm wrap.
      const ONE_HOUR_MS = 60 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: MARKETPLACE_CATALOG_SYNC_LOOP_JOB_ID,
        delayMs: ONE_HOUR_MS,
        label: "marketplace-catalog-sync",
        run: async () => {
          // Cycle errors propagate to runRecurringLoop (report + always re-delay,
          // cinatra#849). The credential-unavailable branch returns normally
          // (warn, no throw) so it is NOT reported as a failure.
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
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.VENDOR_APPLICATION_STATE_RECONCILE]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // 5-minute sweep that drives `vendor_application_complete_recovery` for
      // namespace-reservation rows stuck in the `applied` state (broker +
      // cap-grant succeeded marketplace-side but the DB flip did not land).
      // Per-application failures are logged + counted inside the reconcile job
      // (one bad row must not stop the rest). Any unexpected throw propagates to
      // runRecurringLoop, which reports it to the error reporter and always
      // re-delays so the perpetual-loop doctrine is preserved (cinatra#849).
      const FIVE_MINUTES_MS = 5 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID,
        delayMs: FIVE_MINUTES_MS,
        label: "vendor-application-state-reconcile",
        run: async () => {
          // Cycle errors propagate to runRecurringLoop (report + always re-delay,
          // cinatra#849). The bearer-unavailable branch returns normally (warn,
          // no throw) so it is NOT reported as a failure.
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
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.PM_SCHEDULE_RECONCILE]: {
    payloadSchema: looseObject(),
    async handle(job) {
      // ~10-minute OUTBOUND-REPAIR sweep over agent_run_pm_links rows that
      // failed / never-synced (cinatra#318). Re-projects the LOCAL trigger
      // (source of truth) outward via the host PM bridge — re-pushing
      // errored/unsynced links and finishing deferred deletes. The worker
      // never throws (per-row warn-and-skip); any unexpected throw propagates to
      // runRecurringLoop, which reports it to the error reporter and always
      // re-delays (cinatra#849). A PM outage must not poison the queue or alter
      // local schedules.
      const TEN_MINUTES_MS = 10 * 60 * 1000;
      await runRecurringLoop({
        job,
        loopJobId: PM_SCHEDULE_RECONCILE_LOOP_JOB_ID,
        delayMs: TEN_MINUTES_MS,
        label: "pm-schedule-reconcile",
        run: async () => {
          // Cycle errors propagate to runRecurringLoop (report + always re-delay,
          // cinatra#849).
          const { buildPmScheduleReconcileDeps } = await import(
            "@/lib/pm-schedule-reconcile-deps"
          );
          const { runPmScheduleReconcile } = await import(
            "@cinatra-ai/pm-schedule-reconcile"
          );
          const deps = buildPmScheduleReconcileDeps();
          const summary = await runPmScheduleReconcile(deps);
          if (summary.attempted > 0 || summary.repaired > 0 || summary.failed > 0) {
            console.log(
              `[pm-schedule-reconcile] attempted=${summary.attempted} repaired=${summary.repaired} skipped=${summary.skipped} failed=${summary.failed}`,
            );
          }
        },
      });
    },
  },
  [BACKGROUND_JOB_NAMES.WEBHOOK_OUTBOUND_DELIVERY]: {
    payloadSchema: z
      .object({
        assistantUserId: z.string().optional(),
        eventKind: z.string().optional(),
        messageId: z.string().optional(),
        payload: z.unknown().optional(),
      })
      .passthrough(),
    async handle(job) {
      // Host-owned OUTBOUND webhook delivery (cinatra#341). One-shot per
      // enqueue (NOT self-rescheduling) — BullMQ `attempts`/`backoff` (set at
      // the enqueue site) drive retries.
      //
      // Identity-bearing material (url + secret) is NEVER in the job payload
      // (F1: keeps the secret out of Redis and prevents url/secret drift). We
      // resolve BOTH from the producer-specific identity at EACH attempt via
      // the eventKind resolver below.
      //
      // DLQ ownership is DISPATCHER-ONLY (F4): on `permanent` (incl. missing
      // url/secret and a non-decodable legacy secret the lib rejects) we record
      // a DLQ row and RETURN (no throw). On `retryable` we THROW so BullMQ
      // retries — and on the LAST attempt we record a DLQ row FIRST, then
      // throw. `worker.on("failed")` keeps ONLY its Sentry+notification; it
      // does NOT write the DLQ.
      const p = job.data as {
        assistantUserId?: string;
        eventKind?: string;
        messageId?: string;
        payload?: unknown;
      };
      const eventKind = p.eventKind ?? "";
      const messageId = p.messageId ?? "";
      if (!eventKind || !messageId) {
        // Malformed enqueue — cannot DLQ coherently (no identity) and cannot
        // deliver. Log + return so it is not a retry storm.
        console.warn(
          "[webhook-outbound] malformed WEBHOOK_OUTBOUND_DELIVERY payload — skipping:",
          { eventKind, hasMessageId: Boolean(messageId) },
        );
        return;
      }

      // Subpath import (route-graph pressure): deliverOutbound is the ONLY
      // webhooks surface this registry needs — the barrel pulls the whole
      // inbound verify/secret-service/registry graph onto every route that
      // reaches the job registry.
      const { deliverOutbound } = await import("@cinatra-ai/webhooks/outbound");
      const { recordOutboundDeadLetter, digestPayload, sanitizeError } =
        await import("@/lib/webhook-outbound-deadletter.server");

      // eventKind → { url, secret } resolver. Structured so future outbound
      // producers plug in a new arm without touching delivery/DLQ logic. A null
      // return means the target is gone (profile/url deleted between enqueue
      // and run) → classified `permanent` (no target).
      let resolved: { url: string; secret: string } | null = null;
      if (eventKind === "assistant.mention") {
        const { assistantUserId } = p;
        if (assistantUserId) {
          const { readAssistantProfile } = await import("@/lib/assistant-profiles");
          const profile = readAssistantProfile(assistantUserId);
          if (profile?.webhookUrl) {
            resolved = {
              url: profile.webhookUrl,
              // D4a: the legacy plaintext profile secret IS the Standard-
              // Webhooks secret material. An empty/missing secret or a non-
              // decodable legacy secret makes `deliverOutbound` classify
              // `permanent` (fail-closed) — never a crash.
              secret: profile.webhookSecret ?? "",
            };
          }
        }
      } else {
        console.warn(
          `[webhook-outbound] unknown eventKind "${eventKind}" — no resolver; dead-lettering.`,
        );
      }

      // Resolve the actor id for the extra header (assistant.mention carries
      // its assistant id so receivers keep the assistant identity even though
      // the SIGNATURE scheme moved to Standard-Webhooks — F2).
      const extraHeaders =
        eventKind === "assistant.mention" && p.assistantUserId
          ? { "X-Cinatra-Assistant-Id": p.assistantUserId }
          : undefined;

      const attemptsConfigured = job.opts.attempts ?? 1;
      const attemptsMade = job.attemptsMade + 1; // this attempt (1-based)

      // Returns true if the DLQ row was durably written, false if the insert
      // threw. A DLQ write failure must NOT crash the worker, but it must not
      // be silently swallowed either: the caller surfaces a failed permanent
      // DLQ write by throwing so `worker.on("failed")` (Sentry + notification)
      // still records the loss (cinatra#341 codex round-1 HIGH — durability OR
      // visibility, never silent).
      const writeDeadLetter = (
        lastStatus: number | null,
        lastError: string | null,
      ): boolean => {
        try {
          recordOutboundDeadLetter({
            eventKind,
            messageId,
            targetUrl: resolved?.url ?? "(unresolved)",
            payloadDigest: digestPayload(p.payload ?? null),
            attempts: attemptsMade,
            lastStatus,
            lastError,
          });
          return true;
        } catch (dlqErr) {
          console.error(
            "[webhook-outbound] dead-letter write failed:",
            dlqErr instanceof Error ? dlqErr.message : dlqErr,
          );
          return false;
        }
      };

      if (!resolved) {
        // No deliverable target (missing/deleted url, or unknown eventKind):
        // permanent. DLQ + return (no retry storm). If the DLQ write itself
        // failed, throw so the failure is observable (Sentry+notification).
        const wrote = writeDeadLetter(
          null,
          `no deliverable target for eventKind "${eventKind}"`,
        );
        if (!wrote) {
          throw new Error(
            `[webhook-outbound] permanent failure (no target) AND dead-letter write failed for ${eventKind}/${messageId}`,
          );
        }
        return;
      }

      const result = await deliverOutbound({
        url: resolved.url,
        secret: resolved.secret,
        messageId,
        payload: p.payload ?? null,
        extraHeaders,
      });

      switch (result.kind) {
        case "delivered":
          return;
        case "permanent": {
          // Non-retryable (bad 4xx, reserved-header bug, or a non-decodable
          // legacy secret the signer rejected). DLQ + return — no retry. If the
          // DLQ write failed, throw so the loss is observable rather than
          // silently completing the job.
          const wrote = writeDeadLetter(result.status ?? null, result.error ?? null);
          if (!wrote) {
            throw new Error(
              `[webhook-outbound] permanent failure AND dead-letter write failed for ${eventKind}/${messageId}` +
                (result.status != null ? ` (status ${result.status})` : ""),
            );
          }
          return;
        }
        case "retryable": {
          const errMsg =
            result.error ??
            (result.status != null ? `HTTP ${result.status}` : "retryable failure");
          // On the LAST attempt, record the DLQ row BEFORE throwing so the
          // durable record exists even after BullMQ exhausts the job. (A failed
          // write here is still surfaced — we throw regardless, so
          // worker.on("failed") records the exhaustion either way.)
          // writeDeadLetter → recordOutboundDeadLetter scrubs last_error on
          // store, so the raw errMsg is safe to hand it here.
          if (attemptsMade >= attemptsConfigured) {
            writeDeadLetter(result.status ?? null, errMsg);
          }
          // Sanitize BEFORE throwing: this error propagates to
          // worker.on("failed") → Sentry + failed-job notifications, and undici
          // fills fetch errors with the FULL target URL (userinfo creds +
          // ?token= query secrets). The DLQ path scrubs on store, but the
          // reporting path must scrub too, or a retryable failure leaks a
          // credentialed URL outside the DLQ.
          // (cinatra#341 codex round-3 HIGH — DLQ never stores secrets / acceptance #3.)
          const safeErrMsg = sanitizeError(errMsg) ?? "retryable failure";
          throw new Error(`[webhook-outbound] delivery retryable: ${safeErrMsg}`);
        }
      }
    },
  },
};

/**
 * Validate a job payload against the registered handler's schema and dispatch.
 *
 * Replaces the monolithic `switch(job.name)` body. Steps:
 *   1. Look up the handler by `job.name`. An UNKNOWN name throws the same
 *      `Unsupported background job "<name>"` error the switch's `default` arm
 *      produced — preserving the worker's fail-fast-on-unknown contract.
 *   2. Validate `job.data` against the handler's `payloadSchema`. A malformed
 *      payload throws a clear `Invalid payload for background job "<name>": …`
 *      error so it fails fast at the dispatch boundary instead of crashing
 *      deeper inside the handler with an opaque undefined-access.
 *   3. Invoke the handler with the original `job` (handlers keep reading
 *      `job.data` directly via their existing loose casts; the `.passthrough()`
 *      schemas guarantee no field — including `__actorContext` — is stripped).
 *
 * The execution-depth counter and the ActorContext ALS-frame wrapper stay in
 * `background-jobs.ts` around the call to this function (unchanged).
 */
export async function dispatchRegisteredJob(job: Job, jobId: string): Promise<void> {
  const name = job.name as BackgroundJobName;
  const handler = BACKGROUND_JOB_REGISTRY[name];
  if (!handler) {
    throw new Error(`Unsupported background job "${job.name}".`);
  }
  const parsed = handler.payloadSchema.safeParse(job.data ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid payload for background job "${job.name}": ${parsed.error.message}`,
    );
  }
  await handler.handle(job, jobId);
}

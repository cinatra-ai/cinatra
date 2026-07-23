// Leaf module: background-job NAME constants + canonical recurring-loop jobIds.
//
// Extracted from `background-jobs.ts` (cinatra#304) so BOTH the thin runtime
// module (`background-jobs.ts`) AND the handler registry
// (`background-jobs-registry.ts`) can import these without an init-time
// circular import. This module has NO runtime deps (no BullMQ, no Redis, no
// server-only side effects) — it is pure constant + type declarations, safe to
// import from anywhere.
//
// `background-jobs.ts` re-exports every symbol here so the public
// `@/lib/background-jobs` import surface is byte-stable for the ~66 existing
// importers (they keep importing `BACKGROUND_JOB_NAMES`, the LOOP_JOB_ID
// constants, and `BackgroundJobName` from `@/lib/background-jobs` unchanged).

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
  // Matching-maintenance tick (cinatra #1365): tombstoned orphan GC followed by
  // the hash staleness sweep. Opt-in via the SKILL_MATCH_MAINTENANCE_CRON env
  // var (no schedule-row column, so no migration); the boot hook is a no-op
  // until the operator sets it.
  SKILL_MATCH_MAINTENANCE_TICK: "skill-match-maintenance-tick",
  // Chat-capture detection (cinatra #1367): one job per persisted chat USER
  // turn, enqueued fire-and-forget from the thread-persistence chokepoint
  // (upsertChatThreadInDatabase) with a deterministic per-(thread, turn)
  // jobId. The handler runs the two-stage detection pipeline (lexical
  // pre-filter → redaction → LLM classifier → distillation into the owner's
  // standalone chat-capture personal skill), idempotent + provenance-recorded
  // via the chat_capture_turns ledger. One-shot per enqueue (retries via the
  // enqueue-site attempts/backoff), NOT self-rescheduling.
  CHAT_CAPTURE_DETECTION: "chat-capture-detection",
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
  // Async LLM MEANING-matcher (cinatra#1891, epic #1883 A3).
  // Enqueued POST-COMMIT at TWO seams: (1) upload / non-agent creation
  // (`createSemanticArtifact` when `skipFallbackClassification` is false), and
  // (2) agent-emit materialization (`run-artifact-materializer`, after the
  // producer assertion has committed). Layers a MEANING draft (surfaced by the
  // presentation resolver) on top of the row's structural type — it never
  // mutates `objects.type`. NOT self-rescheduling — one-shot per artifact, with
  // attempts/backoff (`ARTIFACT_MATCH_RETRY_POLICY`) covering transient LLM/DB
  // failures the worker rethrows as `MatcherRetryableError`.
  ARTIFACT_MATCH_RUN: "artifact-match-run",
  // Post-terminal unbound agent-output derivation (cinatra#1893, epic #1883 A5).
  // ONE-SHOT per run, enqueued best-effort AFTER the terminal transition commits
  // the durable `agent_run_output_derivations` outbox row. Types the run's
  // captured final output against the agent's validated `produces` and
  // materializes it under the `derived_output` ledger path, or emits an advisory.
  // NOT self-rescheduling; the row lease makes a re-drive idempotent.
  UNBOUND_OUTPUT_DERIVE: "unbound-output-derive",
  // Reconciliation sweep for the unbound-output outbox (cinatra#1893). Self-
  // rescheduling ~5-min loop that drains `pending` outbox rows (and reclaims
  // expired `deriving` leases) whose one-shot enqueue was lost / crashed. The
  // backstop that guarantees eventual derivation of every captured output.
  UNBOUND_OUTPUT_DERIVE_SWEEP: "unbound-output-derive-sweep",
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
  // Schedule↔PM-task OUTBOUND-REPAIR reconcile (cinatra#318, part of #313).
  // Periodic ~10-min sweep over the agent_run_pm_links rows that failed /
  // never-synced and RE-PROJECTS the LOCAL trigger (source of truth) outward
  // via the existing host PM bridge — re-pushing errored/unsynced links and
  // finishing deferred deletes. Outbound-only: it never applies inbound PM
  // state to local schedules (the SDK PmConnector contract has no read-back,
  // and Plane stores only a day-granularity target_date). Every row warns-and-
  // skips, never throws (a PM outage must not poison the queue or alter local
  // schedules). See `@cinatra-ai/pm-schedule-reconcile`.
  PM_SCHEDULE_RECONCILE: "pm-schedule-reconcile",
  // Host-owned OUTBOUND webhook delivery (cinatra#341). ONE shared engine that
  // signs every outbound webhook via Standard-Webhooks (#340 `signOutbound`,
  // through the lib's `deliverOutbound` primitive) and retries with
  // exponential backoff, dead-lettering exhausted/permanent failures into
  // `webhook_outbound_dead_letter`. One-shot-per-enqueue (NOT self-
  // rescheduling): BullMQ's `attempts`/`backoff` (set at the enqueue site,
  // default attempts:5) drive the retries; the dispatcher arm THROWS on a
  // `retryable` result so BullMQ consumes an attempt, RETURNS on `delivered`,
  // and on `permanent` (or last-attempt `retryable`) writes the DLQ row.
  // Producers identify themselves by `eventKind`; identity-bearing material
  // (url + secret) is NEVER in the job payload — both are resolved INSIDE the
  // arm at each attempt (e.g. `assistant.mention` → readAssistantProfile) so
  // the secret never reaches Redis and url/secret can't drift.
  WEBHOOK_OUTBOUND_DELIVERY: "webhook-outbound-delivery",
  // Explicit content-addressed extension-store GC reaper (cinatra#796).
  // Daily self-rescheduling maintenance sweep enforcing the `current + 2`
  // per-{kind, slug} retention over the V2 runtime store via the lease-based
  // selector — NEVER boot-swept (boot only seeds this delayed loop job; boot
  // itself keeps the cheap integrity re-verify only). Also runnable on demand
  // through POST /api/admin/extensions/store-gc.
  EXTENSION_STORE_GC_REAP: "extension-store-gc-reap",
  // In-app extension auto-update loop (cinatra#1042). Daily self-rescheduling
  // sweep that reads the cached update read model for installed extensions,
  // filters candidates through the scope/ABI/signature-readiness gates, and
  // executes eligible updates through the SAME dispatch as a manual update
  // (planner/batch on the non-gatekept path) under a defined system Actor.
  // Master-flag gated: the boot phase seeds this loop ONLY when
  // CINATRA_EXTENSION_AUTO_UPDATE=true (default OFF — never scheduled).
  EXTENSION_AUTO_UPDATE: "extension-auto-update",
  // L1 environment-layer retention GC reaper (exec-plane S3 A3, cinatra#1708).
  // Daily self-rescheduling maintenance sweep that reaps zero-reference layers
  // past the retention window from the durable environment-layer store — NEVER
  // boot-swept (boot only seeds this delayed loop job). The reap protocol
  // (advisory-lock-serialized delete→commit→rmi) lives in the A2 execution
  // service, reached via the boot-registered DI slot; the handler no-ops when
  // the slot is not `ready`.
  ENVIRONMENT_LAYER_GC_REAP: "environment-layer-gc-reap",
} as const;

export type BackgroundJobName = (typeof BACKGROUND_JOB_NAMES)[keyof typeof BACKGROUND_JOB_NAMES];

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
/**
 * Canonical loop-job id for the PM schedule reconcile sweep (cinatra#318).
 * Same contract as `VENDOR_APPLICATION_STATE_RECONCILE_LOOP_JOB_ID`: the boot
 * seed (instrumentation.node.ts) creates the job under this id and the handler
 * re-delays THIS job via moveToDelayed each cycle; any other id is a legacy
 * anonymous duplicate that runs once WITHOUT rescheduling. Drift here re-
 * introduces the per-restart queue storm guarded by the perpetual-system-loops
 * CI gate.
 */
export const PM_SCHEDULE_RECONCILE_LOOP_JOB_ID = "pm-schedule-reconcile-loop";
/**
 * Canonical loop-job id for the extension-store GC reaper sweep (cinatra#796).
 * Same contract as the other loop ids above: the boot seed creates the job
 * under this id and the handler re-delays THIS job via moveToDelayed each
 * cycle; any other id is a legacy anonymous duplicate that runs once WITHOUT
 * rescheduling. Drift here re-introduces the per-restart queue storm guarded
 * by the perpetual-system-loops CI gate.
 */
export const EXTENSION_STORE_GC_REAP_LOOP_JOB_ID = "extension-store-gc-reap-loop";
/**
 * Canonical loop-job id for the extension auto-update sweep (cinatra#1042).
 * Same contract as the other loop ids above: the boot seed creates the job
 * under this id (ONLY when CINATRA_EXTENSION_AUTO_UPDATE=true — the loop is
 * default-OFF and never seeded otherwise) and the handler re-delays THIS job
 * via moveToDelayed each cycle; any other id is a legacy anonymous duplicate
 * that runs once WITHOUT rescheduling. Drift here re-introduces the
 * per-restart queue storm guarded by the perpetual-system-loops CI gate.
 */
export const EXTENSION_AUTO_UPDATE_LOOP_JOB_ID = "extension-auto-update-loop";
/**
 * Canonical loop-job id for the L1 environment-layer retention GC reaper sweep
 * (exec-plane S3 A3, cinatra#1708). Same contract as the other loop ids above:
 * the boot seed creates the job under this id and the handler re-delays THIS job
 * via moveToDelayed each cycle; any other id is a legacy anonymous duplicate
 * that runs once WITHOUT rescheduling. Drift here re-introduces the per-restart
 * queue storm guarded by the perpetual-system-loops CI gate.
 */
export const ENVIRONMENT_LAYER_GC_REAP_LOOP_JOB_ID = "environment-layer-gc-reap-loop";
/**
 * Canonical loop-job id for the unbound-output derivation reconciliation sweep
 * (cinatra#1893, epic #1883 A5). Same contract as the other loop ids above: the
 * boot seed creates the job under this id and the handler re-delays THIS job via
 * moveToDelayed each cycle; any other id is a legacy anonymous duplicate that
 * runs once WITHOUT rescheduling. Drift here re-introduces the per-restart queue
 * storm guarded by the perpetual-system-loops CI gate.
 */
export const UNBOUND_OUTPUT_DERIVE_SWEEP_LOOP_JOB_ID = "unbound-output-derive-sweep-loop";

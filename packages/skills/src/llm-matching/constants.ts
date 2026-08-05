/**
 * LLM-based skill matching constants.
 *
 * Single source of truth. Bumping any matcher version
 * (LLM_MATCHER_VERSION / RULE_MATCHER_VERSION) MUST be paired with the
 * appropriate snapshot updates (pricing snapshot for LLM, rule grammar
 * change rationale for rule).
 */

/**
 * v2 (setup-flow S6): the matcher became provider-neutral. Rows written by the
 * pinned-era evaluator (v1, hardwired gpt-4o-mini) carry no provider/model
 * provenance; without this bump they would persist invisibly as apparently
 * current. Refresh is lazy by default (staleness sweep where operators enabled
 * it); rule rows are unaffected (RULE_MATCHER_VERSION unchanged).
 */
export const LLM_MATCHER_VERSION = "llm-matcher-v2" as const;
export const RULE_MATCHER_VERSION = "rule-matcher-v1" as const;
export const MANUAL_VERSION = "manual-v1" as const;

/**
 * The ONLY model the cl100k pricing snapshot below prices. This is NOT a call
 * pin — evaluation runs on the frozen per-run context's provider/model (see
 * `SkillMatchRunContext`). It exists solely so the OpenAI batch dry-run cost
 * estimate can honestly answer "is this run priced?": a run context on any
 * other model/provider gets `estimatedUsd: null`, never a cl100k-priced
 * substitution and never $0.
 */
export const SKILL_MATCH_PRICED_MODEL = "gpt-4o-mini" as const;
export const SKILL_MATCH_PRICED_PROVIDER = "openai" as const;
export const SKILL_MATCH_MAX_PAIRS_PER_INLINE_EVENT = 200;
export const SKILL_MATCH_INLINE_CONCURRENCY = 4;
export const SKILL_MATCH_MAX_INPUT_TOKENS_PER_PAIR = 4000;
export const SKILL_MATCH_MAX_OUTPUT_TOKENS_PER_PAIR = 200;

/** Captured-at-snapshot pricing. Bumping LLM_MATCHER_VERSION requires updating this. */
export const SKILL_MATCH_PRICING_USD = {
  inputPer1MTokens: 0.150,
  outputPer1MTokens: 0.600,
  source: "openai-2026-05-pricing-snapshot",
  capturedAt: "2026-05-11",
} as const;

/** Maximum byte size for SKILL.md content used in hashing. */
export const SKILL_CONTENT_DIGEST_BYTES = 16384;

/** Maximum size of an error_message column write (4 KiB DB cap; raw LLM response slice is 1 KiB). */
export const SKILL_MATCH_ERROR_MESSAGE_MAX_BYTES = 4096;
export const SKILL_MATCH_RAW_RESPONSE_REDACT_BYTES = 1024;

/**
 * One in-call retry when `parseLlmResponse` returns `{ ok: false }` on the
 * first attempt. `gpt-4o-mini` with structured outputs occasionally emits
 * malformed JSON on long prompts (~1% per OpenAI internal eval); a single
 * retry recovers transient flakes without the matcher persisting a permanent
 * `status=error` row that an admin must clear by clicking "Re-evaluate".
 * A value of `0` disables the retry.
 */
export const SKILL_MATCH_RETRY_ON_SCHEMA_VIOLATION = 1;

/** BullMQ scheduler ID for the optional cron. */
export const SKILL_MATCH_BATCH_SCHEDULER_ID = "skill-match-batch-default" as const;

// ---------------------------------------------------------------------------
// Production drift sampler.
//
// A low-frequency BullMQ scheduler samples a small number of `skill_matches`
// rows per day, re-runs the LLM evaluator against each, and emits a
// structured `skill-match-drift` log event when the new decision differs
// from the persisted decision OR the score shifts by more than the delta
// threshold. The sampler is the production canary for OpenAI snapshot
// drift (`gpt-4o-mini` semantics shift between provider-side updates) and
// catches silent re-routing of skills before the next admin "Re-evaluate
// all" cycle.
//
// Disabled by default. Enabling it lives in a future admin surface
// (an MCP handler / settings toggle).
// ---------------------------------------------------------------------------

/** Number of `skill_matches` rows sampled per drift-sampler run. */
export const SKILL_MATCH_DRIFT_SAMPLE_SIZE = 5;

/**
 * Score-delta threshold above which a non-flipping difference is still
 * considered drift. Picked at 0.30 because the matcher's structured-output
 * schema bounds `score` to [0, 1] and small jitter within ±0.10 is expected
 * across LLM runs even with `temperature=0`. A 0.30 swing is large enough
 * to indicate a meaningful re-interpretation of the (agent, skill) pair.
 */
export const SKILL_MATCH_DRIFT_SCORE_DELTA_THRESHOLD = 0.30;

/**
 * Default cron pattern: `0 3 * * *` — 03:00 UTC daily. Picked deliberately
 * AFTER the typical batch-run window (which runs on operator schedule, often
 * during business hours) so the sampler does not collide with a fresh batch
 * write that re-evaluated the same row mid-day.
 */
export const SKILL_MATCH_DRIFT_DEFAULT_CRON = "0 3 * * *" as const;

/** BullMQ scheduler ID for the optional drift sampler cron (mirrors batch scheduler ID convention). */
export const SKILL_MATCH_DRIFT_SAMPLER_SCHEDULER_ID = "skill-match-drift-sampler" as const;

// ---------------------------------------------------------------------------
// Matching maintenance (staleness sweep + tombstoned orphan GC + drift flags).
//
// A single opt-in "maintenance tick" runs the deterministic staleness sweep
// (recompute the evaluator fingerprint for every persisted row and re-evaluate
// the ones whose inputs changed) followed by the tombstoned orphan GC (delete
// rows whose (agent, skill) pair has been durably absent from the live catalog
// for at least the grace window). It is registered only when the operator sets
// the SKILL_MATCH_MAINTENANCE_CRON env var (no DB column, so no migration); the
// boot hook is a no-op otherwise. See maintenance-boot.ts.
// ---------------------------------------------------------------------------

/**
 * Grace window for the tombstoned orphan GC. A (agent, skill) row is deleted
 * only after its pair has been observed ABSENT from the live catalog for at
 * least this long — never on a single transient catalog snapshot. Chosen at
 * 24h so a pair must survive absence across at least two daily maintenance
 * ticks (or ~24 hourly ticks) before deletion. The conditional
 * compare-and-delete additionally refuses to delete any row rewritten within
 * the window, so a reinstall inside the grace period is never GC'd.
 */
export const SKILL_MATCH_ORPHAN_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Cumulative drift-observation count at or above which a (agent, skill) pair is
 * auto-flagged as "repeatedly drifting". The counter is keyed to the pair's
 * fingerprint (agent/skill input hashes + evaluator version); when those change
 * the count RESETS, because a fingerprint change is a legitimate re-evaluation,
 * not model drift on stable inputs.
 */
export const SKILL_MATCH_DRIFT_FLAG_THRESHOLD = 3;

/** BullMQ scheduler ID for the optional matching-maintenance tick cron. */
export const SKILL_MATCH_MAINTENANCE_SCHEDULER_ID = "skill-match-maintenance-tick" as const;

/** Env var carrying the optional maintenance-tick cron pattern (unset = disabled). */
export const SKILL_MATCH_MAINTENANCE_CRON_ENV = "SKILL_MATCH_MAINTENANCE_CRON" as const;

// ---------------------------------------------------------------------------
// Persisted batch-run status vocabulary, single source of truth.
//
// Historically these were the OpenAI Batch API literals verbatim. With the
// provider-neutral pipeline (setup-flow S6) the PERSISTED vocabulary is kept
// stable — existing rows, the status panel, and the partial index keep their
// meaning — and provider states are MAPPED onto it at the poll seam:
//
//   neutral batch-v2 `in_progress` → `in_progress`
//   neutral batch-v2 `canceling`   → `cancelling`
//   neutral batch-v2 `ended`       → `completed`
//   neutral batch-v2 `failed`      → `failed`
//
// `completed` means "processing ended and per-request outcomes were
// retrievable" (surfaced as "Finished" in the UI) — NOT "every request
// succeeded": a finished run can carry a mix of ok / errored / canceled /
// expired per-request outcomes, which land as normalized result rows.
//
// The legacy OpenAI literals (`validating`, `finalizing`, `expired`,
// `cancelled`) remain in the sets so rows persisted by the v1 pipeline keep
// classifying correctly.
//
// Centralizing here makes the contract explicit, lets the disjoint+complete
// invariant be unit-tested, and gives a single edit site when a state is added.
// ---------------------------------------------------------------------------

/** In-flight persisted statuses (mid-execution; should keep polling). */
export const BATCH_STATUS_IN_FLIGHT = new Set<string>([
  "validating",
  "in_progress",
  "finalizing",
  // Cancellation initiated but processing not yet ended. Present in the
  // adapter contract; previously missing here, so a cancelling batch was
  // treated as terminal by the poll loop and never observed its end.
  "cancelling",
]);

/** Terminal persisted statuses (chain done; stop polling). */
export const BATCH_STATUS_TERMINAL = new Set<string>([
  "completed",
  "cancelled",
  "failed",
  "expired",
]);

/**
 * Union of all known persisted statuses (in-flight + terminal). New states
 * must be added here AND to one of the two subsets above; the `batch-status`
 * unit test enforces both disjointness and completeness.
 */
export const BATCH_STATUS_ALL = new Set<string>([
  ...BATCH_STATUS_IN_FLIGHT,
  ...BATCH_STATUS_TERMINAL,
]);

/**
 * Map a neutral batch-v2 lifecycle status onto the PERSISTED vocabulary above.
 * Unknown inputs pass through verbatim (fail-open into the panel's "unknown =
 * keep polling" stance rather than inventing a terminal state).
 *
 * INVARIANT AT THE CALL SITES: a provider-batch run with an outstanding
 * submission manifest is never PERSISTED terminal — `"ended"` maps to
 * `"completed"`, but only the poll handler writes that, and only AFTER
 * `processBatchResults` has durably applied the outcomes. Submit clamps an
 * ended-at-submit report to the in-flight `"finalizing"` literal, and cancel
 * persists `"cancelling"` for an ended-at-cancel report, so the poll chain
 * drains the outcomes in every case.
 */
export function mapBatchV2StatusToPersisted(status: string): string {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "canceling":
      return "cancelling";
    case "ended":
      return "completed";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Synchronous full-catalog fan-out (capability routing, setup-flow S6).
//
// Providers whose adapter declares no batch surface run "Re-evaluate all" as a
// chunked synchronous fan-out over the frozen submission manifest. Runs are
// persisted in `skill_match_batch_runs` with a `sync-` batch-id prefix so the
// status panel and cancel semantics are shared with the batch path.
// ---------------------------------------------------------------------------

/** Batch-id prefix identifying a synchronous fan-out run. */
export const SKILL_MATCH_SYNC_RUN_PREFIX = "sync-" as const;

/** Pairs evaluated per synchronous chunk job (progress + cancel granularity). */
export const SKILL_MATCH_SYNC_RUN_CHUNK_SIZE = 25;

// ---------------------------------------------------------------------------
// Retry topology (failure taxonomy, setup-flow S6). Fixed per path:
//
//   - inline fan-out + continuations: 3 attempts, 30s exponential backoff —
//     an invocation/resolution throw RETHROWS out of the handler so BullMQ
//     retries the (idempotent) window; parse failures stay terminal error rows.
//   - sync-run chunks: 3 attempts, 30s exponential backoff (same rationale).
//   - batch poll: 1 attempt — the poll chain self-reschedules every 30s, which
//     IS its retry topology; BullMQ-level retries would double the chain.
//   - drift sample + maintenance tick: 1 attempt — both are periodic
//     schedulers; the next tick is the retry.
// ---------------------------------------------------------------------------

export const SKILL_MATCH_INLINE_JOB_ATTEMPTS = 3;
export const SKILL_MATCH_SYNC_CHUNK_JOB_ATTEMPTS = 3;
/**
 * Provider-batch poll jobs get bounded BullMQ retries too: a transient
 * retrieve/download failure must not kill the self-rescheduling chain (the
 * chain re-enqueue is the cadence, BullMQ attempts are the per-poll flake
 * shield). Exhaustion is handled by `handleBatchPollExhausted`.
 */
export const SKILL_MATCH_POLL_JOB_ATTEMPTS = 3;
export const SKILL_MATCH_JOB_BACKOFF_MS = 30_000;

/**
 * LLM-based skill matching constants.
 *
 * Single source of truth. Bumping any matcher version
 * (LLM_MATCHER_VERSION / RULE_MATCHER_VERSION) MUST be paired with the
 * appropriate snapshot updates (pricing snapshot for LLM, rule grammar
 * change rationale for rule).
 */

export const LLM_MATCHER_VERSION = "llm-matcher-v1" as const;
export const RULE_MATCHER_VERSION = "rule-matcher-v1" as const;
export const MANUAL_VERSION = "manual-v1" as const;

export const SKILL_MATCH_MODEL = "gpt-4o-mini" as const;
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
// OpenAI Batch API status enum, single source of truth.
//
// The OpenAI Batch API surfaces the following statuses (per OpenAI's docs):
//   - in-flight:  validating, in_progress, finalizing
//   - terminal:   completed, cancelled, failed, expired
//
// Two divergent sets lived in the codebase:
//   - jobs.ts          -> TERMINAL_STATUSES = { completed, failed, expired, cancelled }
//   - _matches-status-panel.tsx -> IN_FLIGHT_STATUSES = { validating, in_progress, finalizing }
// They covered the same enum from opposite sides; a new OpenAI status (e.g. an
// `awaiting_quota` intermediate) would be silently classified as terminal by
// the panel (stopping the poll loop) AND non-terminal by jobs.ts (rescheduling
// forever) — a split that's invisible until the status panel goes quiet on a
// live batch.
//
// Centralizing here makes the contract explicit, lets the disjoint+complete
// invariant be unit-tested, and gives a single edit site when OpenAI adds a
// new state.
// ---------------------------------------------------------------------------

/** OpenAI Batch API in-flight statuses (mid-execution; should keep polling). */
export const BATCH_STATUS_IN_FLIGHT = new Set<string>([
  "validating",
  "in_progress",
  "finalizing",
]);

/** OpenAI Batch API terminal statuses (chain done; stop polling). */
export const BATCH_STATUS_TERMINAL = new Set<string>([
  "completed",
  "cancelled",
  "failed",
  "expired",
]);

/**
 * Union of all known OpenAI Batch API statuses (in-flight + terminal). New
 * states from OpenAI should be added here AND to one of the two subsets above;
 * the `batch-status` unit test enforces both disjointness and completeness.
 */
export const BATCH_STATUS_ALL = new Set<string>([
  ...BATCH_STATUS_IN_FLIGHT,
  ...BATCH_STATUS_TERMINAL,
]);

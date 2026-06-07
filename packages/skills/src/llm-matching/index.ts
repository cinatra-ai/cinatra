/**
 * Public surface of the shared skill-matching evaluator core.
 *
 * Consumed by:
 *   - BullMQ jobs (inline + batch transports)
 *   - MCP handlers (`skills_match_evaluate_pair`)
 *   - matcher reader code
 */

export * from "./constants";
export * from "./types";
export * from "./hashes";
export * from "./prompt-builder";
export * from "./response-parser";
export * from "./rationale-grounding";
export * from "./cost-estimate";
export * from "./upsert";
export * from "./rule-short-circuit";
export * from "./match-when-parser";
export * from "./evaluate-pair";
// Shared adapters used by jobs.ts and handlers.ts to ensure the inline, batch,
// and admin re-evaluate paths all compute the same SkillForMatching shape
// (same matchWhenRaw, same skillInputHash).
export * from "./adapters";
export * as skillMatchesStore from "./skill-matches-store";

// Visibility predicate for skill matching.
export * from "./visibility";

// Cron expression validator used by both the schedule-store
// (defense-in-depth) and the MCP handler (clean error code).
export * from "./cron-validate";

// Schedule + batch-runs persistence + boot-time scheduler.
export * from "./schedule-store";
export * from "./batch-runs-store";
export { registerSkillMatchScheduleAtBoot, unregisterSkillMatchSchedule } from "./schedule-boot";
// Boot-time registration of the optional drift sampler scheduler. Mirrors the
// batch scheduler boot above but checks the `drift_sampler_enabled` flag on the
// schedule row.
export {
  registerSkillMatchDriftSamplerAtBoot,
  unregisterSkillMatchDriftSampler,
} from "./drift-sampler-boot";

// Event hooks called from skills + agents MCP handlers.
export {
  enqueueInlineForSkill,
  enqueueInlineForAgent,
  cleanupForSkill,
  cleanupForAgent,
} from "./event-hooks";

// BullMQ job handlers dispatched from src/lib/background-jobs.ts.
export {
  handleInlineForSkill,
  handleInlineForAgent,
  handleBatchSubmit,
  handleBatchPoll,
} from "./jobs";

// Production drift sampler. Job handler dispatched from
// src/lib/background-jobs.ts via the SKILL_MATCH_DRIFT_SAMPLE BullMQ job name;
// boot-time scheduler registration in `drift-sampler-boot.ts`. Disabled by
// default; see the `drift_sampler_enabled` column on the
// `skill_match_schedule` row.
export {
  handleDriftSample,
  type DriftSampleDeps,
  type DriftSampleResult,
  type DriftSampleRowDiff,
} from "./drift-sampler";

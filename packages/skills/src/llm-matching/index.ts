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
  // Combined opt-in match-store scheduler registration (drift + maintenance),
  // called from the host boot's single drift-sampler boot site.
  registerSkillMatchSchedulersAtBoot,
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
  // Matching maintenance (cinatra #1365 / S7): the combined tick handler and the
  // drift-flag recorder are COLOCATED in drift-sampler.ts (same match-store
  // maintenance domain / imports), so they stay off the barrel's own extra
  // module surface. handleMaintenanceTick is dispatched from
  // src/lib/background-jobs-registry.ts via the SKILL_MATCH_MAINTENANCE_TICK job;
  // recordDriftObservations is injected into the drift sampler there.
  handleMaintenanceTick,
  recordDriftObservations,
  // Maintenance KV (connector_config blobs) — colocated in drift-sampler.ts so
  // the size-ratcheted src/lib/database.ts does not grow. Injected into the
  // maintenance deps at the dispatch site.
  readSkillMatchOrphanTombstones,
  writeSkillMatchOrphanTombstones,
  readSkillMatchDriftFlags,
  writeSkillMatchDriftFlags,
  clearSkillMatchDriftFlagsForPairKeys,
  readSkillMatchManualStale,
  writeSkillMatchManualStale,
} from "./drift-sampler";

// Opt-in maintenance-tick boot registration (colocated in drift-sampler-boot.ts;
// gated by the SKILL_MATCH_MAINTENANCE_CRON env var, so it ships without a DB
// migration).
export {
  registerSkillMatchMaintenanceAtBoot,
  unregisterSkillMatchMaintenance,
  resolveMaintenanceCron,
} from "./drift-sampler-boot";

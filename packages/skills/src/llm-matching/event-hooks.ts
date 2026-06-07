import "server-only";

/**
 * Idempotent enqueue helpers and cleanup hooks.
 *
 * The MCP install / upsert / agent_save / extension-uninstall handlers call
 * the enqueue helpers exported here. BullMQ deduplicates pending jobs by
 * `jobId`, so a reinstall storm of the same skill (or a flurry of agent
 * saves) coalesces into a single inline-evaluation job per skill / per
 * agent.
 *
 * Job IDs use a sha256(skillId|agentId) prefix. Skill IDs and agent
 * packageIds may contain `:` / `@` / `/` punctuation that BullMQ tolerates
 * today, but a hash makes the contract explicit and resilient.
 *
 * Cleanup hooks purge `skill_matches` rows on extension uninstall and agent
 * delete. They wrap the per-table delete helpers from skill-matches-store
 * and exist here so MCP handlers depend on a single stable surface
 * (`@cinatra-ai/skills` barrel) rather than reaching into the llm-matching
 * submodule.
 */

import { createHash } from "node:crypto";
import { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
import { LLM_MATCHER_VERSION } from "./constants";
import {
  deleteSkillMatchesForSkill,
  deleteSkillMatchesForAgent,
} from "./skill-matches-store";

function hashId(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 16);
}

/**
 * Enqueue a SKILL_MATCH_INLINE_FOR_SKILL job for a single skill. Idempotent
 * by `jobId` while pending — repeated calls within a short window collapse
 * into a single execution (BullMQ HSETNX semantics).
 */
export async function enqueueInlineForSkill(skillId: string): Promise<void> {
  const jobId = `skill-match-inline-for-skill-${hashId(skillId)}-${LLM_MATCHER_VERSION}`;
  const jobStartedAt = new Date().toISOString();
  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_SKILL,
    { skillId, jobStartedAt },
    { jobId },
  );
}

/**
 * Enqueue a SKILL_MATCH_INLINE_FOR_AGENT job for a single agent. Idempotent
 * by `jobId` while pending.
 */
export async function enqueueInlineForAgent(agentId: string): Promise<void> {
  const jobId = `skill-match-inline-for-agent-${hashId(agentId)}-${LLM_MATCHER_VERSION}`;
  const jobStartedAt = new Date().toISOString();
  await enqueueBackgroundJob(
    BACKGROUND_JOB_NAMES.SKILL_MATCH_INLINE_FOR_AGENT,
    { agentId, jobStartedAt },
    { jobId },
  );
}

/**
 * Purge `skill_matches` rows for an uninstalled skill. Intentionally
 * synchronous (called inline from the uninstall handler). Idempotent: a
 * second call simply deletes zero rows.
 */
export async function cleanupForSkill(skillId: string): Promise<void> {
  await deleteSkillMatchesForSkill(skillId);
}

/**
 * Purge `skill_matches` rows for a deleted agent.
 */
export async function cleanupForAgent(agentId: string): Promise<void> {
  await deleteSkillMatchesForAgent(agentId);
}

import "server-only";

/**
 * Autosaves run prompts after successful completion.
 *
 * MUST be called only after a successful transitionRunStatus(..., "completed", ...).
 * The CALLER (handleWayflowTaskState in execution.ts) MUST wrap this call in
 * `.catch(e => console.warn(...))` so any failure cannot block the downstream
 * RUN_FINISHED publish. This side effect is best-effort and must not affect
 * run completion.
 *
 * Internal contract:
 *   - Exits as no-op when readSkillAutosaveConfig().enabled === false.
 *   - Exits as no-op when no non-excluded prompts exist for the run.
 *   - Exits as no-op when readSkillAutosaveConfig() throws (degrade-to-noop).
 *   - Exits as no-op when readNonExcludedAgentIdsForRun() throws (degrade-to-noop).
 *   - For each distinct agent_id with prompts, calls createOrUpdateCustomSkillForAgent
 *     once, sequentially (for..of with await — LLM cost gating; no concurrent fan-out).
 *   - Per-agent failures are logged as warn but do not abort the loop.
 *   - Always resolves to void; never throws upward.
 */
import { readSkillAutosaveConfig } from "@/lib/skill-autosave";
import { resolveUserContextForUserId } from "@/lib/auth-session";
import {
  createOrUpdateCustomSkillForAgent,
  buildDefaultPersonalSkillName,
  listCustomSkillsForCurrentUserAndAgent,
} from "@cinatra-ai/skills";
import {
  readAgentRunById,
  readAgentTemplateByPackageName,
  readHitlPromptsForRun,
  readNonExcludedAgentIdsForRun,
} from "./store";

export async function runSkillAutosaveOnRunCompletion(runId: string): Promise<void> {
  if (!runId) return;

  // Synchronous flag read (degrade-to-noop on any throw).
  // readSkillAutosaveConfig() is SYNCHRONOUS — it reads connector_config via
  // the synchronous pg layer (postgres-sync.ts). Do not await it.
  let cfg: { enabled: boolean };
  try {
    cfg = readSkillAutosaveConfig();
  } catch (err) {
    console.warn(`[skill-autosave] config read failed run=${runId}`, err);
    return;
  }

  // Disabled-state must short-circuit before any DB read so it has zero cost.
  if (!cfg.enabled) return;

  // Distinct agent_id fan-out set.
  // Wrap in try/catch because this helper must never throw upward.
  let agentIds: string[];
  try {
    agentIds = await readNonExcludedAgentIdsForRun(runId);
  } catch (err) {
    console.warn(`[skill-autosave] failed to read agent IDs, run=${runId}`, err);
    return;
  }
  if (agentIds.length === 0) return;

  // Best-effort run metadata read, used for the skill-name campaign label and
  // to anchor project-grant resolution.
  //
  // The narrowing includes `orgId` so the background
  // `resolveUserContextForUserId` call below can pass
  // `{ activeOrganizationId: run.orgId }`. Without it, the resolver would
  // fall back to an arbitrary session/default org (auth-session.ts:263)
  // producing wrong project-scoped reads. When `run.orgId` is unavailable
  // (e.g. legacy NULL row), `resolveUserContextForUserId` FAILS CLOSED for
  // Sources 2+3 (returns only Source 1 owned; no access/co-owner grants).
  let run: {
    id: string;
    title?: string | null;
    runBy?: string | null;
    orgId?: string | null;
  } | null = null;
  try {
    run = await readAgentRunById(runId);
  } catch (err) {
    console.warn(`[skill-autosave] readAgentRunById failed run=${runId}`, err);
  }

  // Per-agent persist pipeline (sequential — LLM cost gating).
  for (const agentId of agentIds) {
    try {
      const prompts = await readHitlPromptsForRun(runId, agentId);
      if (prompts.length === 0) continue; // defensive — DISTINCT race

      const template = await readAgentTemplateByPackageName(agentId);
      const promptEntries = prompts.map((p) => ({
        id: p.id,
        kind: "initial" as const,
        prompt: p.message,
        savedAt: p.capturedAt.toISOString(),
      }));
      const skillName = buildDefaultPersonalSkillName({
        campaignName: run?.title ?? template?.name ?? agentId,
        sourceLabel: "HITL autosave",
      });

      // Thread runRecord.runBy as userId so each user owns their own personal
      // skills. When runBy is null (e.g., scheduler-triggered runs) we cannot
      // attribute the skill safely — skip rather than write under the legacy
      // single-user constant. A future actor context snapshot may carry
      // "system" attribution.
      const ownerUserId = run?.runBy ?? null;
      if (!ownerUserId) {
        console.warn(
          `[skill-autosave] run has no runBy; skipping personal-skill upsert run=${runId} agent=${agentId}`,
        );
        continue;
      }

      const existing = await listCustomSkillsForCurrentUserAndAgent(agentId, ownerUserId);
      const existingSkillId = existing[0]?.id;

      // The autosave job runs in the background without a live session. Build
      // the actor from the stored runBy userId so the matched-skill catalog read
      // inside createOrUpdateCustomSkillForAgent is gated by requireResourceAccess.
      // Without this, admin-hidden `system` skill content leaks into the LLM
      // generation prompt and the persisted `basedOnSkillIds`.
      // Pass `run.orgId` so project-grant resolution anchors on the run's org,
      // not an arbitrary session/default-org fallback. When run.orgId is
      // unavailable the resolver fails closed for Sources 2+3 (only Source 1 /
      // owned grants remain).
      const { actorContext: actor } = await resolveUserContextForUserId(
        ownerUserId,
        run?.orgId
          ? { activeOrganizationId: run.orgId }
          : undefined,
      );

      const persisted = await createOrUpdateCustomSkillForAgent({
        agentId,
        promptEntries,
        skillName,
        existingSkillId,
        userId: ownerUserId,
        actor,
      });
      console.log(
        `[skill-autosave] saved personal skill run=${runId} agent=${agentId} skillId=${persisted.id}`,
      );
    } catch (err) {
      // Per-agent failure does NOT abort the loop — the next distinct agentId
      // gets its own attempt. Log + continue.
      console.warn(
        `[skill-autosave] generation failed run=${runId} agent=${agentId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

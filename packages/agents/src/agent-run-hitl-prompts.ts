// ---------------------------------------------------------------------------
// agent_run_hitl_prompts — WayFlow HITL prompt capture
// ---------------------------------------------------------------------------
//
// The agent_run_hitl_prompts persistence seam — capture a WayFlow HITL
// amendment prompt (writeHitlPrompt), the excluded-flag mutators (single-id
// updateHitlPromptExcluded + the run/agent-scoped batch
// updateHitlPromptsExcludedForRunAgent, #1794), and the run-scoped readers the
// autosave path uses (readHitlPromptsForRun / readAllHitlPromptsForRun /
// readNonExcludedAgentIdsForRun). Extracted VERBATIM from
// packages/agents/src/store.ts (file-size ratchet: store.ts is a tracked
// architecture bottleneck that exceeded its ceiling after #1803 added
// updateHitlPromptsExcludedForRunAgent inline). ./store re-exports every symbol
// below, so every existing `from "./store"` / `@cinatra-ai/agents` consumer —
// and every vi.mock("./store") double — is unchanged.
//
// NOTE for the route-graph ratchet: this module is reachable wherever ./store
// is (the re-export edge), but it pulls NO new first-party subtree — its only
// first-party imports (db from ./db, agentRunHitlPrompts from ./schema) are
// already reachable from ./store; drizzle-orm + node:crypto are external
// cut-points. So it adds exactly itself (+1 module) to each route reaching
// ./store, exactly like ./template-snapshot and ./run-status.
// ---------------------------------------------------------------------------

import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db";
import { agentRunHitlPrompts } from "./schema";

export type WriteHitlPromptInput = {
  runId: string;
  agentId: string;
  stepKey: string;
  message: string;
  submittedValues?: Record<string, unknown> | null;   //
  schemaSnapshot?: Record<string, unknown> | null;
  excluded?: boolean;                                  // Pattern 4(b): bare-approval rows pass true so autosave skips them
};

export async function writeHitlPrompt(input: WriteHitlPromptInput): Promise<void> {
  if (input.message.length > 32_768) {
    throw new Error(`[writeHitlPrompt] message too large (${input.message.length} chars)`);
  }
  if (input.schemaSnapshot !== null && input.schemaSnapshot !== undefined) {
    const snap = JSON.stringify(input.schemaSnapshot);
    if (snap.length > 32_768) {
      console.warn(
        `[writeHitlPrompt] schemaSnapshot too large (${snap.length} bytes), storing null`,
      );
      input = { ...input, schemaSnapshot: null };
    }
  }
  await db.insert(agentRunHitlPrompts).values({
    id: randomUUID(),
    runId: input.runId,
    agentId: input.agentId,
    stepKey: input.stepKey,
    message: input.message,
    submittedValues: input.submittedValues ?? null,   //
    schemaSnapshot: input.schemaSnapshot ?? null,
    excluded: input.excluded ?? false,                //
  });
}

export type HitlPromptRecord = {
  id: string;
  runId: string;
  agentId: string;
  stepKey: string;
  message: string;
  capturedAt: Date;
  excluded: boolean;
  submittedValues: Record<string, unknown> | null;   //
  schemaSnapshot: Record<string, unknown> | null;
};

/**
 * Reads all non-excluded HITL amendment prompts for a run, scoped to a specific agent.
 *
 * @param runId   - The agent_runs.id of the run.
 * @param agentId - The template's `packageName` (e.g. "@cinatra-ai/email-outreach-agent").
 *                  Must match the value stored at write time via writeHitlPrompt.
 */
export async function updateHitlPromptExcluded(id: string, excluded: boolean): Promise<void> {
  await db
    .update(agentRunHitlPrompts)
    .set({ excluded })
    .where(eq(agentRunHitlPrompts.id, id));
}

export async function readHitlPromptsForRun(
  runId: string,
  agentId: string,
): Promise<HitlPromptRecord[]> {
  return db
    .select()
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
        eq(agentRunHitlPrompts.excluded, false),
      ),
    )
    .orderBy(agentRunHitlPrompts.capturedAt);
}

// ---------------------------------------------------------------------------
// sibling read: NO excluded filter. Submission-map builder needs
// every gate row in capture order so row-order alignment with approvalPolicy
// gates survives Pattern 4(b) (bare-approval rows flagged excluded=true).
// readHitlPromptsForRun (excluded=false filter) stays unchanged for autosave.
// ---------------------------------------------------------------------------
export async function readAllHitlPromptsForRun(
  runId: string,
  agentId: string,
): Promise<HitlPromptRecord[]> {
  return db
    .select()
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
      ),
    )
    .orderBy(agentRunHitlPrompts.capturedAt);
}

// ---------------------------------------------------------------------------
// Run + agent-scoped batch exclusion (#1794).
//
// The single-id `updateHitlPromptExcluded` mutates by prompt id ALONE with no
// run/agent predicate — safe for the internal autosave caller (it only ever
// passes ids it just read for a run+agent), but NOT a safe primitive surface.
// This scoped batch variant carries the run + declaring-agent predicate INTO
// the WHERE clause as defense-in-depth: a row is touched only when it belongs
// to BOTH the given run AND the given agent package, so a caller can never
// mutate another run's or another agent's prompt even if a stale/foreign id
// slips past the handler's own membership check. Idempotent by construction
// (`SET excluded = <value>` is a no-op when the row already holds it). Returns
// the ids actually matched (== touched), so the caller can report applied vs
// requested and detect a silent scope miss.
// ---------------------------------------------------------------------------
export async function updateHitlPromptsExcludedForRunAgent(
  runId: string,
  agentId: string,
  ids: string[],
  excluded: boolean,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(agentRunHitlPrompts)
    .set({ excluded })
    .where(
      and(
        inArray(agentRunHitlPrompts.id, ids),
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.agentId, agentId),
      ),
    )
    .returning({ id: agentRunHitlPrompts.id });
  return rows.map((r) => r.id);
}

/**
 * returns the distinct set of agent_id values for a run's
 * non-excluded captured HITL prompts. Used by the autosave-on-completion path
 * (`runSkillAutosaveOnRunCompletion` in `./skill-autosave`) to fan out one
 * personal-skill generation per distinct leaf agent.
 *
 * v1 "distinct leaf" semantics: distinct values of `agent_id` as captured
 * by `writeHitlPrompt`. For flat WayFlow runs this is one value (the run's
 * own template.packageName). For composed orchestrator runs the captured
 * agent_id is whatever the paused run's template.packageName was at gate
   * time, preserving distinct child-agent capture.
 *
 * @param runId - The agent_runs.id of the run.
 * @returns      Distinct agent_id values, ordered ascending. Empty array if none.
 */
export async function readNonExcludedAgentIdsForRun(runId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentId: agentRunHitlPrompts.agentId })
    .from(agentRunHitlPrompts)
    .where(
      and(
        eq(agentRunHitlPrompts.runId, runId),
        eq(agentRunHitlPrompts.excluded, false),
      ),
    );
  return rows.map((r) => r.agentId).sort();
}

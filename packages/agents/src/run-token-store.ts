import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns, agentRunTokens } from "./schema";

// NO PRUNING — deliberately. Two designs were tried and both could evict a
// credential whose leg was still executing, which is the exact stranding this
// table exists to prevent:
//
//   - a per-run COUNT cap prunes on cardinality, which says nothing about
//     liveness (and recorded-but-unused credentials from a resume that threw
//     before its send consume slots no leg holds);
//   - an AGE cap derived from `WAYFLOW_A2A_TIMEOUT_MS` assumed that ceiling
//     terminates server-side execution. It does not: the timeout is a CLIENT
//     AbortSignal on the HTTP call, while the container's worker awaits
//     `conversation.execute_async()` with no wall-clock bound, a flow can chain
//     several ApiNodes each with their own ceiling, an accepted task can sit
//     queued before the worker starts, and `created_at` is the DATABASE clock
//     while any cutoff would be computed from the APP clock.
//
// Retiring a credential therefore requires real per-leg terminal state, which
// this table does not carry. Until it does, the safe posture is to keep every
// credential: a stale row can only ever resolve to the run it was minted for,
// whereas a wrongly-pruned row 403s a live callback. Growth is one small row
// (hash, run id, timestamp) per leg, i.e. per HITL gate of a run.

/**
 * #1193 run-token spine: record a freshly-minted per-run credential.
 *
 * ADDITIVE by design. `agent_runs.run_token_hash` is updated to the CURRENT
 * leg's hash (it is what `readAgentRunTokenHashById` hands the #1195 durable
 * binding writer), and the hash is ALSO inserted into `agent_run_tokens`, which
 * holds every credential still honored for the run. Rotation therefore never
 * invalidates an earlier leg that may still be executing — the failure this
 * prevents is a 403 on a live context/LLM callback after a concurrent or
 * redelivered resume.
 *
 * Both writes ride ONE transaction: a half-applied rotation would either carry a
 * token the verifier cannot resolve (insert lost) or leave the durable-binding
 * writer pointing at a stale leg (update lost).
 *
 * Fails closed — a silent no-op would let a dispatch or resume carry a credential
 * whose hash was never stored.
 */
export async function setAgentRunTokenHash(
  runId: string,
  tokenHash: string,
): Promise<void> {
  if (!runId || !tokenHash) {
    throw new Error(
      "setAgentRunTokenHash requires a non-empty runId and tokenHash.",
    );
  }
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(agentRuns)
      .set({ runTokenHash: tokenHash })
      .where(eq(agentRuns.id, runId))
      .returning({ id: agentRuns.id });
    if (updated.length !== 1) {
      throw new Error(
        `setAgentRunTokenHash: expected to update exactly one run, updated ${updated.length} (runId=${runId}).`,
      );
    }
    // The freshly-minted hash is random, so a conflict is not reachable in
    // practice; DO NOTHING keeps a retry of the SAME mint idempotent rather than
    // failing the dispatch/resume.
    await tx
      .insert(agentRunTokens)
      .values({ tokenHash, runId })
      .onConflictDoNothing();
  });
}

/**
 * #1193 run-token spine: THE lookup backing the run-token verifier.
 *
 * A single PRIMARY-KEY probe on `agent_run_tokens.token_hash` joined to the run
 * — at most one run or null, no newest-wins tie-break, no body fallback. Returns
 * ONLY {id, orgId, runBy}; the hash is never surfaced.
 *
 * Resolving through the credential SET (not `agent_runs.run_token_hash`) is what
 * lets an in-flight earlier leg keep authenticating across a resume rotation.
 */
export async function readAgentRunByTokenHash(
  tokenHash: string,
): Promise<{ id: string; orgId: string; runBy: string | null } | null> {
  if (!tokenHash) return null;
  const [row] = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId, runBy: agentRuns.runBy })
    .from(agentRunTokens)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunTokens.runId))
    .where(eq(agentRunTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

/**
 * #1195 durable run-context binding: narrow bridge-internal read of a run's
 * CURRENT credential hash BY RUN ID — used ONLY by /api/llm-bridge to key the
 * durable MCP run-context binding to the run credential (which the MCP reader
 * then resolves back through `readAgentRunByTokenHash` above, keeping the run
 * row the single source of truth). The general `AgentRunRecord` read path
 * deliberately continues to never expose the hash; do not widen this into a
 * general accessor. Null for a run without a dispatch-minted credential.
 *
 * Reads the run row's CURRENT-leg pointer on purpose: a binding written now
 * should name the credential of the leg doing the writing. An earlier leg's
 * credential stays resolvable through `agent_run_tokens` regardless.
 */
export async function readAgentRunTokenHashById(
  runId: string,
): Promise<string | null> {
  if (!runId) return null;
  const [row] = await db
    .select({ runTokenHash: agentRuns.runTokenHash })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.runTokenHash ?? null;
}

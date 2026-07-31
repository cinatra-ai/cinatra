import { and, eq, lt } from "drizzle-orm";
import { db } from "./db";
import { agentRuns, agentRunTokens } from "./schema";
import { WAYFLOW_A2A_TIMEOUT_MS } from "./wayflow-url";

/**
 * How long a credential stays honored after it was minted, in milliseconds.
 *
 * Retirement is by AGE, deliberately NOT by count. A count cap prunes on
 * cardinality, which carries no information about whether a leg is still
 * running: with enough concurrent or retried legs it evicts a credential whose
 * task is mid-flight, and the next callback from that live task 403s — exactly
 * the stranding this table exists to prevent. Recorded-but-unused credentials
 * (a resume that persisted its hash and then threw before `sendTask` was
 * accepted) would make that worse, since they consume cap slots while no leg
 * holds them.
 *
 * An age bound derived from the transport's own ceiling cannot make that
 * mistake. `WAYFLOW_A2A_TIMEOUT_MS` (24h) is the maximum lifetime of a single
 * blocking A2A task, so a credential older than that ceiling CANNOT belong to a
 * leg that is still executing. The 2x margin absorbs clock skew and the gap
 * between minting and the send actually starting.
 *
 * Growth is bounded by "legs a single run can start within the window", which
 * for a real flow is its gate count; each row is a hash, a run id and a
 * timestamp.
 */
export const AGENT_RUN_TOKEN_RETENTION_MS = 2 * WAYFLOW_A2A_TIMEOUT_MS;

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
    // Retire credentials older than the transport's own maximum task lifetime.
    // Age-based, never count-based: a credential older than the A2A ceiling
    // cannot belong to a leg that is still executing, so this can never evict a
    // live one. Scoped to THIS run, and it deliberately never touches the row
    // just inserted. Piggy-backing on the mint keeps it self-cleaning with no
    // sweep job.
    await tx
      .delete(agentRunTokens)
      .where(
        and(
          eq(agentRunTokens.runId, runId),
          lt(
            agentRunTokens.createdAt,
            new Date(Date.now() - AGENT_RUN_TOKEN_RETENTION_MS),
          ),
        ),
      );
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

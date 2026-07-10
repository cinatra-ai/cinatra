import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns } from "./schema";

/**
 * #1193 run-token spine: persist the sha256 hash of the dispatch-minted per-run
 * credential. Dispatcher-only (execution.ts, BEFORE the blocking sendTask); only
 * the hash is stored. Partial unique index → one run per credential.
 */
export async function setAgentRunTokenHash(
  runId: string,
  tokenHash: string,
): Promise<void> {
  // Fail closed: a silent no-op (empty input or a WHERE matching no run) would
  // let dispatch carry a token whose hash was never stored — throw instead so
  // the dispatch try/catch fails the run rather than emit an unresolvable creds.
  if (!runId || !tokenHash) {
    throw new Error(
      "setAgentRunTokenHash requires a non-empty runId and tokenHash.",
    );
  }
  const updated = await db
    .update(agentRuns)
    .set({ runTokenHash: tokenHash })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error(
      `setAgentRunTokenHash: expected to update exactly one run, updated ${updated.length} (runId=${runId}).`,
    );
  }
}

/**
 * #1193 run-token spine: unique-index lookup backing the run-token verifier.
 * Returns ONLY {id, orgId, runBy} (never the hash); at most one run or null, no newest-wins.
 */
export async function readAgentRunByTokenHash(
  tokenHash: string,
): Promise<{ id: string; orgId: string; runBy: string | null } | null> {
  if (!tokenHash) return null;
  const [row] = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId, runBy: agentRuns.runBy })
    .from(agentRuns)
    .where(eq(agentRuns.runTokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

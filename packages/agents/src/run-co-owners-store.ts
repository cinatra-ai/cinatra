import "server-only";

// ---------------------------------------------------------------------------
// The run_co_owners DAO — a self-contained vertical slice lifted out of
// `store.ts` (cinatra#2569).
//
// Nothing about it is new: the functions are moved verbatim and `./store`
// re-exports them, so every existing caller is byte-unchanged. It moved because
// store.ts is a baselined file-size-ratchet bottleneck sitting exactly at its
// ceiling, and the ratchet's remedy for a file at its ceiling is precisely this
// — extract a vertical slice, then lower the ceiling. This DAO is the cleanest
// one available: five functions over one table, no org-write registry entry, no
// coupling to the rest of the module.
// ---------------------------------------------------------------------------

import { and, asc, eq } from "drizzle-orm";

import { db } from "./db";
import { agentRuns, runCoOwners } from "./schema";

export type RunCoOwnerRecord = {
  runId: string;
  userId: string;
  grantedBy: string;
  grantedAt: Date;
};

export async function readRunCoOwners(runId: string): Promise<RunCoOwnerRecord[]> {
  const rows = await db
    .select()
    .from(runCoOwners)
    .where(eq(runCoOwners.runId, runId))
    .orderBy(asc(runCoOwners.grantedAt));
  return rows;
}

/**
 * single resolver for the run.coOwnerUserIds branch
 * required by enforceRunAccess. Centralises the readRunCoOwners → userId
 * extraction + dedup used before calling the policy
 * kernel from MCP handlers.
 *
 * Returns dedup list preserving first-seen order. Empty list when no
 * co-owners exist (caller MUST still pass coOwnerUserIds: [] explicitly
 * — undefined is the "skip the branch" sentinel in auth-policy.ts).
 */
export async function resolveRunCoOwnerUserIds(runId: string): Promise<string[]> {
  const rows = await readRunCoOwners(runId);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!seen.has(r.userId)) {
      seen.add(r.userId);
      out.push(r.userId);
    }
  }
  return out;
}

export async function addRunCoOwner(
  runId: string,
  userId: string,
  grantedBy: string,
): Promise<void> {
  await db
    .insert(runCoOwners)
    .values({ runId, userId, grantedBy })
    .onConflictDoNothing();
}

export async function removeRunCoOwner(
  runId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(runCoOwners)
    .where(and(eq(runCoOwners.runId, runId), eq(runCoOwners.userId, userId)));
}

/**
 * Clear the original run owner. Used when the owner removes themselves from
 * the ownership list (only allowed if at least one co-owner remains, enforced
 * by the server action).
 */
export async function clearRunRunBy(runId: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ runBy: null })
    .where(eq(agentRuns.id, runId));
}

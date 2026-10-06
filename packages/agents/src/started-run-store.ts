import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns } from "./schema";
import { deserializeRun } from "./agent-run-serde";
import type { AgentRunRecord } from "./store";

/** Trusted create input still has to name a real same-organization starter.
 * Historical starter IDs are not backfilled or rewritten if the run disappears. */
export async function assertStarterRun(input: { id: string; orgId: string; startedByRunId?: string | null }): Promise<void> {
  const starter = input.startedByRunId;
  if (starter == null) return;
  if (typeof starter !== "string" || !starter.trim() || starter !== starter.trim() || starter === input.id) {
    throw new Error("The starter run is invalid; no child was created.");
  }
  const rows = await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.id, starter), eq(agentRuns.orgId, input.orgId))).limit(1);
  if (!rows.length) throw new Error("The starter run is absent from this organization; no child was created.");
}

/** Raw same-org record read; the visible projection must reauthorize EACH child. */
export async function readStartedRunsFor(input: Pick<AgentRunRecord, "id" | "orgId">): Promise<AgentRunRecord[]> {
  const rows = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.startedByRunId, input.id), eq(agentRuns.orgId, input.orgId)))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
  return rows.map(deserializeRun);
}

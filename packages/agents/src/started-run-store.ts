import { and, asc, eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns } from "./schema";
import { deserializeRun } from "./agent-run-serde";
import type { AgentRunRecord } from "./store";

export { assertStarterRun } from "./agent-run-serde";

/** Raw same-org record read; the visible projection must reauthorize EACH child. */
export async function readStartedRunsFor(input: Pick<AgentRunRecord, "id" | "orgId">): Promise<AgentRunRecord[]> {
  const rows = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.startedByRunId, input.id), eq(agentRuns.orgId, input.orgId)))
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
  return rows.map(deserializeRun);
}

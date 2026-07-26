import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentRuns } from "./schema";

/**
 * cinatra#1939 S3 — the pooled-db run-row reader behind the org-write run
 * authority (`VerifyRunAuthorityDeps.readRunRow` in
 * src/lib/org-write/authority.ts). Deliberately a NARROW projection: exactly
 * the columns the kernel's live-attempt predicate and the capability ceiling
 * consult, nothing else — this is an authority witness read, not a record
 * fetch (no deserialization, no authz hooks; the runId it is called with
 * comes from a VERIFIED agent-run OBO token, never caller input).
 */
export type AgentRunRowForOrgWriteAuthority = {
  readonly orgId: string;
  readonly status: string;
  readonly executionAttemptId: string | null;
  readonly executionDeadlineAt: Date | string | null;
  readonly humanWaitAttemptId: string | null;
  /** Raw policy/ceiling snapshots — opaque here; the ceiling hook evaluates. */
  readonly authPolicy: unknown;
  readonly oboCeiling: unknown;
};

export async function readAgentRunRowForOrgWriteAuthority(
  runId: string,
): Promise<AgentRunRowForOrgWriteAuthority | null> {
  if (!runId) return null;
  const [row] = await db
    .select({
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      executionAttemptId: agentRuns.executionAttemptId,
      executionDeadlineAt: agentRuns.executionDeadlineAt,
      humanWaitAttemptId: agentRuns.humanWaitAttemptId,
      authPolicy: agentRuns.authPolicy,
      oboCeiling: agentRuns.oboCeiling,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ?? null;
}

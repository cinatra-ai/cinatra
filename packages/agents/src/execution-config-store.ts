// Durable write seam for the per-agent execution config (exec-plane S3 slice B,
// cinatra#1708; epic #1705).
//
// Deliberately a SEPARATE module rather than another function on ./store:
// store.ts is a tracked file-size bottleneck (the same reason ./template-snapshot
// was extracted in PR #1754), and "write the agent's execution config" is a
// cohesive one-table concern.
//
// The write is CANONICAL-ONLY: callers hand over an already-parsed
// `AgentExecutionConfig` (produced by `parseAgentExecutionConfigSubmission`),
// and an empty declaration is stored as NULL — "declares nothing" and "has no
// declaration" are one state, so an env-less template never version-snapshots
// an empty recipe object and drifts its content hash.

import { eq } from "drizzle-orm";

import { db } from "./db";
import { agentTemplates } from "./schema";
import {
  serializeExecutionEnvironmentForStorage,
  type AgentExecutionConfig,
} from "./execution-config";

/**
 * Persist a project agent's execution config. Returns `false` when no row
 * matched (a template removed between load and save) so the caller can report
 * a stale-surface failure instead of pretending the write landed.
 */
export async function writeAgentExecutionConfig(
  templateId: string,
  config: AgentExecutionConfig,
): Promise<boolean> {
  const rows = await db
    .update(agentTemplates)
    .set({
      executionEnvironment: serializeExecutionEnvironmentForStorage(config.environment),
      executionEnabled: config.executionEnabled,
      updatedAt: new Date(),
    })
    .where(eq(agentTemplates.id, templateId))
    .returning({ id: agentTemplates.id });
  return rows.length > 0;
}

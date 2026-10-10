import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorRoleHints } from "./auth-policy";
import { AuthzError } from "@/lib/authz";
import { canonicalRunPath, parseLaunchScopeAnchor } from "@/lib/launch-scope-anchor";
import { readAgentRunById, readAgentTemplateById, type AgentRunRecord } from "./store";
import { readStartedRunsFor } from "./started-run-store";

export type StartedRunRow = { id: string; agentDisplayName: string; status: string; href: string };

/** Reading a curator never grants access to another run. Each recorded child
 * clears the existing policy/co-owner/OBO read door and keeps its own address. */
export async function readVisibleStartedRuns(
  starter: Pick<AgentRunRecord, "id" | "orgId">, actor: PrimitiveActorContext, roles: ActorRoleHints,
): Promise<StartedRunRow[]> {
  const recorded = await readStartedRunsFor(starter);
  const visible: StartedRunRow[] = [];
  for (const child of recorded) {
    try {
      const run = await readAgentRunById(child.id, actor, roles);
      if (!run || run.orgId !== starter.orgId || run.startedByRunId !== starter.id) continue;
      const template = await readAgentTemplateById(run.templateId);
      if (!template) continue;
      visible.push({
        id: run.id, agentDisplayName: template.name, status: run.status,
        href: canonicalRunPath({
          agentPackageName: template.packageName ?? template.id,
          instanceId: encodeURIComponent(run.id), anchor: parseLaunchScopeAnchor(run.launchScopeAnchor),
        }),
      });
    } catch (error) {
      if (error instanceof AuthzError && (error.statusCode === 403 || error.statusCode === 404)) continue;
      throw error;
    }
  }
  return visible;
}

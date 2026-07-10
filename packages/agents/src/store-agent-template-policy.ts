import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentTemplates } from "./schema";
import type { AgentAuthPolicy } from "./auth-policy";

/**
 * `afterPolicyWrite` dual-write (admin-parity P4, cinatra#1129) mirroring a
 * generic-surface agent_template policy edit into the legacy
 * `agent_templates.agent_auth_policy` column that
 * `enforceRunAccess` → `resolveEffectivePolicy` reads (the generic Permissions
 * layer only writes the polymorphic table). Metadata-only — skips the lock.
 *
 * Vertical-slice extraction out of `store.ts` so the hub stays under the
 * file-size ratchet ceiling; re-exported from `./store`, so
 * `@cinatra-ai/agents/store` consumers are unaffected.
 */
export async function updateAgentTemplateAuthPolicy(
  id: string,
  policy: AgentAuthPolicy | null,
): Promise<void> {
  await db
    .update(agentTemplates)
    .set({
      agentAuthPolicy: policy ? JSON.stringify(policy) : null,
      updatedAt: new Date(),
    })
    .where(eq(agentTemplates.id, id));
}

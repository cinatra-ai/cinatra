"use server";

import { requireAdminSession } from "@/lib/auth-session";
import { rollbackAgentTemplateToVersion } from "./store";

// rollbackAgentTemplate — server action for UI-triggered rollback
// Separate file required so RollbackButton (client component) can import it.
// actions.ts uses import "server-only" which cannot be imported from client components.

export async function rollbackAgentTemplate(
  templateId: string,
  targetVersionId: string,
): Promise<{ ok: true; restoredVersionId: string } | { ok: false; error: string }> {
  try {
    const session = await requireAdminSession();
    const result = await rollbackAgentTemplateToVersion(
      templateId,
      targetVersionId,
      session?.user?.id ?? null,
    );
    return { ok: true, restoredVersionId: result.restoredVersionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

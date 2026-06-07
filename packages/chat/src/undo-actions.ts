"use server";

import { requireAuthSession } from "@/lib/auth-session";
import { listChangeSets } from "@/lib/object-history";

// Chat-side undo. After an agent_run tool
// call, the chat polls for a recent CLOSED, restorable change-set produced by
// that run (closedAtAfter avoids surfacing in-flight mutations — a race
// mitigation). Returns the change-set id so the chip can deep-link to the
// URL-addressable restore modal (?openRestore=1), which enforces its own
// per-event restore authz on open + confirm. Org-scoped; orgless → null.
//
// Kept in a dedicated module (not actions.ts) so its import graph stays light
// — only @/lib/auth-session + @/lib/object-history — and unit-testable under
// the chat package's vitest (actions.ts pulls @cinatra-ai/agents/auth-policy,
// which the chat vitest alias can't resolve as a subpath).
const CHAT_UNDO_WINDOW_MINUTES = 5;

export async function recentUndoableChangeSetForRunAction(input: {
  runId: string;
}): Promise<{ changeSetId: string } | null> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) return null;
  const closedAtAfter = new Date(
    Date.now() - CHAT_UNDO_WINDOW_MINUTES * 60_000,
  ).toISOString();
  const items = listChangeSets({
    orgId,
    runId: input.runId,
    closedAtAfter,
    restorable: true,
    limit: 1,
  });
  const cs = items[0];
  return cs ? { changeSetId: cs.id } : null;
}

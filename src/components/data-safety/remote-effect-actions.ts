"use server";

import { requireAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { retryRemoteEffect, type MutationResult } from "@/lib/object-history";

// Admin retry server action.
// platform_admin ONLY. The reader LIST surface is read directly by the
// change-set detail server component (server-only lib), mirroring how the
// change-sets index reads listChangeSets; only the retry MUTATION needs a
// client-callable server action.
export async function retryRemoteEffectAction(input: {
  attemptId: string;
}): Promise<MutationResult<{ status: string }>> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, error: "no active organization on session" };
  }
  // Two-layer admin gate (matches the MCP retry primitive): the action AND
  // the primitive both require platform_admin.
  if (!isPlatformAdmin(session)) {
    return { ok: false, error: "platform_admin required to retry" };
  }
  const result = await retryRemoteEffect({ attemptId: input.attemptId, orgId });
  if (result.ok) {
    return { ok: true, data: { status: result.attempt.status } };
  }
  return {
    ok: false,
    error: result.message,
    details: { reason: result.reason },
  };
}

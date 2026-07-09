"use server";

import { revalidatePath } from "next/cache";

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

import { approvalSourceRegistry } from "./sources/registry";
import type { ApprovalViewer } from "./sources/types";

// ---------------------------------------------------------------------------
// Thin UI server-action wrapper over the per-source decision helpers. It
// resolves the viewer from the session, dispatches to the source's own
// non-redirecting `decide`, then revalidates the page. The future `approvals_*`
// MCP handlers call the SAME `source.actions.decide` with no redirect/revalidate.
// It does NOT redirect — inline decisions stay on the page; the returned state
// surfaces a business refusal in place.
// ---------------------------------------------------------------------------

export interface InlineDecideState {
  ok: boolean;
  error?: string;
}

export async function decideApprovalRow(
  _prev: InlineDecideState,
  formData: FormData,
): Promise<InlineDecideState> {
  const sourceId = String(formData.get("sourceId") ?? "");
  const rowId = String(formData.get("rowId") ?? "");
  const action = String(formData.get("action") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const expectedVersion = String(formData.get("expectedVersion") ?? "").trim();

  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) {
    return { ok: false, error: "No active session." };
  }
  const viewer: ApprovalViewer = { userId, orgId, isAdmin: isPlatformAdmin(session) };

  const source = approvalSourceRegistry.find((s) => s.id === sourceId);
  if (!source) {
    return { ok: false, error: "Unknown approval source." };
  }

  const result = await source.actions.decide(
    {
      rowId,
      action,
      ...(reason ? { reason } : {}),
      ...(expectedVersion ? { expectedVersion } : {}),
    },
    viewer,
  );

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  revalidatePath("/configuration/approvals");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";

import {
  getAuthSession,
  isPlatformAdmin,
  buildCanDoOptsFromSession,
} from "@/lib/auth-session";
import { buildInstallTargetPickerContext } from "@cinatra-ai/agents/install-target-picker";
import type { InstallTarget } from "@cinatra-ai/agents/install-targets";

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

  // Approval-time access scope (cinatra#1327). The agent-creation source's
  // approve REQUIRES it; other sources ignore it. Only accept the three
  // selectable levels — a malformed level yields no accessTarget, which the
  // agent source then refuses (fail-closed).
  const accessTargetLevel = String(formData.get("accessTargetLevel") ?? "").trim();
  const accessTargetId = String(formData.get("accessTargetId") ?? "").trim();
  const accessTarget =
    accessTargetId &&
    (accessTargetLevel === "organization" ||
      accessTargetLevel === "team" ||
      accessTargetLevel === "project")
      ? { level: accessTargetLevel as "organization" | "team" | "project", id: accessTargetId }
      : undefined;

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
      ...(accessTarget ? { accessTarget } : {}),
    },
    viewer,
  );

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  // Refresh the page rows/counts AND the sidebar Approvals badge. The badge is
  // rendered by the ROOT layout, so a page-level revalidate alone would leave a
  // stale count after this non-redirecting inline decision — revalidate the
  // root layout segment too so the pill updates without a full reload.
  revalidatePath("/configuration/approvals");
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approval access-scope picker context (cinatra#1327).
//
// The agent-creation approve action surfaces the SAME server-computed
// org/team/project rows the marketplace install dialog uses (who can access the
// agent once published). The client Approve dialog loads them lazily via this
// server action when opened, so the row list stays synchronous/light and the
// picker rows are computed with the REAL session (orgRole-aware enabled/disabled
// state), never client-derived. Admin-gated + fail-safe: returns null when there
// is no admin session / active org, and the dialog then shows the empty-state
// (no installable scope → cannot approve), matching the install dialog.
// ---------------------------------------------------------------------------
export type ApprovalInstallScopeContext = {
  installTargets: InstallTarget[];
  ownerEntityNames: Record<string, string>;
  defaultValue: string | null;
  activeOrgId: string;
};

export async function loadApprovalInstallScopeContext(): Promise<ApprovalInstallScopeContext | null> {
  const session = await getAuthSession();
  if (!session?.user?.id) return null;
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  if (!activeOrgId) return null;
  // Only a platform admin decides agent-creation approvals — the scope picker is
  // both meaningless and unauthorized otherwise.
  if (!isPlatformAdmin(session)) return null;

  const opts = await buildCanDoOptsFromSession(session);
  const { installTargets, ownerEntityNames, defaultValue } =
    await buildInstallTargetPickerContext({
      session,
      orgRole: opts.orgRole,
      currentProjectId: undefined,
    });
  return { installTargets, ownerEntityNames, defaultValue, activeOrgId };
}

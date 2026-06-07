// -----------------------------------------------------------------------------
// Access Control admin actions.
//
//   - setSingleOrgModeAction (RBAC-UI-03): flip the single-org compatibility
//     toggle. Hides the "Organizations" nav entry + blocks org creation for
//     all users (UI/UX + create-path only; the 4-tier scope model is
//     untouched, existing org records are not migrated).
//   - setAuditRetentionAction: set the durable audit-log
//     retention window (admin-configurable knob; default 12 months).
//
// Both are platform-admin-gated via requireAdminSession.
// -----------------------------------------------------------------------------
"use server";

import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import { setSingleOrgMode } from "@/lib/authz/instance-mode";
import { setAuditRetentionDays } from "@/lib/authz/audit";

export async function setSingleOrgModeAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const enabled = formData.get("singleOrg") === "on" || formData.get("singleOrg") === "true";
  await setSingleOrgMode(enabled);
  revalidatePath("/configuration/access-control");
  revalidatePath("/", "layout");
}

export async function setAuditRetentionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const raw = Number(formData.get("retentionDays"));
  if (!Number.isFinite(raw)) {
    throw new Error("Retention days must be a number.");
  }
  await setAuditRetentionDays(raw);
  revalidatePath("/configuration/access-control");
}

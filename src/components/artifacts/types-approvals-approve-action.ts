"use server";

import { revalidatePath } from "next/cache";

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { approveDynamicTypeArtifactVisibility } from "@/lib/objects/artifact-visibility-approval";

/**
 * Types & approvals Approve action (cinatra#1431 §V). Grants a dynamic type
 * ORG-SCOPED artifact visibility by writing the real approval record via the
 * landed #1433 machinery — NOT a `status='active'` flip. The record is an
 * org-scoped default claim held by the floor extension; approving here or in
 * the /configuration/approvals inbox writes the SAME record.
 *
 * Admin-only (the caller also renders admin-only, but this is the enforcement
 * boundary). Business refusals from the ladder (not_found / not_active /
 * already_approved / claim_conflict) surface inline as `error`; the surface is
 * revalidated on success so the row re-reads as Approved.
 */
export interface ApproveVisibilityState {
  ok: boolean;
  error?: string;
}

export async function approveDynamicTypeVisibilityFormAction(
  _prev: ApproveVisibilityState,
  formData: FormData,
): Promise<ApproveVisibilityState> {
  const objectTypeId = String(formData.get("objectTypeId") ?? "").trim();
  if (!objectTypeId) return { ok: false, error: "Missing object type." };

  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) return { ok: false, error: "No active session." };
  if (!isPlatformAdmin(session)) {
    return { ok: false, error: "Administrator only." };
  }

  const result = await approveDynamicTypeArtifactVisibility({
    orgId,
    objectTypeId,
    approvedBy: userId,
  });
  if (!result.ok) return { ok: false, error: result.message };

  revalidatePath("/artifacts");
  return { ok: true };
}

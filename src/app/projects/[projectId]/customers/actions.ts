"use server";

// ---------------------------------------------------------------------------
// Customer / external grant management server actions (RBAC-EXT-01).
//
// A customer grant is project-scoped: it writes a role_grant(role="customer",
// scopeLevel="project") for the capability ceiling + expiry AND a
// project_access(read) row for sealed-room visibility. Only a project admin
// (or platform admin) may manage customer grants — the actor's projectGrants
// effectiveRole must be admin/owner on the target project.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import { readProjectGrantsForUser, readTeamsForUser } from "@/lib/better-auth-db";
import { AuthzError } from "@/lib/authz/errors";
import {
  grantCustomerAccess,
  revokeCustomerAccess,
  listCustomerGrantsForProject,
  type CustomerGrantRow,
} from "@/lib/authz/customer-grant-store";

async function assertProjectAdmin(projectId: string): Promise<{ orgId: string; userId: string }> {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  if (!orgId) throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Active organization required." });
  if (isPlatformAdmin(session)) return { orgId, userId };
  const teamRows = await readTeamsForUser(userId, orgId).catch(() => []);
  const orgRole = await resolveOrgRoleForSession(session).catch(() => null);
  const grants = await readProjectGrantsForUser(userId, orgId, {
    teamIds: teamRows.map((t) => t.id),
    ...(orgRole ? { orgRole } : {}),
  }).catch(() => []);
  const here = grants.find((g) => g.projectId === projectId);
  if (!here || (here.effectiveRole !== "admin" && here.effectiveRole !== "owner")) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Project admin required." });
  }
  return { orgId, userId };
}

export async function inviteCustomerAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const subjectUserId = String(formData.get("subjectUserId") ?? "").trim();
  const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
  if (!projectId || !subjectUserId) throw new Error("projectId and subjectUserId are required.");
  const { orgId, userId } = await assertProjectAdmin(projectId);
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Invalid expiry date.");
  await grantCustomerAccess({ subjectUserId, projectId, orgId, grantedBy: userId, expiresAt });
  revalidatePath(`/projects/${projectId}/customers`);
}

export async function revokeCustomerAction(formData: FormData): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "");
  const subjectUserId = String(formData.get("subjectUserId") ?? "");
  if (!projectId || !subjectUserId) throw new Error("projectId and subjectUserId are required.");
  await assertProjectAdmin(projectId);
  await revokeCustomerAccess({ subjectUserId, projectId });
  revalidatePath(`/projects/${projectId}/customers`);
}

export async function listCustomerGrants(projectId: string): Promise<CustomerGrantRow[]> {
  await assertProjectAdmin(projectId);
  return listCustomerGrantsForProject(projectId);
}

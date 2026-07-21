"use server";
/**
 * Server actions for the `/organizations/[id]` Manage surface (cinatra#1510).
 *
 * These are the VIEWED-org write path — the org whose detail page is open may
 * differ from the actor's ACTIVE org, so every action re-derives the caller's
 * capability through the shared viewed-org gate
 * (`@/lib/authz/organization-manage-gate`, which maps the viewed-org
 * membership role through the REAL permission catalog) and FAILS CLOSED before
 * touching Better Auth. Better Auth re-enforces the same permission inside each
 * endpoint (defense in depth, keyed off the explicit `organizationId`), but the
 * gate here is the authoritative first line so the UI affordance gate, the
 * page-render gate, and this write gate cannot drift.
 *
 * Catalog mapping (the ruling's "where permitted" fence):
 *   - settings (name + slug) → `organization.update`        → org_admin+
 *   - member role / remove   → `organization.manageMembers` → org_owner
 *   - invitation cancel      → `organization.manageMembers` → org_owner
 *
 * DELETE ships here too (cinatra#1510 remainder): gated on
 * `organization.delete` (org_owner) via the same viewed-org gate, structurally
 * blocked for the default org and single-org mode, name-confirmed server-side,
 * and executed by the reference-guarded transactional core in
 * `@/lib/organization-delete` (block-if-referenced, never cascade).
 * DEFERRED: archive (no schema/catalog basis — owner proposal pending).
 * Invitation CREATE is the client
 * `InviteMemberDialog` (org-id-parameterized `authClient.organization.inviteMember`),
 * rendered only when `canManageMembers`.
 *
 * Expected-failure discipline: these return a discriminated result
 * (`{ ok: true } | { ok: false; error }`) rather than throwing, so the client
 * surfaces a toast instead of an error boundary, and the fail-closed path is
 * cleanly assertable. Slug edits are picked up by the DB `org_slug_move_trg`
 * relocation trigger (drizzle-store.ts) — no app-side path move needed.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { getAuthSession } from "@/lib/auth-session";
import { betterAuthDb, betterAuthOrganizations } from "@/lib/better-auth-db";
import {
  resolveOrganizationManageCapabilities,
  userCanManageOrganization,
  userCanManageOrganizationMembers,
} from "@/lib/authz/organization-manage-gate";
import { logAuditEvent } from "@/lib/authz/audit";
import {
  deleteOrganizationReferenceGuarded,
  type OrganizationDeleteBlockers,
} from "@/lib/organization-delete";

export type OrgManageActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type OrgDeleteActionResult =
  | { readonly ok: true; readonly redirectTo: string }
  | {
      readonly ok: false;
      readonly error: string;
      /** Present when referenced records block the delete — per-kind counts. */
      readonly blockers?: OrganizationDeleteBlockers;
    };

type OrgWorkspaceRole = "member" | "admin" | "owner";

function readRequiredString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${key}.`);
  }
  return value.trim();
}

function readOptionalString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOrgRole(formData: FormData): OrgWorkspaceRole {
  const role = readRequiredString(formData, "role");
  if (role !== "member" && role !== "admin" && role !== "owner") {
    throw new Error("Invalid organization role.");
  }
  return role;
}

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * Update organization settings — name (required) and slug (optional). Gated on
 * `organization.update` (org_admin+) in the VIEWED org. An omitted/blank slug
 * is left untouched (this surface never nulls a slug).
 */
export async function updateOrganizationSettingsAction(
  formData: FormData,
): Promise<OrgManageActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    if (!session || !(await userCanManageOrganization(session, organizationId))) {
      return { ok: false, error: "You do not have permission to update this organization." };
    }
    const name = readRequiredString(formData, "name");
    const slug = readOptionalString(formData, "slug");
    const data: { name: string; slug?: string } = { name };
    if (slug !== undefined) data.slug = slug;

    await auth.api.updateOrganization({
      headers: await headers(),
      body: { organizationId, data },
    });
    revalidatePath(`/organizations/${organizationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err, "Could not update the organization.") };
  }
}

/**
 * Change an organization member's role. Gated on `organization.manageMembers`
 * (org_owner) in the VIEWED org. `memberId` is the Better-Auth `member` row id.
 */
export async function updateOrganizationMemberRoleAction(
  formData: FormData,
): Promise<OrgManageActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    if (!session || !(await userCanManageOrganizationMembers(session, organizationId))) {
      return { ok: false, error: "You do not have permission to manage members." };
    }
    const memberId = readRequiredString(formData, "memberId");
    const role = readOrgRole(formData);

    await auth.api.updateMemberRole({
      headers: await headers(),
      body: { organizationId, memberId, role },
    });
    revalidatePath(`/organizations/${organizationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err, "Could not update the member's role.") };
  }
}

/**
 * Remove a member from the organization. Gated on `organization.manageMembers`
 * (org_owner) in the VIEWED org. `memberId` is the Better-Auth `member` row id
 * (accepted by `removeMember` as `memberIdOrEmail`).
 */
export async function removeOrganizationMemberAction(
  formData: FormData,
): Promise<OrgManageActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    if (!session || !(await userCanManageOrganizationMembers(session, organizationId))) {
      return { ok: false, error: "You do not have permission to manage members." };
    }
    const memberId = readRequiredString(formData, "memberId");

    await auth.api.removeMember({
      headers: await headers(),
      body: { organizationId, memberIdOrEmail: memberId },
    });
    revalidatePath(`/organizations/${organizationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err, "Could not remove the member.") };
  }
}

function describeBlockers(blockers: OrganizationDeleteBlockers): string {
  const parts: string[] = [];
  if (blockers.teams > 0) parts.push(`${blockers.teams} team(s)`);
  if (blockers.activeProjects > 0)
    parts.push(`${blockers.activeProjects} active project(s)`);
  if (blockers.connectors > 0) parts.push(`${blockers.connectors} connector(s)`);
  if (blockers.dashboards > 0) parts.push(`${blockers.dashboards} dashboard(s)`);
  if (blockers.agents > 0) parts.push(`${blockers.agents} agent(s)`);
  return parts.join(", ");
}

/**
 * Delete the organization. Gated on `organization.delete` (org_owner) in the
 * VIEWED org via the shared capabilities gate — which also re-checks the two
 * structural hazards (default org, single-org mode) fail-closed. The typed
 * organization name is verified SERVER-side against the live row (the client
 * gating is UX only), then the reference-guarded transactional core runs:
 * anything with its own lifecycle blocks with per-kind counts; on success the
 * client is sent to `/organizations` (the viewed page no longer exists, and
 * every session's dangling active-org pointer was cleared in-transaction).
 */
export async function deleteOrganizationAction(
  formData: FormData,
): Promise<OrgDeleteActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    const capabilities = session
      ? await resolveOrganizationManageCapabilities(session, organizationId)
      : null;
    if (!capabilities?.canDelete) {
      return {
        ok: false,
        error: "You do not have permission to delete this organization.",
      };
    }

    const confirmName = readRequiredString(formData, "confirmName");
    const orgRows = await betterAuthDb
      .select({ name: betterAuthOrganizations.name })
      .from(betterAuthOrganizations)
      .where(eq(betterAuthOrganizations.id, organizationId))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      return { ok: false, error: "This organization no longer exists." };
    }
    if (confirmName !== org.name) {
      return {
        ok: false,
        error: "The name you typed does not match the organization's name.",
      };
    }

    const result = await deleteOrganizationReferenceGuarded(organizationId);
    if (!result.ok) {
      if (result.reason === "blocked") {
        return {
          ok: false,
          error: `Cannot delete: this organization still contains ${describeBlockers(result.blockers)}. Remove or re-home them first.`,
          blockers: result.blockers,
        };
      }
      if (result.reason === "not-found") {
        return { ok: false, error: "This organization no longer exists." };
      }
      if (result.reason === "default-org") {
        return {
          ok: false,
          error: "The default organization cannot be deleted.",
        };
      }
      return { ok: false, error: "Could not delete the organization." };
    }

    await logAuditEvent({
      organizationId,
      actorPrincipalId: session?.user?.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "organization",
      resourceId: organizationId,
      operation: "organization.delete",
      decision: "allowed",
      metadata: { organizationName: org.name },
    });
    revalidatePath("/organizations");
    return { ok: true, redirectTo: "/organizations" };
  } catch (err) {
    return {
      ok: false,
      error: toErrorMessage(err, "Could not delete the organization."),
    };
  }
}

/**
 * Cancel a pending organization invitation. Gated on
 * `organization.manageMembers` (org_owner) in the VIEWED org.
 */
export async function cancelOrganizationInvitationAction(
  formData: FormData,
): Promise<OrgManageActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    if (!session || !(await userCanManageOrganizationMembers(session, organizationId))) {
      return { ok: false, error: "You do not have permission to manage invitations." };
    }
    const invitationId = readRequiredString(formData, "invitationId");

    await auth.api.cancelInvitation({
      headers: await headers(),
      body: { invitationId },
    });
    revalidatePath(`/organizations/${organizationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err, "Could not cancel the invitation.") };
  }
}

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
 * ARCHIVE/UNARCHIVE ship the same way (cinatra#1942 V5, archive program S6):
 * gated on `organization.archive` (org_owner) via the same gate's
 * `canArchive`, archive name-confirmed server-side, executed by the guarded
 * transactional core in `@/lib/organization-archive` (the kernel exclusive
 * fence; archive additionally refuses behind the default-off
 * `org_archive_activation` gate until the owner-gated flip). Unarchive is
 * deliberately reachable regardless of that gate — an archived org must
 * always be recoverable.
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
import {
  archiveOrganization,
  unarchiveOrganization,
  type OrganizationArchiveResult,
} from "@/lib/organization-archive";

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
  if (blockers.installedExtensions > 0)
    parts.push(`${blockers.installedExtensions} installed extension(s)`);
  if (blockers.dashboards > 0) parts.push(`${blockers.dashboards} dashboard(s)`);
  if (blockers.agents > 0) parts.push(`${blockers.agents} agent(s)`);
  if (blockers.liveAgentRuns > 0)
    parts.push(`${blockers.liveAgentRuns} running agent(s)`);
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
    if (!session) {
      return {
        ok: false,
        error: "You do not have permission to delete this organization.",
      };
    }
    const capabilities = await resolveOrganizationManageCapabilities(
      session,
      organizationId,
    );
    if (!capabilities.canDelete) {
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

    const result = await deleteOrganizationReferenceGuarded(
      organizationId,
      session.user.id,
    );
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
      if (result.reason === "single-org-mode") {
        return {
          ok: false,
          error: "Organizations cannot be deleted in single-organization mode.",
        };
      }
      if (result.reason === "not-archived") {
        // cinatra#1939 (Decision 1): reachable only once the archive activation
        // gate is on (S6). The archive-first control lands on /settings with
        // the same activation.
        return {
          ok: false,
          error:
            "Archive this organization first — deletion is only available for archived organizations.",
        };
      }
      if (result.reason === "denied") {
        return {
          ok: false,
          error: "You do not have permission to delete this organization.",
        };
      }
      return { ok: false, error: "Could not delete the organization." };
    }

    // logAuditEvent is fire-and-forget by contract (silent swallow on insert
    // failure) — it can never turn the committed delete into a failure result.
    await logAuditEvent({
      organizationId,
      actorPrincipalId: session.user.id,
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

/** Map an archive/unarchive core refusal to the user-facing error string.
 *  Success (incl. the idempotent no-op) never reaches this. */
function describeArchiveFailure(
  result: Extract<OrganizationArchiveResult, { ok: false }>,
  verb: "archive" | "unarchive",
): string {
  switch (result.reason) {
    case "activation-gate-off":
      return "Archiving is not enabled on this instance.";
    case "single-org-mode":
      return "Organizations cannot be archived in single-organization mode.";
    case "default-org":
      return "The default organization cannot be archived.";
    case "not-found":
      return "This organization no longer exists.";
    case "denied":
      return `You do not have permission to ${verb} this organization.`;
    case "error":
      return `Could not ${verb} the organization.`;
  }
}

/**
 * Archive the organization (cinatra#1942 V5). Gated on `organization.archive`
 * (org_owner) via the shared capabilities gate (which folds in the structural
 * hazards), name-confirmed SERVER-side against the live row, then the guarded
 * archive transaction runs (which re-checks the activation gate FIRST, the
 * eligibility fence, and the actor's ownership under the kernel's exclusive
 * org fence). Re-archiving an archived org is an idempotent success — the
 * action never errors on idempotency.
 */
export async function archiveOrganizationAction(
  formData: FormData,
): Promise<OrgManageActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    if (!session) {
      return {
        ok: false,
        error: "You do not have permission to archive this organization.",
      };
    }
    const capabilities = await resolveOrganizationManageCapabilities(
      session,
      organizationId,
    );
    if (!capabilities.canArchive) {
      return {
        ok: false,
        error: "You do not have permission to archive this organization.",
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

    const result = await archiveOrganization(organizationId, session.user.id);
    if (!result.ok) {
      return { ok: false, error: describeArchiveFailure(result, "archive") };
    }

    // Fire-and-forget by contract — never turns the committed archive into a
    // failure result. An idempotent re-archive still audits `allowed`.
    await logAuditEvent({
      organizationId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "organization",
      resourceId: organizationId,
      operation: "organization.archive",
      decision: "allowed",
      metadata: {
        organizationName: org.name,
        ...(result.idempotent ? { idempotent: true } : {}),
      },
    });
    revalidatePath(`/organizations/${organizationId}`);
    revalidatePath("/organizations");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: toErrorMessage(err, "Could not archive the organization."),
    };
  }
}

/**
 * Unarchive the organization (cinatra#1942 V5). Gated on
 * `organization.archive` (the same permission covers both directions) via the
 * shared gate's `canArchive`. No name confirmation — recovery should be easy;
 * the destructive direction is the one that arms. The core transaction is
 * deliberately NOT gated on the activation flag (rollback depends on it).
 */
export async function unarchiveOrganizationAction(
  formData: FormData,
): Promise<OrgManageActionResult> {
  try {
    const organizationId = readRequiredString(formData, "organizationId");
    const session = await getAuthSession();
    if (!session) {
      return {
        ok: false,
        error: "You do not have permission to unarchive this organization.",
      };
    }
    const capabilities = await resolveOrganizationManageCapabilities(
      session,
      organizationId,
    );
    if (!capabilities.canArchive) {
      return {
        ok: false,
        error: "You do not have permission to unarchive this organization.",
      };
    }

    const result = await unarchiveOrganization(organizationId, session.user.id);
    if (!result.ok) {
      return { ok: false, error: describeArchiveFailure(result, "unarchive") };
    }

    await logAuditEvent({
      organizationId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "organization",
      resourceId: organizationId,
      operation: "organization.unarchive",
      decision: "allowed",
      metadata: result.idempotent ? { idempotent: true } : {},
    });
    revalidatePath(`/organizations/${organizationId}`);
    revalidatePath("/organizations");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: toErrorMessage(err, "Could not unarchive the organization."),
    };
  }
}

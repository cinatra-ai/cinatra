import { z } from "zod";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { betterAuthDb } from "@/lib/better-auth-db";
import { sql } from "drizzle-orm";

export const inviteMemberSchema = z.object({
  organizationId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["member", "admin", "owner"]),
});

export const updateMemberRoleSchema = z.object({
  organizationId: z.string().min(1),
  memberId: z.string().min(1),
  role: z.enum(["member", "admin", "owner"]),
});

export const updateUserPlatformRoleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["user", "admin"]),
});

export const cancelInvitationSchema = z.object({
  invitationId: z.string().min(1),
  organizationId: z.string().min(1),
});

// role_grant CRUD schemas.
const v61RoleEnum = z.enum(["developer", "release_manager", "customer"]);
const grantScopeSchema = z.object({
  level: z.enum(["user", "team", "organization", "workspace", "project"]),
  recordId: z.string().min(1),
});

export const roleGrantGrantSchema = z.object({
  subjectUserId: z.string().min(1),
  role: v61RoleEnum,
  scope: grantScopeSchema,
  orgId: z.string().min(1),
  expiresAtIso: z.string().datetime().optional(),
});

export const roleGrantRevokeSchema = z.object({
  subjectUserId: z.string().min(1),
  role: v61RoleEnum,
  scope: grantScopeSchema,
});

export const roleGrantListSchema = z.object({
  orgId: z.string().min(1),
  filterSubjectUserId: z.string().optional(),
});

export const removeMemberSchema = z.object({
  organizationId: z.string().min(1),
  memberId: z.string().min(1),
});

export function createPermissionsPrimitiveHandlers() {
  return {
    "permissions_members_invite": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = inviteMemberSchema.parse(request.input);
      const requestHeaders = await headers();
      await auth.api.createInvitation({
        headers: requestHeaders,
        body: {
          organizationId: input.organizationId,
          email: input.email,
          role: input.role,
        },
      });
      return { ok: true };
    },

    "permissions_members_update_role": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = updateMemberRoleSchema.parse(request.input);
      const requestHeaders = await headers();
      await auth.api.updateMemberRole({
        headers: requestHeaders,
        body: {
          organizationId: input.organizationId,
          memberId: input.memberId,
          role: input.role,
        },
      });
      return { ok: true };
    },

    "permissions_members_remove": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = removeMemberSchema.parse(request.input);
      const requestHeaders = await headers();
      await auth.api.removeMember({
        headers: requestHeaders,
        body: {
          organizationId: input.organizationId,
          memberIdOrEmail: input.memberId,
        },
      });
      return { ok: true };
    },

    "permissions_users_update_platform_role": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = updateUserPlatformRoleSchema.parse(request.input);
      // auth.api.setRole requires an active admin session via request headers which is
      // unavailable in MCP m2m context — use a direct DB update instead.
      await betterAuthDb.execute(sql`
        UPDATE public."user" SET role = ${input.role}, "updatedAt" = NOW()
        WHERE id = ${input.userId}
      `);
      const result = await betterAuthDb.execute<{ id: string; name: string; role: string }>(sql`
        SELECT id, name, role FROM public."user" WHERE id = ${input.userId}
      `);
      const updated = result.rows[0];
      if (!updated) throw new Error(`User not found: ${input.userId}`);
      return { ok: true, userId: updated.id, name: updated.name, role: updated.role };
    },

    "permissions_invitations_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = cancelInvitationSchema.parse(request.input);
      const requestHeaders = await headers();
      await auth.api.cancelInvitation({
        headers: requestHeaders,
        body: {
          invitationId: input.invitationId,
        },
      });
      return { ok: true };
    },

    // role_grant CRUD.
    "role_grant_grant": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = roleGrantGrantSchema.parse(request.input);
      const { grantRole } = await import("@/lib/authz/role-grant-store");
      const grantedBy = (request.actor as { userId?: string }).userId ?? "system";
      const row = await grantRole({
        subjectUserId: input.subjectUserId,
        role: input.role,
        scope: input.scope as Parameters<typeof grantRole>[0]["scope"],
        orgId: input.orgId,
        grantedBy,
        expiresAt: input.expiresAtIso ? new Date(input.expiresAtIso) : null,
      });
      return { ok: true, row };
    },

    "role_grant_revoke": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = roleGrantRevokeSchema.parse(request.input);
      const { revokeRole } = await import("@/lib/authz/role-grant-store");
      const result = await revokeRole({
        subjectUserId: input.subjectUserId,
        role: input.role,
        scope: input.scope as Parameters<typeof revokeRole>[0]["scope"],
      });
      return result;
    },

    "role_grant_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = roleGrantListSchema.parse(request.input);
      const { readRoleGrantsForUser, listRoleGrantsForOrg } = await import(
        "@/lib/authz/role-grant-store"
      );
      const rows = input.filterSubjectUserId
        ? await readRoleGrantsForUser(input.filterSubjectUserId, input.orgId)
        : await listRoleGrantsForOrg(input.orgId);
      return { rows };
    },
  } as const;
}

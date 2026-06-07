"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requireAdminSession } from "@/lib/auth-session";

type WorkspaceRole = "member" | "admin" | "owner";
type PlatformRole = "user" | "admin";

function readRequiredString(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${key}.`);
  }
  return value.trim();
}

function readWorkspaceRole(formData: FormData): WorkspaceRole {
  const role = readRequiredString(formData, "role");
  if (role !== "member" && role !== "admin" && role !== "owner") {
    throw new Error("Invalid workspace role.");
  }
  return role;
}

function readPlatformRole(formData: FormData): PlatformRole {
  const role = readRequiredString(formData, "role");
  if (role !== "user" && role !== "admin") {
    throw new Error("Invalid platform role.");
  }
  return role;
}

export async function inviteWorkspaceMemberAction(formData: FormData) {
  await requireAdminSession();
  const requestHeaders = await headers();
  const organizationId = readRequiredString(formData, "organizationId");
  const email = readRequiredString(formData, "email");
  const role = readWorkspaceRole(formData);

  await auth.api.createInvitation({
    headers: requestHeaders,
    body: {
      organizationId,
      email,
      role,
    },
  });

  revalidatePath("/configuration/permissions");
}

export async function updateWorkspaceMemberRoleAction(formData: FormData) {
  await requireAdminSession();
  const requestHeaders = await headers();
  const organizationId = readRequiredString(formData, "organizationId");
  const memberId = readRequiredString(formData, "memberId");
  const role = readWorkspaceRole(formData);

  await auth.api.updateMemberRole({
    headers: requestHeaders,
    body: {
      organizationId,
      memberId,
      role,
    },
  });

  revalidatePath("/configuration/permissions");
}

export async function updateUserPlatformRoleAction(formData: FormData) {
  await requireAdminSession();
  const requestHeaders = await headers();
  const userId = readRequiredString(formData, "userId");
  const role = readPlatformRole(formData);

  await auth.api.setRole({
    headers: requestHeaders,
    body: {
      userId,
      role,
    },
  });

  revalidatePath("/configuration/permissions");
}

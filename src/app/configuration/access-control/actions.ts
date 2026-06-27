// -----------------------------------------------------------------------------
// Access Control admin actions.
//
//   - setSingleOrgModeAction: flip the single-org compatibility
//     toggle. Hides the "Organizations" nav entry + blocks org creation for
//     all users (UI/UX + create-path only; the 4-tier scope model is
//     untouched, existing org records are not migrated).
//   - setRegistrationClosedAction: flip the closed-registration
//     toggle. When closed, no one can self-register (email/password AND social
//     first-login are blocked at the better-auth user.create.before hook);
//     existing users sign in normally and an admin can still create accounts.
//   - setAuditRetentionAction: set the durable audit-log
//     retention window (admin-configurable knob; default 12 months).
//
// All are platform-admin-gated via requireAdminSession.
// -----------------------------------------------------------------------------
"use server";

import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import { setRegistrationClosed, setSingleOrgMode } from "@/lib/authz/instance-mode";
import { setAuditRetentionDays } from "@/lib/authz/audit";

export async function setSingleOrgModeAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const enabled = formData.get("singleOrg") === "on" || formData.get("singleOrg") === "true";
  await setSingleOrgMode(enabled);
  revalidatePath("/configuration/access-control");
  revalidatePath("/", "layout");
}

export async function setRegistrationClosedAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const closed =
    formData.get("registrationClosed") === "on" || formData.get("registrationClosed") === "true";
  await setRegistrationClosed(closed);
  // D6 — revalidate every surface whose render depends on the toggle: the
  // sign-in/sign-up auth pages (notice + signup-footer visibility), this admin
  // page, and the root layout path (the layout reads the flag to pass
  // signUp={false} into the root AuthUIProvider).
  revalidatePath("/sign-in");
  revalidatePath("/sign-up");
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

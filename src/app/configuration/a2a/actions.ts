"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-session";
import {
  createServiceAccount,
  deleteServiceAccount,
  rotateServiceAccount,
  revokeServiceAccount,
} from "@/lib/service-accounts";

// ---------------------------------------------------------------------------
// zod input schemas — enforce length+presence on `name`
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(120),
  // space-separated Permission strings; validated downstream by parseTokenScopes
  scopes: z.string().default(""),
  orgId: z.string().optional().nullable(),
  gracePeriodSeconds: z.coerce.number().int().min(0).max(86400).default(900),
});

// ---------------------------------------------------------------------------
// createServiceAccountAction
// ---------------------------------------------------------------------------

export async function createServiceAccountAction(formData: FormData) {
  const session = await requireAdminSession();
  const parsed = createSchema.parse({
    name: formData.get("name"),
    scopes: formData.get("scopes") ?? "",
    orgId: formData.get("orgId") || null,
    gracePeriodSeconds: formData.get("gracePeriodSeconds") ?? 900,
  });
  const result = await createServiceAccount({
    name: parsed.name,
    scopes: parsed.scopes,
    orgId: parsed.orgId,
    gracePeriodSeconds: parsed.gracePeriodSeconds,
    createdBy: session.user.id,
  });
  revalidatePath("/configuration/permissions");
  // Returns { id, name, orgId, clientId, clientSecret, scopes } — secret shown once
  return result;
}

// ---------------------------------------------------------------------------
// deleteServiceAccountAction — removes both Cinatra row AND oauthClient row
// ---------------------------------------------------------------------------

export async function deleteServiceAccountAction(formData: FormData) {
  await requireAdminSession();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id required");
  await deleteServiceAccount(id);
  revalidatePath("/configuration/permissions");
}

// ---------------------------------------------------------------------------
// rotateServiceAccountAction — produces new clientId/clientSecret pair,
// keeps old clientId valid for grace period
// ---------------------------------------------------------------------------

export async function rotateServiceAccountAction(formData: FormData) {
  await requireAdminSession();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id required");
  const result = await rotateServiceAccount(id);
  revalidatePath("/configuration/permissions");
  return result;
}

// ---------------------------------------------------------------------------
// revokeServiceAccountAction — sets revoked_at; existing tokens fail next call
// ---------------------------------------------------------------------------

export async function revokeServiceAccountAction(formData: FormData) {
  await requireAdminSession();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id required");
  await revokeServiceAccount(id);
  revalidatePath("/configuration/permissions");
}

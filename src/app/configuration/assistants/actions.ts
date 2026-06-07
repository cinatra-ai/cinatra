"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import {
  createAssistantUser,
  deleteAssistantUser,
  rotateAssistantClient,
} from "@/lib/assistant-users";
import { upsertAssistantProfile, deleteAssistantProfile } from "@/lib/assistant-profiles";

export async function createAssistantAction(formData: FormData) {
  await requireAdminSession();
  const username = String(formData.get("username") ?? "").trim();
  if (!username) throw new Error("username required");
  const result = await createAssistantUser({ username });
  revalidatePath("/configuration/assistants");
  // Returns { id, username, clientId, clientSecret } — UI shows secret once
  return result;
}

export async function deleteAssistantAction(formData: FormData) {
  await requireAdminSession();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("id required");
  await deleteAssistantUser(id);
  deleteAssistantProfile(id);
  revalidatePath("/configuration/assistants");
}

export async function rotateAssistantClientAction(formData: FormData) {
  await requireAdminSession();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("id required");
  const result = await rotateAssistantClient(id);
  revalidatePath("/configuration/assistants");
  return result;
}

export async function setAssistantWebhookAction(formData: FormData) {
  await requireAdminSession();
  const assistantUserId = String(formData.get("assistantUserId") ?? "");
  const webhookUrl = String(formData.get("webhookUrl") ?? "").trim() || undefined;
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim() || undefined;
  if (!assistantUserId) throw new Error("assistantUserId required");
  upsertAssistantProfile({
    assistantUserId,
    webhookUrl,
    webhookSecret,
    updatedAt: new Date().toISOString(),
  });
  revalidatePath("/configuration/assistants");
}

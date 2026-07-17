"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import {
  deleteAssistantUser,
  rotateAssistantClient,
} from "@/lib/assistant-users";
import { upsertAssistantProfile, deleteAssistantProfile } from "@/lib/assistant-profiles";

// The manual "create assistant" action was DELETED (cinatra#1037 P1.4): assistant
// PRINCIPAL minting is now the exclusive job of assistant-agent registration
// (src/lib/assistant-agent-registration.ts, invariant I3), so there is no admin
// path that mints a bare assistant user. The remaining actions manage an
// already-registered principal's OAuth client + webhook + lifecycle.

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

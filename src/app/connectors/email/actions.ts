"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import {
  EMAIL_PURPOSES,
  type EmailPurpose,
  setEmailPurposeProvider,
  listEmailProvidersWithStatus,
} from "@/lib/email-system";

function redirectBack(params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`/connectors/email${qs ? `?${qs}` : ""}`);
}

const VALID_PURPOSES = new Set<string>(EMAIL_PURPOSES.map((p) => p.id));

export async function setEmailRoutingAction(formData: FormData): Promise<void> {
  await requireAdminSession();

  const purpose = String(formData.get("purpose") ?? "");
  const connectorId = String(formData.get("connectorId") ?? "").trim();

  // Codes-only flash protocol: emit a STABLE code (never URL-derived text — a
  // provider id / name in the query would be reflected into a toast). The
  // <SearchParamToast> island on /connectors/email maps each code to a STATIC
  // message (EMAIL_FLASH_ERROR_MESSAGES).
  if (!VALID_PURPOSES.has(purpose)) {
    redirectBack({ error: "invalid-purpose" });
  }

  // Empty selection clears the assignment (falls back to single-connected
  // auto-resolution).
  if (!connectorId) {
    setEmailPurposeProvider(purpose as EmailPurpose, null);
    revalidatePath("/connectors/email");
    redirectBack({ saved: "1" });
  }

  // Only allow assigning a provider that is actually registered AND connected
  // at the instance level — prevents wiring platform mail to a dead provider.
  const providers = await listEmailProvidersWithStatus();
  const target = providers.find((p) => p.connectorId === connectorId);
  if (!target) {
    redirectBack({ error: "unknown-provider" });
  }
  if (target.status !== "connected") {
    redirectBack({ error: "provider-not-connected" });
  }
  const purposeDef = EMAIL_PURPOSES.find((p) => p.id === purpose);
  if (purposeDef?.requiresSystemEmail && !target.supportsSystemEmail) {
    redirectBack({ error: "provider-no-system-email" });
  }

  setEmailPurposeProvider(purpose as EmailPurpose, connectorId);
  revalidatePath("/connectors/email");
  redirectBack({ saved: "1" });
}

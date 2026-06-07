"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import {
  saveResendConfig,
  getResendConfig,
  buildResendFrom,
  sendViaResend,
} from "@cinatra-ai/resend-connector";

function redirectBack(params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`/connectors/resend${qs ? `?${qs}` : ""}`);
}

export async function saveResendConfigAction(formData: FormData): Promise<void> {
  await requireAdminSession();

  const fromEmail = String(formData.get("fromEmail") ?? "").trim();
  const fromName = String(formData.get("fromName") ?? "").trim();
  const replyTo = String(formData.get("replyTo") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "on";
  const apiKey = String(formData.get("apiKey") ?? "");
  const clearApiKey = String(formData.get("clearApiKey") ?? "") === "on";

  // Reject the contradictory combination rather than silently picking one.
  if (clearApiKey && apiKey.trim().length > 0) {
    redirectBack({
      error: "Choose either a new API key OR 'remove the in-app key', not both.",
    });
  }

  // Strict email shape — disallow the structural/header chars that could break
  // out of the "Name <email>" From header. Real authority is still Resend's
  // domain verification at send time.
  const EMAIL_RE = /^[^\s<>",;@]+@[^\s<>",;@]+\.[^\s<>",;@]+$/;
  if (fromEmail && !EMAIL_RE.test(fromEmail)) {
    redirectBack({ error: "Sender (From) address is not a valid email." });
  }
  if (replyTo && !EMAIL_RE.test(replyTo)) {
    redirectBack({ error: "Reply-To is not a valid email." });
  }
  // Display name must not carry control chars / newlines (header-injection).
  // eslint-disable-next-line no-control-regex
  if (fromName && /[\u0000-\u001f]/.test(fromName)) {
    redirectBack({ error: "Sender display name contains invalid characters." });
  }

  saveResendConfig({
    enabled,
    fromEmail: fromEmail || undefined,
    fromName: fromName || undefined,
    replyTo,
    apiKey: apiKey.trim().length > 0 ? apiKey : undefined,
    clearApiKey,
  });

  revalidatePath("/connectors/resend");
  revalidatePath("/connectors/email");
  redirectBack({ saved: "1" });
}

export async function sendResendTestEmailAction(): Promise<void> {
  const session = await requireAdminSession();
  const to = session.user.email ?? "";
  if (!to) {
    redirectBack({ error: "Your account has no email address to send a test to." });
  }

  const config = getResendConfig();
  if (!config.fromEmail) {
    redirectBack({ error: "Set a sender (From) address before sending a test." });
  }

  try {
    // Test the Resend provider specifically (NOT the routed platform provider)
    // and only ever to the signed-in admin's own address.
    await sendViaResend({
      from: buildResendFrom(config.fromName, config.fromEmail),
      to: [to],
      subject: "Cinatra Resend test email",
      text:
        "This is a test email from your Cinatra instance, sent via Resend.\n\n" +
        "If you received this, Resend is configured correctly for platform email.",
      replyTo: config.replyTo || undefined,
    });
  } catch (err) {
    redirectBack({
      error: `Test send failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  redirectBack({ notice: `Test email sent to ${to}.` });
}

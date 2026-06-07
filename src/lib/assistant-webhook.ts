import "server-only";

import { createHmac } from "node:crypto";
import { readAssistantProfile } from "./assistant-profiles";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MentionPayload = {
  threadId: string;
  messageId: string;
  content: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// deliverMentionWebhook
//
// Fire-and-forget HMAC-signed POST delivery.
// No retries in v1 — a future task can add a BullMQ retry queue.
// ---------------------------------------------------------------------------

export async function deliverMentionWebhook(
  assistantUserId: string,
  payload: MentionPayload,
): Promise<void> {
  const profile = readAssistantProfile(assistantUserId);
  if (!profile?.webhookUrl) return;

  const body = JSON.stringify(payload);
  const signature = profile.webhookSecret
    ? createHmac("sha256", profile.webhookSecret).update(body).digest("hex")
    : "";

  // Fire and forget — caller must not await
  void fetch(profile.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cinatra-Signature": signature,
      "X-Cinatra-Assistant-Id": assistantUserId,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    console.error(
      "[assistant-webhook] delivery failed:",
      assistantUserId,
      err instanceof Error ? err.message : err,
    );
  });
}

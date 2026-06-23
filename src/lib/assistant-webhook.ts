import "server-only";

import { randomUUID } from "node:crypto";
import { readAssistantProfile } from "./assistant-profiles";
import { BACKGROUND_JOB_NAMES, enqueueBackgroundJob } from "@/lib/background-jobs";

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
// deliverMentionWebhook (cinatra#341)
//
// ENQUEUES delivery onto the ONE host-owned outbound webhook engine
// (WEBHOOK_OUTBOUND_DELIVERY) instead of doing a fire-and-forget HMAC POST.
// The engine signs via Standard-Webhooks (#340 `signOutbound`) and retries with
// exponential backoff + dead-letters exhausted/permanent failures — the
// retry/durability the old path lacked.
//
// SECRET HYGIENE (F1): NEITHER the webhook url NOR the secret goes into the job
// payload. The worker resolves BOTH from `readAssistantProfile(assistantUserId)`
// at each attempt (so the secret never reaches Redis and url/secret can't
// drift). Only `{ assistantUserId, eventKind, messageId, payload }` is enqueued.
//
// `messageId` is a fresh uuid per DELIVERY and serves as the Standard-Webhooks
// webhook-id / receiver idempotency key (STABLE across the engine's retries).
//
// The exported signature is UNCHANGED so the chat caller
// (packages/chat/src/mcp/handlers.ts) is untouched. The whole body is wrapped
// in try/catch (F3): the caller still `void`s this, so a failed enqueue must
// never surface as an unhandled rejection.
//
// OUTBOUND CONTRACT CHANGE (F2): the signature scheme moved from the legacy
// `X-Cinatra-Signature: <hmac-sha256-hex>` header to the Standard-Webhooks
// triplet (`webhook-id` / `webhook-timestamp` / `webhook-signature`). The
// assistant identity is PRESERVED as the `X-Cinatra-Assistant-Id` extra header
// (applied by the engine). External assistant receivers must switch to
// Standard-Webhooks verification — see docs/webhooks/outbound-delivery.md.
// ---------------------------------------------------------------------------

export async function deliverMentionWebhook(
  assistantUserId: string,
  payload: MentionPayload,
): Promise<void> {
  try {
    const profile = readAssistantProfile(assistantUserId);
    if (!profile?.webhookUrl) return;

    // Fresh per-delivery message id = the Standard-Webhooks webhook-id and the
    // receiver's idempotency key; STABLE across the engine's retry attempts.
    const messageId = randomUUID();

    await enqueueBackgroundJob(
      BACKGROUND_JOB_NAMES.WEBHOOK_OUTBOUND_DELIVERY,
      {
        // NO url and NO secret here (F1) — the worker resolves both from
        // assistantUserId at each attempt.
        assistantUserId,
        eventKind: "assistant.mention",
        messageId,
        payload,
      },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        // System context: this is a worker-bound delivery, not a user action.
        inheritActorContext: false,
      },
    );
  } catch (err) {
    // The chat caller `void`s this — swallow so a failed enqueue never becomes
    // an unhandled rejection (F3).
    console.error(
      "[assistant-webhook] enqueue failed:",
      assistantUserId,
      err instanceof Error ? err.message : err,
    );
  }
}

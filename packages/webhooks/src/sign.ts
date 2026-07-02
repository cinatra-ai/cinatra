// Standard-Webhooks OUTBOUND signing (cinatra#340).
//
// The API surface for signing webhooks the host SENDS. Actual delivery (the
// BullMQ outbound pipeline) is cinatra#341; this is the verified-correct
// signing primitive that pipeline will call, shipped now so the round-trip
// (sign here → verify in verify.ts) is provable as ONE convention.
//
// Library contract (empirically confirmed against standardwebhooks@1.0.0):
// `Webhook(secret).sign(msgId, timestamp, payload)` returns ONLY the signature
// STRING (`"v1,<base64>"`), NOT a header map. So we construct the full
// Standard-Webhooks header set ourselves:
//   webhook-id        — the message id
//   webhook-timestamp — seconds since epoch (string)
//   webhook-signature — the library's signature string
// and return the EXACT signed `body` string so the sender transmits the same
// bytes that were signed (re-serializing the payload downstream would break the
// signature).

import { Webhook } from "standardwebhooks";

export interface SignedOutbound {
  /** The exact request body string that was signed (send these bytes verbatim). */
  readonly body: string;
  /** The Standard-Webhooks headers to attach to the outbound request. */
  readonly headers: {
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
  };
}

/**
 * Sign an outbound webhook payload.
 *
 * @param secret    The per-binding Standard-Webhooks secret.
 * @param messageId A unique message id (the `webhook-id`; also the receiver's
 *                  idempotency key).
 * @param timestamp The signing timestamp.
 * @param payload   The JSON-serializable payload.
 */
export function signOutbound(
  secret: string,
  messageId: string,
  timestamp: Date,
  payload: unknown,
): SignedOutbound {
  const body = JSON.stringify(payload);
  const signature = new Webhook(secret).sign(messageId, timestamp, body);
  return {
    body,
    headers: {
      "webhook-id": messageId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": signature,
    },
  };
}

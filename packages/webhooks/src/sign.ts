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
  return signOutboundRaw(secret, messageId, timestamp, JSON.stringify(payload));
}

/**
 * Sign an EXACT signed-content string (no JSON envelope).
 *
 * The Standard-Webhooks signature is computed over `<id>.<ts>.<body>` where
 * `body` is an opaque byte string — the spec does not require JSON. Some
 * receivers authenticate a REQUEST rather than a payload by agreeing on a
 * canonical signed content that is NOT the request body: the WordPress plugin's
 * authenticated preview route (wordpress-plugin#94) verifies a GET by
 * recomputing the signature over the canonical string `preview.<postId>` and
 * comparing constant-time, so the signature is bound to that post id and there
 * is no body to send at all.
 *
 * {@link signOutbound} JSON-encodes its payload, so signing `"preview.7"`
 * through it would sign the seven-byte-longer quoted form `"\"preview.7\""` and
 * never verify. This is the same primitive with the encoding step removed: the
 * caller supplies the exact bytes both ends agreed on.
 *
 * @param secret    The per-binding Standard-Webhooks secret (`whsec_`-prefixed
 *                  or bare base64).
 * @param messageId A unique message id (the `webhook-id`; also the receiver's
 *                  replay key — mint a fresh one per attempt).
 * @param timestamp The signing timestamp (the receiver enforces freshness).
 * @param body      The EXACT canonical signed content.
 */
export function signOutboundRaw(
  secret: string,
  messageId: string,
  timestamp: Date,
  body: string,
): SignedOutbound {
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

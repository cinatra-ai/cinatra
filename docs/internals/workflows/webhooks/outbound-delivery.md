# Outbound webhook delivery

Cinatra signs and delivers every outbound webhook through ONE host-owned engine
(`WEBHOOK_OUTBOUND_DELIVERY`, a BullMQ job in `src/lib/background-jobs.ts`). The
engine signs with [Standard-Webhooks](https://www.standardwebhooks.com/) (the
same convention the inbound facility verifies, via `signOutbound` /
`deliverOutbound` in `@cinatra-ai/webhooks`), retries transient failures with
exponential backoff, and dead-letters exhausted or permanently-failed deliveries
into the durable `webhook_outbound_dead_letter` table.

## Signature scheme (what receivers verify)

Every outbound request carries the three Standard-Webhooks headers:

| Header              | Meaning                                                            |
| ------------------- | ----------------------------------------------------------------- |
| `webhook-id`        | A unique message id. Also the **idempotency key** — STABLE across retries of the same delivery, so a receiver can dedupe replays. |
| `webhook-timestamp` | Seconds since epoch, **regenerated on each attempt** so a delayed retry stays inside the receiver's tolerance window. |
| `webhook-signature` | The Standard-Webhooks signature (`v1,<base64>`) over the exact request body. |

The body is `application/json`. Verify the **exact bytes** received — do not
re-serialize the JSON before verifying, or the signature will not match.

### Verifying with the `standardwebhooks` library

```ts
import { Webhook } from "standardwebhooks";

// `secret` is the shared webhook secret configured for your receiver.
const wh = new Webhook(secret);
// `rawBody` is the exact request body string; `headers` is a plain object
// keyed by the lowercased header names above.
const payload = wh.verify(rawBody, {
  "webhook-id": headers["webhook-id"],
  "webhook-timestamp": headers["webhook-timestamp"],
  "webhook-signature": headers["webhook-signature"],
});
```

`verify` throws on a bad signature, a missing header, or a stale/future
timestamp, and otherwise returns the parsed payload.

## Migrating an assistant `@mention` receiver (BREAKING)

Before this change, the assistant `@mention` webhook was a fire-and-forget POST
signed with a legacy header:

```
X-Cinatra-Signature: <hmac-sha256-hex of the body, keyed by your webhook secret>
```

It is now signed with the Standard-Webhooks triplet above. **This is an outbound
contract break**: a receiver that validates `X-Cinatra-Signature` must switch to
Standard-Webhooks verification (see the snippet above) using the same configured
secret.

The assistant identity is **preserved** — the request still carries:

```
X-Cinatra-Assistant-Id: <assistant user id>
```

This is an extra header (not a Standard-Webhooks reserved header), so receivers
that key off the assistant id keep working unchanged.

## Retries and dead-lettering

- **Delivered** — any `2xx`. Done.
- **Retryable** — `408` / `425` / `429` / any `5xx`, plus network errors and
  timeouts. The engine retries with exponential backoff (default 5 attempts,
  base 2s). The `webhook-id` stays the same across attempts so a receiver
  dedupes; only `webhook-timestamp` advances.
- **Permanent** — any other `4xx`, a missing/unresolvable target, or a webhook
  secret the signer cannot use. Not retried.

A delivery that exhausts its retries **or** fails permanently is recorded once in
`webhook_outbound_dead_letter`. That row stores a `payload_digest` (a sha256 of
the payload — never the raw payload or the secret) and the target URL reduced to
origin + path (query string and credentials stripped), so the table never
becomes a place secrets can leak.

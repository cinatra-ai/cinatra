# @cinatra-ai/webhooks

The reusable **inbound + outbound webhook facility** for the host and its
extensions (cinatra#340/#341). The host owns the generic public route, the
secret store, and the idempotency ledger; a connector owns only its per-hook
handlers. The package carries no connector-specific vocabulary — every host
detail (secret service, storage, namespace) is injected as a parameter.

## What it provides

- **Standard-Webhooks verify/sign primitives** — `verifyInbound`,
  `signOutbound`, plus `verifyLegacyHmac` for pre-migration callers, and the
  `WebhookVerifyFailedError` raised on a bad signature.
- **The import-free handler registry** — `createWebhookRegistry` /
  `webhookScopeKey` resolve a generated `"<vendor>/<slug>/<hook>"` map (no
  dynamic `import()` of connector code at request time).
- **The leased idempotency state machine** — `IdempotencyLedger` claims a
  delivery, exposes its `ClaimDisposition`/`FinalizeStatus`, and finalizes once,
  so a redelivered event is processed at most once.
- **The per-webhook / per-site secret-service contract** — `mintWebhookSecret`,
  `mintBindingId`, and the `WebhookSecretService` / `ResolvedBinding` types. The
  route resolves identity from the server-issued opaque `bindingId`, never from
  the payload.
- **Outbound delivery** — `deliverOutbound` signs and POSTs an outbound event
  with the request/options/result types for the host's retry+DLQ delivery
  engine.
- **The schema helper** — `createWebhookTables` for the idempotency and
  secret-binding rows.

## Boundary

The host wires this package behind the generic route
`/webhook/<vendor>/<slug>/<hook>/<bindingId>` and the BullMQ outbound-delivery
engine; connectors contribute handlers by declaring `cinatra.webhooks` in their
manifest. The public route 404s safely for any unknown vendor/slug/hook/binding.

See the platform reference [Extension webhooks and streams](https://docs.cinatra.ai/references/platform/extension-webhooks-and-streams/)
for the end-to-end contract.

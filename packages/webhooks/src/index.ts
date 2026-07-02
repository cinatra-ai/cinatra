// Public surface for the reusable inbound-webhook facility (cinatra#340).
//
// The host owns the generic route, the secret store, and the idempotency
// ledger; connectors own only the per-hook handlers. This barrel exposes the
// Standard-Webhooks verify/sign primitives, the import-free registry, the
// leased idempotency state machine, and the secret-service contract.
//
// LIVE since #343: the host route, secret store, and idempotency ledger are
// wired and serving. An extension contributes handlers by declaring
// `cinatra.webhooks`; until one does the generated registry is empty and the
// route 404s every request safely.

export * from "./types";

export { verifyInbound, verifyLegacyHmac, WebhookVerifyFailedError } from "./verify";
export type { VerifiedInbound } from "./verify";

export { signOutbound } from "./sign";
export type { SignedOutbound } from "./sign";

export { deliverOutbound } from "./outbound";
export type {
  OutboundDeliveryRequest,
  OutboundDeliveryOptions,
  OutboundDeliveryResult,
  OutboundTransport,
  OutboundEgressLookup,
} from "./outbound-types";

export {
  assertEgressAllowed,
  buildPinnedAgent,
  classifyIpLiteral,
  isEgressBlock,
  EgressBlockedError,
  EGRESS_BLOCKED,
} from "./egress-guard";
export type {
  EgressLookup,
  EgressGuardOptions,
  LookupAddress,
} from "./egress-guard";

export {
  createWebhookRegistry,
  webhookScopeKey,
} from "./registry";
export type {
  RegisteredWebhook,
  GeneratedWebhookHandlers,
  WebhookRegistry,
} from "./registry";

export { IdempotencyLedger } from "./idempotency";
export type {
  IdempotencyLedgerOptions,
  WebhookLedgerQuery,
  ClaimDisposition,
  FinalizeStatus,
} from "./idempotency";

export {
  mintWebhookSecret,
  mintBindingId,
} from "./secret-service";
export type {
  WebhookSecretService,
  ResolvedBinding,
  MintBindingInput,
  MintedBinding,
  UpsertLegacyBindingInput,
} from "./secret-service";

export { createWebhookTables } from "./schema";
export type {
  WebhookTables,
  WebhookIdempotencyRow,
  WebhookSecretBindingRow,
} from "./schema";

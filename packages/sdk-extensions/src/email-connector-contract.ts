// Shared cross-extension EMAIL provider contract.
//
// Lives in the SDK (not in `@cinatra-ai/email-connector`) so a concrete provider
// — `resend-connector`, `gmail-connector`, a future smtp/ses connector — depends
// ONLY on the SDK for these types and never imports the email-connector facade
// package. The facade (`sendEmailThroughSystem`, the registry) stays in
// `@cinatra-ai/email-connector`; this module is the provider-neutral, types-only
// capability contract behind the `email-send` capability.

/**
 * Provider/connector metadata descriptor — the non-behavioural half of an email
 * connector (id, display, capability bits). The behavioural half is `EmailConnector`.
 */
export type EmailConnectorDefinition = {
  connectorId: string;
  name: string;
  slug: string;
  description: string;
  settingsHref: string;
  supportsOAuth?: boolean;
  supportsApiKey?: boolean;
  supportsCustomFrom?: boolean;
  /**
   * True when the connector can send using INSTANCE-level credentials with no
   * per-user connection — required for platform/system mail (password reset,
   * email verification, change-email confirmation) which fires pre-auth. A
   * per-user OAuth provider (e.g. gmail) leaves this false: its getStatus()
   * may report "connected" from app-level OAuth config, but it cannot send
   * without an authenticated user, so it must NOT be eligible for platform
   * routing. Eligibility is gated on this flag, never inferred from getStatus().
   */
  supportsSystemEmail?: boolean;
  /**
   * Connection-scope discriminator for PER-USER routing surfaces. `"user"` =
   * the connector represents an individual user's mailbox connection (e.g. a
   * per-user OAuth provider) and is eligible for the host's per-user
   * active-connector resolution; `"instance"` (and absent, for backward
   * compatibility) = an instance-level transport that must NOT be auto-picked
   * as a user's personal mailbox even when its instance credentials report
   * "connected". Deliberately independent of `supportsSystemEmail` — the two
   * flags gate opposite routing surfaces.
   */
  connectionScope?: "user" | "instance";
};

/**
 * Discriminator for which transport actually sent / received a message.
 * Provider-neutral by design — `"gmail"` today; expected to widen to
 * `"smtp" | "ses" | "outlook" | ...` as new providers register. Kept `string`
 * so the contract does not enumerate concrete providers.
 */
export type EmailConnectorId = string;

/**
 * Provider-agnostic outbound message envelope. Mirrors RFC 5322 minus
 * provider-specific transport flags.
 */
export type EmailSystemMessage = {
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  providerThreadId?: string;
  inReplyTo?: string;
  references?: string[];
};

/**
 * Provider-agnostic send receipt. The exact set of provider-side IDs varies
 * (Gmail returns messageId + threadId + internetMessageId; SES returns a
 * MessageId only); all three optional slots are preserved so each provider can
 * fill what it knows.
 */
export type EmailSendReceipt = {
  providerId: EmailConnectorId;
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  sentAt: string;
};

/**
 * Provider-agnostic reply match. Returned by `EmailConnector.findReply` when the
 * connector observes an inbound message resolving to a thread we sent earlier.
 */
export type EmailReplyMatch = {
  providerId: EmailConnectorId;
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  fromEmail: string;
  subject: string;
  snippet?: string;
  receivedAt: string;
};

/**
 * Provider-agnostic connection status. `connected` = ready to send;
 * `incomplete` = configured but not ready (e.g. OAuth pending verification);
 * `not_connected` = no credentials.
 */
export type EmailConnectorStatusResult = {
  status: "connected" | "incomplete" | "not_connected";
  accountEmail?: string;
  detail?: string;
};

/**
 * The capability contract every transport-email connector implements. Providers
 * expose a singleton conforming to this shape (e.g. `resendEmailConnector`)
 * which the host facade registers — and which other extensions resolve through
 * the `email-send` capability — without importing the provider package.
 *
 * The interface is intentionally NARROW — anything provider-specific (Gmail
 * aliases, SES configuration sets, SMTP credentials) stays inside the provider
 * package and is NOT part of this contract.
 */
export interface EmailConnector {
  /** Provider metadata descriptor (id, name, slug, settingsHref, capability bits). */
  readonly definition: EmailConnectorDefinition;

  /** Send a message via this provider; return a normalized receipt. */
  send(msg: EmailSystemMessage, opts?: { userId?: string }): Promise<EmailSendReceipt>;

  /** Look for a reply in the given thread newer than `sentAfter`, if any. */
  findReply(opts: {
    providerThreadId?: string;
    recipientEmail: string;
    sentAfter?: string;
    userId?: string;
  }): Promise<EmailReplyMatch | null>;

  /** Connection status — used by the host's installed-connectors UI. */
  getStatus(opts?: { userId?: string }): Promise<EmailConnectorStatusResult>;

  /**
   * OPTIONAL: list From-addresses this provider can send as (Gmail aliases, SES
   * verified identities, etc.). Connectors that don't support multiple
   * From-addresses omit this and the facade falls back to the connected account.
   */
  listFromAddresses?(opts?: { userId?: string }): Promise<Array<{ email: string; displayName?: string }>>;
}

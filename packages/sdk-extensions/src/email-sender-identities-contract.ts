// Email sender-identities capability contract (cinatra#151 Stage 4).
//
// A connector that holds per-user VERIFIED sender identities (e.g. gmail's
// synced send-as aliases) contributes them STRUCTURED through the generic
// capability registry — the chat-user-context pattern's structured sibling.
// The host's HITL field-renderer-context loader (packages/agents) resolves
// the live providers and aggregates per-app identities instead of importing
// a connector package by name.
//
// Contract expectations for providers:
//   - `app` is the provider-agnostic app slug ("gmail", a future "smtp", …) —
//     NEVER a package name (package identity already rides the provider
//     record's `packageName`).
//   - `getSenderIdentities` is called with the CURRENT user's id (or
//     undefined for an anonymous/system context). It must be cheap and local
//     (read already-synced state; no network round-trips) and return `[]`
//     when there is nothing to contribute.
//   - Sync or async returns are both accepted; the consumer awaits.
//
// Consumer-side hardening mirrors the chat-user-context consumer:
// deterministic provider order (sorted by packageName), structural shape
// validation, per-provider failure isolation (a throwing provider is skipped
// with a warning — it must never fail the loader).

/** Capability id under which email sender-identity providers register. */
export const EMAIL_SENDER_IDENTITIES_CAPABILITY_ID = "email-sender-identities";

/** One verified sender identity. */
export type EmailSenderIdentity = {
  email: string;
  displayName?: string;
};

/** The provider implementation a connector registers for the capability. */
export type EmailSenderIdentitiesProvider = {
  /** Provider-agnostic app slug (e.g. "gmail") — not a package name. */
  app: string;
  /** The user's verified sender identities; `[]` when none are synced. */
  getSenderIdentities(input: {
    userId?: string;
  }): EmailSenderIdentity[] | Promise<EmailSenderIdentity[]>;
};

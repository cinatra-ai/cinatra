// Chat user-context contribution contract.
//
// A connector that holds per-user state the chat assistant should know about
// (e.g. verified send-as addresses, appointment booking pages) contributes
// PRE-FORMATTED prompt sections through the generic capability registry instead
// of the chat runner importing the connector package by name. At
// `register(ctx)` the connector calls
// `ctx.capabilities.registerProvider("chat-user-context", { packageName, impl })`;
// the chat runner resolves the live providers and appends each returned section
// to the chat turn's user-context block.
//
// TRUST BOUNDARY (explicit, reviewed): a chat-user-context section is SYSTEM
// PROMPT TEXT. Whoever can register this capability can inject instructions
// into every chat turn. That trust is the SAME trust already granted to an
// activated extension's other register-channel surfaces (an activated extension
// can already register MCP tools the chat calls); registration is
// activation-gated (an archived/uninstalled extension never registers, and
// teardown invalidates its providers) and the `capabilities` host port is
// grant-gated via `requestedHostPorts`. The consumer additionally validates
// shape (string sections only), isolates provider failures, and orders
// providers deterministically — but it does NOT sanitize content. Do not grant
// the `capabilities` port to an extension you would not let speak in the chat
// system prompt.
//
// Contract expectations for providers:
//   - `buildSections` is called per chat turn with the CURRENT user's id (or
//     undefined for an anonymous/system turn). It must be cheap and local
//     (read already-synced state; no network round-trips — the chat turn is
//     latency-sensitive and the consumer may impose a deadline).
//   - Return one string per section; return `[]` when there is nothing to say.
//   - Sections are appended verbatim; the provider owns its formatting.

/** Capability id under which chat user-context providers register. */
export const CHAT_USER_CONTEXT_CAPABILITY_ID = "chat-user-context";

/** The provider implementation a connector registers for the capability. */
export type ChatUserContextContributor = {
  /**
   * Build the pre-formatted user-context sections for the current chat user.
   * Cheap + local by contract; failures are isolated by the consumer (a
   * throwing provider is skipped with a warning, never failing the chat turn).
   */
  buildSections(input: { userId?: string }): string[] | Promise<string[]>;
};

/**
 * The full provider record as it sits in the capability registry
 * (`{ packageName, impl }` — keyed by `packageName`, so re-registration by the
 * same package idempotently replaces).
 */
export type ChatUserContextProviderRecord = {
  packageName: string;
  impl: ChatUserContextContributor;
};

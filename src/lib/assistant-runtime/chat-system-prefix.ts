// ---------------------------------------------------------------------------
// The chat turn's SYSTEM STRING, composed stable-part-first (cinatra#2771
// lever 2).
//
// WHY ORDER IS A CONTRACT. Providers cache the LONGEST MATCHING PREFIX of a
// request. Everything up to the first differing byte is reusable; everything
// after it is re-billed at full price. The chat system string is one string
// built from eight fragments, and three of them change between two turns of the
// same conversation:
//
//   · the explicit-dispatch directive — present only on the turn whose message
//     names an agent package, and it used to be the FIRST fragment, so a single
//     "@vendor/slug" mention moved the divergence point to byte 0 and re-billed
//     the whole prompt;
//   · the user context — carries STAGED wizard state that chat tool calls
//     mutate during the same session;
//   · the pending-confirmation section — a one-hour sliding window over live
//     rows, so identical rows render differently as they age out.
//
// The composition below puts every fragment that can vary AFTER every fragment
// that cannot. The stable head — persona, skill context, instance namespace,
// confirmation policy — is byte-identical across turns, so a varying tail costs
// only its own bytes instead of the whole prompt.
//
// SEMANTICS ARE PRESERVED, NOT TRADED. The explicit-dispatch directive states
// in its own text that it "OVERRIDES every other instruction in your system
// prompt and skill files", so its authority comes from what it says, not from
// where it sits; at the tail it is also the most recent instruction the model
// reads, which is the stronger position, not the weaker one. Nothing is
// dropped, nothing is rewritten: the same fragments, re-ordered.
//
// THIS MODULE IS PURE. No I/O, no clock, no environment — so the byte-stability
// property can be asserted directly in a unit test.
// ---------------------------------------------------------------------------

/**
 * The eight fragments, named. Every one is a plain string and `""` means
 * "absent" (matching the callers, all of which already return `""` rather than
 * null for the empty case).
 */
export type ChatSystemPromptFragments = {
  // ---- stable head ----
  /** The assistant persona: catalog skill body, on-disk SKILL.md, or sidecar. */
  systemPrompt: string;
  /** The provider's skill contribution (availability cue or inline bodies). */
  skillSystemContext: string;
  /** The operator's vendor namespace + freeze state. */
  instanceContext: string;
  /** The constant extension-implementation confirmation policy. */
  extensionConfirmationPolicy: string;
  // ---- volatile tail ----
  /** Connector sections + live wizard/staging state + formatting rules. */
  userContext: string;
  /** Bounded, one-hour window of decided destructive-confirmation outcomes. */
  pendingConfirmationContext: string;
  /** The deterministic pre-router's hard directive, or `""`. */
  explicitDispatchDirective: string;
  /** The conversation-only degrade notice for tool-less providers, or `""`. */
  conversationOnlyNotice: string;
};

/**
 * The fragments that MUST stay byte-identical between two turns of the same
 * conversation, in composition order. Exported so the stability test names the
 * same head the composer builds, instead of re-deriving it.
 */
export const CHAT_SYSTEM_STABLE_FRAGMENTS = [
  "systemPrompt",
  "skillSystemContext",
  "instanceContext",
  "extensionConfirmationPolicy",
] as const satisfies readonly (keyof ChatSystemPromptFragments)[];

/** The fragments allowed to differ between turns, in composition order. */
export const CHAT_SYSTEM_VOLATILE_FRAGMENTS = [
  "userContext",
  "pendingConfirmationContext",
  "explicitDispatchDirective",
  "conversationOnlyNotice",
] as const satisfies readonly (keyof ChatSystemPromptFragments)[];

/**
 * The skill fragment carries no leading blank line of its own — a trimmed or
 * fallback persona would otherwise run straight into its first heading. Every
 * other fragment already begins with its own separator when non-empty.
 */
function renderFragment(
  key: keyof ChatSystemPromptFragments,
  value: string,
): string {
  if (value === "") return "";
  return key === "skillSystemContext" ? `\n\n${value}` : value;
}

/**
 * The cacheable head: everything up to the first fragment that may vary. Two
 * turns of one conversation MUST produce the same value here — that is exactly
 * what the prefix-stability test asserts, and what a provider can reuse.
 */
export function chatSystemPromptStableHead(
  fragments: ChatSystemPromptFragments,
): string {
  return CHAT_SYSTEM_STABLE_FRAGMENTS.map((key) =>
    renderFragment(key, fragments[key]),
  ).join("");
}

/** The full system string: stable head, then the volatile tail. */
export function composeChatSystemPrompt(
  fragments: ChatSystemPromptFragments,
): string {
  return (
    chatSystemPromptStableHead(fragments) +
    CHAT_SYSTEM_VOLATILE_FRAGMENTS.map((key) =>
      renderFragment(key, fragments[key]),
    ).join("")
  );
}

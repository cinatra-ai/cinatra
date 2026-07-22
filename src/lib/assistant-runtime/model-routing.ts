// Assistant-level model-routing decisions (cinatra#1875 W2, Epic #1873 — AC#5).
//
// The PURE half of the runtime's model seam, extracted so it is unit-testable
// without the runtime's server-only/LLM/DB import graph. Two decisions:
//
//   1. `selectAdapterProvider` — which provider the assistant's `modelPrefs`
//      routes to: a pinned `provider` selects EXACTLY that adapter; an empty
//      pref falls back to the platform default resolver (byte-parity with the
//      legacy chat, where the default adapter was always chosen).
//   2. `isConversationOnlyProvider` / `conversationOnlyNoticeFor` — the
//      capability-degraded conversation-only mode. A provider with NO native MCP
//      support (Gemini today) runs tool-less instead of hard-rejecting, with an
//      explicit user-facing notice so a tool-needing request degrades visibly
//      rather than silently. Superseded by #1717 native-MCP activation.
//
// Framework-free (no server-only, no import of the runtime or the LLM package).

import type { ModelPrefs } from "@/lib/assistant-config";

/**
 * Providers that cannot host the Cinatra self-MCP / connector tools because they
 * lack NATIVE MCP support. They run in conversation-only mode until #1717 lands
 * native-MCP activation. Kept a data list so a newly-activated provider is
 * removed in one place.
 */
export const PROVIDERS_WITHOUT_NATIVE_MCP = ["gemini"] as const;

/** True when a resolved adapter's provider must run tool-less (conversation-only). */
export function isConversationOnlyProvider(provider: string): boolean {
  return (PROVIDERS_WITHOUT_NATIVE_MCP as readonly string[]).includes(provider);
}

/**
 * The provider the assistant's model prefs route to, or `null` to use the
 * platform default adapter. A trimmed-empty/absent `provider` ⇒ null (default).
 */
export function selectAdapterProvider(modelPrefs: ModelPrefs): string | null {
  const p = typeof modelPrefs.provider === "string" ? modelPrefs.provider.trim() : "";
  return p.length > 0 ? p : null;
}

/**
 * The system-prompt notice appended in conversation-only mode. EMPTY for
 * tool-capable providers so their system string is byte-identical to before.
 */
export function conversationOnlyNoticeFor(conversationOnly: boolean): string {
  return conversationOnly
    ? "\n\nNOTE: you are running in conversation-only mode for this model — the " +
        "platform tools (Cinatra MCP, connector tools, skills, web search) are NOT " +
        "available. Answer conversationally from your own knowledge. If a request " +
        "genuinely requires a platform tool or a live action, say so explicitly and " +
        "suggest the user switch to a tool-capable assistant — never pretend to have " +
        "performed the action."
    : "";
}

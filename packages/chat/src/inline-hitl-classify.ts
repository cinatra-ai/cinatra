/**
 * The chat-side inline HITL gate REGISTRY.
 *
 * WHAT USED TO LIVE HERE, AND WHERE IT WENT (cinatra#2934, lifecycle-b W5c).
 * This module also held the last three pre-model readers on the chat page: the
 * deterministic ladder that turned a typed sentence into a gate submit
 * (`classifyPromptForGate`), the required-field policy for the hidden second
 * model that guessed when the ladder could not (`resolveExtractedGateValues`),
 * and the routing arm that reached them (`resolveComposerRouting`). All three
 * are gone, together with the server action and the internal skill package that
 * served them.
 *
 * Their replacement is the plan's own (PLAN: Agents Lifecycle (B), §4, the
 * replacement table): "The HITL screen lends its own fill and submit controls.
 * The assistant fills what the form asks for and asks you about what it cannot
 * work out, in the conversation, where you can answer." The run whose screen is
 * waiting now travels with the message, the server mints that screen's own
 * reference under the reader's access, and the conversation's assistant fills
 * and — when asked in so many words — submits through the card's own paths.
 *
 * WHAT REMAINS IS THE REGISTRY, and it is not a reader: it records WHICH run has
 * a screen open so the composer can name that run. It reads no sentence and
 * decides nothing about one.
 */

import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";

// ---------------------------------------------------------------------------
// Chat-side inline HITL gate registry (cinatra#853 — the chat/run gate
// concern split out of chat-page.tsx). A pure closure factory, NOT a hook:
// chat-page holds one instance in state so the function identities are
// stable across renders (the handler is threaded to InlineAgentRunCard).
// Kept in THIS module (rather than its own file) so the /chat route's
// first-party module graph does not grow — the route-graph ratchet ceiling
// only ever shrinks.
// ---------------------------------------------------------------------------

/**
 * Told when a registered gate's entry is CLEARED and the descriptor it held
 * named a lifecycle card (cinatra#2853, the picture leg).
 *
 * This is the "from the gate row" half of the same-session settle: the panel
 * publishes `null` for a run whose gate has closed, so the registry is the first
 * thing on this page that knows a decided card is stale — earlier than the
 * turn's own end whenever the decision was taken anywhere but this turn.
 */
export type ChatGateClosedListener = (cardRef: string) => void;

export type ChatGateRegistry = {
  /** AgenticRunPanel's onActiveGateChange (threaded through
   *  InlineAgentRunCard). Registers an OPEN gate by runId; a `null` gate
   *  clears the entry ONLY if the registry still holds the SAME instanceId —
   *  a remounted card for the same runId must not be clobbered by an older
   *  instance's unmount. */
  handleActiveGateChange: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
  /** The most-recently-registered OPEN gate, or undefined when none. */
  getLatestOpenGate: () => ChatGateDescriptor | undefined;
};

/**
 * Create the runId-keyed registry of OPEN inline HITL gates. Multiple
 * InlineAgentRunCards can mount (one per agent_run tool result); the
 * runId-keyed map prevents an older card from clobbering a newer gate.
 * `getLatestOpenGate` relies on Map insertion order (re-`set()` of an
 * existing runId keeps its original position), matching the previous
 * inline chat-page behavior exactly.
 */
export function createChatGateRegistry(onGateClosed?: ChatGateClosedListener): ChatGateRegistry {
  const gates = new Map<string, ChatGateDescriptor>();
  return {
    handleActiveGateChange(runId, gate, instanceId) {
      if (gate) {
        gates.set(runId, gate);
      } else {
        const current = gates.get(runId);
        if (current && current.instanceId === instanceId) {
          gates.delete(runId);
          // THE CARD THAT GATE BELONGED TO IS NOW STALE. Only a descriptor that
          // NAMES a card can say which one, and only the clearing that actually
          // removed the entry says it once — a second unmount of an older
          // instance has already been refused above.
          if (current.kind === "review_comment" && typeof current.cardRef === "string") {
            onGateClosed?.(current.cardRef);
          }
        }
      }
    },
    getLatestOpenGate() {
      const openGates = Array.from(gates.values());
      return openGates[openGates.length - 1];
    },
  };
}

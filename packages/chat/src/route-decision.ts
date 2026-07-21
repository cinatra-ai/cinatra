/**
 * Pure message-ROUTING DECISION (cinatra#1875 W2, Epic #1873 — AC#2).
 *
 * The single decision that turns a message's audience-scoped mention
 * CLASSIFICATION (`./classify-mentions`) into a {@link MessageRoutingResult} the
 * `/chat` client consumes. It is the retirement site of the hardcoded
 * `chatgpt`/`gemini` routing that used to live in `actions.ts`: there is NO
 * literal-handle comparison here — an assistant dispatches because it is a
 * REGISTERED, IN-AUDIENCE assistant with a DECLARED delivery (via the
 * {@link planAssistantDispatch} planner), never because its handle is a known
 * built-in.
 *
 * Ruling (Epic #1873 plan-of-record, 2026-07-21, M1/M2): there is no built-in
 * assistant class and no `@chatgpt` token. The former `@chatgpt` built-in route
 * is GONE — an `@chatgpt` mention now resolves to nothing (delisted), so it is an
 * HONEST NO-RESPONDER (see the no-assistant branch), never a hidden route. The
 * OpenAI assistant returns as the `@openai` connector-backed package in W6.
 *
 * The two invariants held byte-for-byte from the retired `resolveMessageRouting`:
 *   - @cinatra is the implicit HOST DEFAULT — it is NOT run through the planner
 *     (it has no external delivery); a `@cinatra`-only message and a no-mention
 *     message both stream the host reply attributed to the Cinatra principal.
 *   - the broadcast branch (tagged participants, no explicit assistant mention)
 *     is unchanged.
 *
 * PURE given the classification + a delivery lookup + the pre-resolved Cinatra
 * host principal (all built server-side in `./server-audience-resolver`) — so the
 * whole routing decision is unit-testable without a DB, a session, or the network.
 */

import { assistantMentions, type MentionClassification } from "./classify-mentions";
import {
  planAssistantDispatch,
  HOST_RUNTIME_ENDPOINT,
  type AssistantDeliveryLookup,
} from "./dispatch-planner";
import type { MessageRoutingResult } from "./chat-routing";
import type { Mention } from "./types";

/** The implicit host-default handle. @cinatra is never routed through the planner
 *  (it carries no external delivery) — it is the platform host reply. */
export const CINATRA_HANDLE = "cinatra";

/** The broadcast context the `/chat` client passes from React state (tagged +
 *  paused participants + the id→handle map). Identical to the retired signature. */
export type RoutingBroadcastContext = {
  taggedAssistantUserIds: string[];
  pausedParticipants: string[];
  handleMap: Record<string, string>;
};

export type RouteDecisionInput = {
  /** The audience-scoped classification of the message's mention tokens. */
  classified: readonly MentionClassification[];
  /** The declared-delivery lookup for the classified assistants (from the W1
   *  registry entries). */
  deliveryFor: AssistantDeliveryLookup;
  /** The pre-resolved Cinatra host principal id (for host-reply attribution), or
   *  null when it is not yet seeded. */
  cinatraHostId: string | null;
  /** Optional broadcast context (tagged participants). */
  broadcastContext?: RoutingBroadcastContext;
};

/** A push directive → a pending external mention (assistantUserId is what the
 *  poll/mentionState consumers key on; offset/length are unused there). */
function pushToMention(d: { handle: string; assistantUserId: string }): Mention {
  return { handle: d.handle, assistantUserId: d.assistantUserId, offset: 0, length: 0 };
}

/**
 * Decide the routing for one message. See the module header for the invariants.
 * Pure.
 */
export function decideMessageRouting(input: RouteDecisionInput): MessageRoutingResult {
  const { classified, deliveryFor, cinatraHostId, broadcastContext } = input;
  const assistants = assistantMentions(classified);

  if (assistants.length > 0) {
    // @cinatra is the host default, NOT a planner directive — split it out so the
    // planner sees only the DECLARED (external-capable) assistants.
    const cinatra = assistants.find((a) => a.handle === CINATRA_HANDLE);
    const declaredClassified = classified.filter(
      (c) => !(c.kind === "assistant" && c.handle === CINATRA_HANDLE),
    );
    const plan = planAssistantDispatch(declaredClassified, deliveryFor);
    const pushMentions = plan.push.map(pushToMention);

    if (plan.hostRuntime.length > 0) {
      // A DECLARED host-runtime assistant streams in-band over the unified AG-UI
      // producer endpoint — the GENERALIZED former built-in path, now attributed
      // to the assistant's OWN registry principal (never a hardcoded handle
      // table). Last mention wins the single in-band stream slot (mirrors the
      // retired lastExternal preference).
      //
      // The in-band stream occupies the message's single `mentions` slot (the UI
      // attaches `hostRuntimeMention` as the user message's sole mention), so we
      // do NOT ALSO surface co-mentioned webhook/mcp-poll pushes here — that would
      // hand the client a contradictory `mentions`/`mentionState` pair (the
      // host-runtime replace clobbers the push's id→handle mapping while its
      // pending state lingers). This matches the retired built-in branch, which
      // likewise took priority and did not co-dispatch externals. (@cinatra +
      // webhook — the common co-mention — is unaffected: it flows through the
      // `cinatra` branch below, which carries no `hostRuntimeMention`.)
      const active = plan.hostRuntime[plan.hostRuntime.length - 1];
      return {
        shouldCallLlm: true,
        activeHandle: active.handle,
        chatEndpoint: active.endpoint ?? HOST_RUNTIME_ENDPOINT,
        hostRuntimeMention: {
          handle: active.handle,
          assistantUserId: active.assistantUserId,
          offset: 0,
          length: 0,
        },
      };
    }

    if (cinatra) {
      // @cinatra present (with or without co-mentioned webhook assistants): the
      // host Cinatra reply streams, attributed to the Cinatra principal. Any
      // webhook/mcp-poll co-mentions persist pending. Byte-parity with the
      // retired L398-412 branch for the @cinatra-only case (pushMentions empty →
      // activeHandle "cinatra", no externalMentions, hostAssistantUserId set).
      return {
        shouldCallLlm: true,
        activeHandle: pushMentions[pushMentions.length - 1]?.handle ?? CINATRA_HANDLE,
        ...(pushMentions.length > 0 ? { externalMentions: pushMentions } : {}),
        ...(cinatra.assistantUserId ? { hostAssistantUserId: cinatra.assistantUserId } : {}),
      };
    }

    // Only webhook/mcp-poll declared assistants (no @cinatra, no host-runtime):
    // persist pending and show the wait-external indicator (Cinatra takeover on
    // timeout). Byte-parity with the retired allExternal branch.
    return {
      shouldCallLlm: false,
      activeHandle: pushMentions[pushMentions.length - 1]?.handle,
      externalMentions: pushMentions,
    };
  }

  // No in-audience assistant mention.
  const tagged = broadcastContext?.taggedAssistantUserIds ?? [];
  const paused = broadcastContext?.pausedParticipants ?? [];
  const handleMap = broadcastContext?.handleMap ?? {};

  if (tagged.length > 0) {
    // Broadcast: fire every non-paused tagged assistant; Cinatra also replies
    // unless paused. Unchanged from the retired broadcast branch (the
    // silent-reply-bug fix: an explicit human/unresolved mention still honors
    // pausedParticipants + taggedAssistantUserIds).
    const activeExternalIds = tagged.filter((id) => !paused.includes(id));
    const externalMentions: Mention[] = activeExternalIds
      .map((id): Mention | null => {
        const handle = handleMap[id];
        return handle ? { handle, assistantUserId: id, offset: 0, length: 0 } : null;
      })
      .filter((m): m is Mention => m !== null);
    const cinatraPaused = paused.includes(CINATRA_HANDLE);
    const hostId = cinatraPaused ? null : cinatraHostId;
    return {
      shouldCallLlm: !cinatraPaused,
      externalMentions: externalMentions.length > 0 ? externalMentions : undefined,
      isBroadcast: true,
      ...(hostId ? { hostAssistantUserId: hostId } : {}),
    };
  }

  if (classified.length > 0) {
    // The message carried @-tokens but NONE resolved to an in-audience assistant
    // (an unknown/delisted handle like @chatgpt post-ruling, a human tag, or a
    // scoped agent-dispatch ref) AND there is no tagged broadcast participant:
    // HONEST NO-RESPONDER — the message posts, nothing streams, nothing hangs
    // (the #1935 delisted pattern: `{ kind: "none" }` in resolveDispatchPlan).
    // Distinct from the true no-mention default below, which keeps the @cinatra
    // host reply (byte-parity L448-450).
    return { shouldCallLlm: false, isBroadcast: true };
  }

  // Default: no @-mention at all → the host Cinatra assistant replies, attributed
  // to the Cinatra principal (byte-parity with the retired L448-450 default).
  return {
    shouldCallLlm: true,
    ...(cinatraHostId ? { hostAssistantUserId: cinatraHostId } : {}),
  };
}

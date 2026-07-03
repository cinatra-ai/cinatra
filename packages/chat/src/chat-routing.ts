// ---------------------------------------------------------------------------
// Chat message-routing seam (cinatra#918 — split out of chat-page.tsx).
// ---------------------------------------------------------------------------
// Pure decision helpers extracted from sendMessage. The server-side routing
// resolution itself stays in ./actions (resolveMessageRouting); this module
// owns the CLIENT-side decisions around it: the cheap synchronous Slack-mode
// entry check, the mention-state message transforms, and the dispatch plan
// derived from a routing result. All logic is moved unchanged; each helper is
// a pure function so the contracts are unit-testable.

import type { Mention } from "./types";
import type { UiMessage } from "./types";

/** Cinatra takeover delay while waiting for an external assistant's reply. */
export const EXTERNAL_TAKEOVER_MS = 20_000;

/**
 * Cheap synchronous mention count. resolveMessageRouting is async; this regex
 * check is sufficient to switch to Slack mode NOW — in the same synchronous
 * batch as setMessages — so the message is never rendered in normal
 * (right-aligned) mode. Applies to all messages (not just the first) to handle
 * human-user tags and built-in assistant tags (@chatgpt) that produce no
 * externalMentions.
 */
export function countMentions(text: string): number {
  return (text.match(/@[a-z0-9_-]+/gi) ?? []).length;
}

export function shouldEnterSlackModeOnSend(args: {
  isSlackMode: boolean;
  taggedAssistantCount: number;
  mentionCount: number;
}): boolean {
  const { isSlackMode, taggedAssistantCount, mentionCount } = args;
  return !isSlackMode && ((taggedAssistantCount >= 1 && mentionCount >= 1) || mentionCount >= 2);
}

/**
 * Attach mentions + pending mentionState to the just-sent user message so
 * external assistants get polled. Pure (prev) => next transform.
 */
export function applyExternalMentionsToMessages(
  prev: UiMessage[],
  userMessageId: string,
  externalMentions: Mention[],
): UiMessage[] {
  const mentionState: Record<string, "pending" | "handled"> = {};
  for (const m of externalMentions) mentionState[m.assistantUserId] = "pending";
  return prev.map((m) =>
    m.id === userMessageId ? { ...m, mentions: externalMentions, mentionState } : m,
  );
}

/**
 * Attach the mention for a built-in assistant so assistantHandleMap resolves
 * its handle → name. Pure (prev) => next transform.
 */
export function applyBuiltInMentionToMessages(
  prev: UiMessage[],
  userMessageId: string,
  builtInMention: Mention,
): UiMessage[] {
  return prev.map((m) =>
    m.id === userMessageId ? { ...m, mentions: [builtInMention] } : m,
  );
}

/** Newly-tagged external assistant ids from a routing result's mentions. */
export function collectNewlyTaggedIds(externalMentions: Mention[] | undefined): string[] {
  return (externalMentions ?? [])
    .map((m) => m.assistantUserId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Shape of the routing result this seam consumes (see actions.ts). */
export type MessageRoutingResult = {
  shouldCallLlm: boolean;
  activeHandle?: string;
  externalMentions?: Mention[];
  isBroadcast?: boolean;
  chatEndpoint?: string;
  builtInMention?: Mention;
};

export type DispatchPlan =
  /** Broadcast fired to external assistants but Cinatra is paused — nothing more to do locally. */
  | { kind: "none" }
  /** Only external assistants are active — show the waiting indicator and arm the takeover timer. */
  | { kind: "wait-external"; handle: string }
  /** Dispatch the Cinatra/built-in stream. */
  | { kind: "stream"; endpoint: string; authorUserId?: string };

/**
 * Derive the dispatch plan from a routing result. `nextActiveHandle` is the
 * handle AFTER applying the routing result to component state (the caller
 * computes it the same way it always did); `fallbackHandle` mirrors the
 * `?? activeHandle ?? "the assistant"` chain of the original code.
 */
export function resolveDispatchPlan(
  routing: MessageRoutingResult,
  nextActiveHandle: string | undefined,
): DispatchPlan {
  if (routing.isBroadcast && !routing.shouldCallLlm) {
    return { kind: "none" };
  }
  if (!routing.shouldCallLlm && !routing.isBroadcast) {
    return {
      kind: "wait-external",
      handle: nextActiveHandle ?? routing.activeHandle ?? "the assistant",
    };
  }
  if (routing.shouldCallLlm) {
    return {
      kind: "stream",
      endpoint: routing.chatEndpoint ?? "/api/chat",
      authorUserId: routing.builtInMention?.assistantUserId,
    };
  }
  // shouldCallLlm=false + isBroadcast=true is covered by the first branch;
  // this fall-through cannot be reached but keeps the function total.
  return { kind: "none" };
}

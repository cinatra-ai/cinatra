// Pure client-side routing seam (cinatra#918 — split out of chat-page.tsx's
// sendMessage). Pins the Slack-entry check, the mention transforms, and the
// dispatch-plan derivation so the component wiring cannot drift.

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_TAKEOVER_MS,
  countMentions,
  shouldEnterSlackModeOnSend,
  applyExternalMentionsToMessages,
  applyBuiltInMentionToMessages,
  collectNewlyTaggedIds,
  resolveDispatchPlan,
} from "../chat-routing";
import type { Mention, UiMessage } from "../types";

const userMsg = (id = "u1"): UiMessage => ({ id, role: "user", content: "hi @claude" });

const mention = (over: Partial<Mention> = {}): Mention => ({
  handle: "claude",
  assistantUserId: "au-1",
  offset: 3,
  length: 7,
  ...over,
});

describe("countMentions / shouldEnterSlackModeOnSend", () => {
  it("counts @handle tokens with the original regex", () => {
    expect(countMentions("hi @claude and @gpt-4")).toBe(2);
    expect(countMentions("email me at a@b — not a mention count of zero? it is one")).toBe(1);
    expect(countMentions("no mentions")).toBe(0);
  });

  it("enters Slack mode on tagged-thread single mention or fresh double mention", () => {
    expect(shouldEnterSlackModeOnSend({ isSlackMode: false, taggedAssistantCount: 1, mentionCount: 1 })).toBe(true);
    expect(shouldEnterSlackModeOnSend({ isSlackMode: false, taggedAssistantCount: 0, mentionCount: 2 })).toBe(true);
    expect(shouldEnterSlackModeOnSend({ isSlackMode: false, taggedAssistantCount: 0, mentionCount: 1 })).toBe(false);
    // Already in Slack mode → never re-triggers.
    expect(shouldEnterSlackModeOnSend({ isSlackMode: true, taggedAssistantCount: 3, mentionCount: 3 })).toBe(false);
  });
});

describe("mention transforms", () => {
  it("attaches mentions + pending mentionState to the sent user message only", () => {
    const other: UiMessage = { id: "a0", role: "assistant", content: "prev" };
    const m = mention();
    const next = applyExternalMentionsToMessages([other, userMsg()], "u1", [m]);
    expect(next[0]).toBe(other);
    expect(next[1].mentions).toEqual([m]);
    expect(next[1].mentionState).toEqual({ "au-1": "pending" });
  });

  it("attaches the built-in mention without mentionState", () => {
    const m = mention({ handle: "chatgpt" });
    const next = applyBuiltInMentionToMessages([userMsg()], "u1", m);
    expect(next[0].mentions).toEqual([m]);
    expect(next[0].mentionState).toBeUndefined();
  });

  it("collects only non-empty assistantUserIds", () => {
    expect(collectNewlyTaggedIds([mention(), mention({ assistantUserId: "" })])).toEqual(["au-1"]);
    expect(collectNewlyTaggedIds(undefined)).toEqual([]);
  });
});

describe("resolveDispatchPlan", () => {
  it("paused-Cinatra broadcast → none", () => {
    expect(resolveDispatchPlan({ shouldCallLlm: false, isBroadcast: true }, undefined)).toEqual({ kind: "none" });
  });

  it("external-only → wait-external with the handle fallback chain", () => {
    expect(resolveDispatchPlan({ shouldCallLlm: false, activeHandle: "claude" }, "claude")).toEqual({
      kind: "wait-external",
      handle: "claude",
    });
    expect(resolveDispatchPlan({ shouldCallLlm: false, activeHandle: "claude" }, undefined)).toEqual({
      kind: "wait-external",
      handle: "claude",
    });
    expect(resolveDispatchPlan({ shouldCallLlm: false }, undefined)).toEqual({
      kind: "wait-external",
      handle: "the assistant",
    });
  });

  it("LLM turn → stream with endpoint default and built-in author id", () => {
    expect(resolveDispatchPlan({ shouldCallLlm: true }, undefined)).toEqual({
      kind: "stream",
      endpoint: "/api/assistants/chat",
      authorUserId: undefined,
    });
    expect(
      resolveDispatchPlan(
        { shouldCallLlm: true, isBroadcast: true, chatEndpoint: "/api/assistants/chatgpt", builtInMention: mention({ assistantUserId: "b-1" }) },
        "chatgpt",
      ),
    ).toEqual({ kind: "stream", endpoint: "/api/assistants/chatgpt", authorUserId: "b-1" });
  });

  it("keeps the 20s takeover window", () => {
    expect(EXTERNAL_TAKEOVER_MS).toBe(20_000);
  });
});

// Pure client-side routing seam (cinatra#918 — split out of chat-page.tsx's
// sendMessage). Pins the Slack-entry check, the mention transforms, and the
// dispatch-plan derivation so the component wiring cannot drift.

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_TAKEOVER_MS,
  countMentions,
  shouldEnterSlackModeOnSend,
  applyExternalMentionsToMessages,
  applyHostRuntimeMentionToMessages,
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
  it("counts flat + scoped mention tokens via the shared tokenizer (cinatra#1875 AC#1)", () => {
    expect(countMentions("hi @claude and @gpt-4")).toBe(2);
    // A scoped `@vendor/slug` ref counts as ONE token (not vendor + slug).
    expect(countMentions("run @cinatra-ai/gemini-assistant now")).toBe(1);
    expect(countMentions("@claude and @cinatra-ai/x")).toBe(2);
    // Email guard: an address local-part no longer counts (was a false positive
    // under the old flat regex).
    expect(countMentions("email me at a@b.com — not a mention")).toBe(0);
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

  it("attaches the host-runtime assistant mention without mentionState", () => {
    const m = mention({ handle: "openai" });
    const next = applyHostRuntimeMentionToMessages([userMsg()], "u1", m);
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

  it("LLM turn → stream with endpoint default and host-runtime author id", () => {
    expect(resolveDispatchPlan({ shouldCallLlm: true }, undefined)).toEqual({
      kind: "stream",
      endpoint: "/api/assistants/chat",
      authorUserId: undefined,
    });
    // A declared host-runtime assistant streams over the UNIFIED endpoint,
    // attributed to its own principal (cinatra#1875 W2 AC#2 — no @chatgpt route).
    expect(
      resolveDispatchPlan(
        { shouldCallLlm: true, chatEndpoint: "/api/assistants/chat", hostRuntimeMention: mention({ handle: "openai", assistantUserId: "b-1" }) },
        "openai",
      ),
    ).toEqual({ kind: "stream", endpoint: "/api/assistants/chat", authorUserId: "b-1" });
  });

  it("host Cinatra reply carries the host principal as authorUserId (P2.4 attribution)", () => {
    expect(resolveDispatchPlan({ shouldCallLlm: true, hostAssistantUserId: "cinatra-9" }, undefined)).toEqual({
      kind: "stream",
      endpoint: "/api/assistants/chat",
      authorUserId: "cinatra-9",
    });
  });

  it("a host-runtime assistant author wins over the host fallback", () => {
    expect(
      resolveDispatchPlan(
        {
          shouldCallLlm: true,
          chatEndpoint: "/api/assistants/chat",
          hostRuntimeMention: mention({ handle: "openai", assistantUserId: "b-1" }),
          hostAssistantUserId: "cinatra-9",
        },
        "openai",
      ),
    ).toEqual({ kind: "stream", endpoint: "/api/assistants/chat", authorUserId: "b-1" });
  });

  it("keeps the 20s takeover window", () => {
    expect(EXTERNAL_TAKEOVER_MS).toBe(20_000);
  });
});

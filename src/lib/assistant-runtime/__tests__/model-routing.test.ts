// cinatra#1875 W2 (Epic #1873) — AC#5: assistant-level model routing decisions.
// The pure seam the runtime consumes: provider selection + the conversation-only
// (no-native-MCP) degrade.

import { describe, expect, it } from "vitest";
import {
  selectAdapterProvider,
  isConversationOnlyProvider,
  conversationOnlyNoticeFor,
  PROVIDERS_WITHOUT_NATIVE_MCP,
} from "../model-routing";

describe("selectAdapterProvider — modelPrefs.provider selects the adapter", () => {
  it("returns the pinned provider when set", () => {
    expect(selectAdapterProvider({ provider: "anthropic" })).toBe("anthropic");
    expect(selectAdapterProvider({ provider: "gemini", model: "gemini-2.5" })).toBe("gemini");
  });

  it("returns null (platform default) for an empty / whitespace / absent provider", () => {
    expect(selectAdapterProvider({})).toBeNull();
    expect(selectAdapterProvider({ provider: "" })).toBeNull();
    expect(selectAdapterProvider({ provider: "   " })).toBeNull();
    // A model-only pref still uses the default provider resolver.
    expect(selectAdapterProvider({ model: "gpt-5" })).toBeNull();
  });
});

describe("isConversationOnlyProvider — no-native-MCP degrade", () => {
  it("flags gemini as conversation-only (no native MCP)", () => {
    expect(isConversationOnlyProvider("gemini")).toBe(true);
    expect(PROVIDERS_WITHOUT_NATIVE_MCP).toContain("gemini");
  });

  it("does NOT flag tool-capable providers", () => {
    expect(isConversationOnlyProvider("openai")).toBe(false);
    expect(isConversationOnlyProvider("anthropic")).toBe(false);
  });
});

describe("conversationOnlyNoticeFor — explicit degrade notice, not a silent drop", () => {
  it("appends a user-facing tools-unavailable notice in conversation-only mode", () => {
    const notice = conversationOnlyNoticeFor(true);
    expect(notice).toMatch(/conversation-only mode/i);
    expect(notice).toMatch(/not.*available|unavailable|NOT/i);
    // Instructs the model to be explicit, never fake the action.
    expect(notice).toMatch(/never pretend/i);
  });

  it("is EMPTY for tool-capable providers (byte-identical system string)", () => {
    expect(conversationOnlyNoticeFor(false)).toBe("");
  });
});

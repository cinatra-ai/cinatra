// Pure SSE streaming seam (cinatra#918 — split out of chat-page.tsx).
// Each applier is the former inline setMessages updater body; these tests pin
// the extracted contracts so the thin driver in chat-page.tsx cannot drift.

import { describe, expect, it } from "vitest";
import {
  parseSseEventBlock,
  extractErrorMessage,
  extractAgentRunId,
  normalizeCitations,
  mergeCitations,
  applyTextDeltaToMessages,
  applyThinkingStartToMessages,
  applyThinkingEndToMessages,
  applyToolCallToMessages,
  applyToolResultToMessages,
  applyCitationsToMessages,
  applyErrorToMessages,
  createSlackBuffers,
  appendSlackTextDelta,
  applySlackThinkingStart,
  applySlackThinkingEnd,
  applySlackToolCall,
  applySlackToolResult,
} from "../chat-stream-events";
import type { UiMessage } from "../types";

const assistant = (over: Partial<UiMessage> = {}): UiMessage => ({
  id: "a1",
  role: "assistant",
  content: "",
  thoughtGroups: [],
  parts: [],
  liveStatus: "Thinking",
  ...over,
});

describe("parseSseEventBlock", () => {
  it("parses the event/data contract", () => {
    expect(parseSseEventBlock('event: text\ndata: {"content":"hi"}')).toEqual({
      evt: "text",
      data: { content: "hi" },
    });
  });

  it("returns null for non-matching blocks and invalid JSON", () => {
    expect(parseSseEventBlock("comment only")).toBeNull();
    expect(parseSseEventBlock("event: text\ndata: not-json")).toBeNull();
  });
});

describe("applyTextDeltaToMessages", () => {
  it("appends the delta and maintains the parts trace", () => {
    const next = applyTextDeltaToMessages([assistant()], "a1", "Hello", false);
    expect(next[0].content).toBe("Hello");
    expect(next[0].parts).toEqual([{ kind: "text", content: "Hello" }]);
    // Visible text clears the liveStatus.
    expect(next[0].liveStatus).toBeUndefined();
  });

  it("inserts the round separator only when consuming the flag after non-whitespace", () => {
    const base = assistant({ content: "First round.", parts: [{ kind: "text", content: "First round." }] });
    const next = applyTextDeltaToMessages([base], "a1", "Second", true);
    expect(next[0].content).toBe("First round.\n\nSecond");
    // No separator when flag not consumed…
    const noFlag = applyTextDeltaToMessages([base], "a1", "Second", false);
    expect(noFlag[0].content).toBe("First round.Second");
    // …or when the existing tail is whitespace.
    const ws = assistant({ content: "First " });
    expect(applyTextDeltaToMessages([ws], "a1", "x", true)[0].content).toBe("First x");
  });

  it("is a pure function of prev (safe under updater replay) and ignores other messages", () => {
    const other = assistant({ id: "b2", content: "keep" });
    const prev = [other, assistant()];
    const once = applyTextDeltaToMessages(prev, "a1", "x", true);
    const twice = applyTextDeltaToMessages(prev, "a1", "x", true);
    expect(once).toEqual(twice);
    expect(once[0]).toBe(other); // untouched identity
  });
});

describe("thinking events", () => {
  it("thinking_start seeds one main group and sets liveStatus", () => {
    const next = applyThinkingStartToMessages([assistant({ thoughtGroups: undefined, liveStatus: undefined })], "a1");
    expect(next[0].thoughtGroups).toEqual([{ id: "main", toolCalls: [] }]);
    expect(next[0].liveStatus).toBe("Thinking");
    // Existing groups are preserved.
    const seeded = next[0];
    const again = applyThinkingStartToMessages([seeded], "a1");
    expect(again[0].thoughtGroups).toBe(seeded.thoughtGroups);
  });

  it("thinking_end accumulates seconds on the group", () => {
    const seeded = applyThinkingStartToMessages([assistant()], "a1");
    const next = applyThinkingEndToMessages(applyThinkingEndToMessages(seeded, "a1", 2), "a1", 3);
    expect(next[0].thoughtGroups?.[0].thinkingSeconds).toBe(5);
    // No group → no-op.
    const bare = assistant({ thoughtGroups: undefined });
    expect(applyThinkingEndToMessages([bare], "a1", 2)[0]).toBe(bare);
  });
});

describe("tool events", () => {
  it("tool_call appends a running tool, dedupes by id, and sets progress liveStatus", () => {
    const ev = { id: "t1", name: "web_search", serverLabel: undefined };
    const once = applyToolCallToMessages([assistant()], "a1", ev);
    const group = once[0].thoughtGroups?.[0];
    expect(group?.toolCalls).toEqual([{ id: "t1", name: "web_search", status: "running", serverLabel: undefined }]);
    expect(once[0].liveStatus).toBe("Searching the web");
    expect(once[0].parts?.at(-1)).toMatchObject({ kind: "tool_call", id: "t1", status: "running" });
    // Retry-safe dedupe.
    const twice = applyToolCallToMessages(once, "a1", ev);
    expect(twice[0]).toBe(once[0]);
  });

  it("tool_result completes the matching tool, preserves omitted serverLabel, pins runId on parts", () => {
    const started = applyToolCallToMessages([assistant()], "a1", { id: "t1", name: "agent_run", serverLabel: "cinatra" });
    const done = applyToolResultToMessages(started, "a1", { id: "t1", resultLabel: "Run started", serverLabel: undefined, runId: "run-9" });
    const tc = done[0].thoughtGroups?.[0].toolCalls[0];
    expect(tc).toMatchObject({ status: "completed", resultLabel: "Run started", serverLabel: "cinatra" });
    expect(done[0].liveStatus).toBe("Reviewing tool results");
    expect(done[0].parts?.find((p) => p.kind === "tool_call")).toMatchObject({ runId: "run-9" });
    // No group → no-op.
    const bare = assistant({ thoughtGroups: undefined });
    expect(applyToolResultToMessages([bare], "a1", { id: "t1", resultLabel: "" })[0]).toBe(bare);
  });
});

describe("citations + errors", () => {
  it("normalizeCitations fills indexes/titles and drops url-less entries", () => {
    expect(normalizeCitations([
      { index: 3, title: "A", url: "https://a" },
      { title: "no-url" },
      { url: "https://b" },
      null,
      "junk",
    ])).toEqual([
      { index: 3, title: "A", url: "https://a" },
      { index: 3, title: "", url: "https://b" },
    ]);
    expect(normalizeCitations(undefined)).toEqual([]);
  });

  it("mergeCitations dedupes by url keeping first-seen order", () => {
    const merged = mergeCitations(
      [{ index: 1, title: "A", url: "https://a" }],
      [{ index: 2, title: "A2", url: "https://a" }, { index: 3, title: "B", url: "https://b" }],
    );
    expect(merged.map((c) => c.url)).toEqual(["https://a", "https://b"]);
    expect(merged[0].title).toBe("A");
  });

  it("applyCitationsToMessages merges into the assistant message", () => {
    const withCite = assistant({ citations: [{ index: 1, title: "A", url: "https://a" }] });
    const next = applyCitationsToMessages([withCite], "a1", [{ index: 2, title: "B", url: "https://b" }]);
    expect(next[0].citations?.map((c) => c.url)).toEqual(["https://a", "https://b"]);
  });

  it("applyErrorToMessages extracts the friendly message and keeps the raw", () => {
    const raw = JSON.stringify({ error: { message: "Provider down" } });
    const next = applyErrorToMessages([assistant()], "a1", raw);
    expect(next[0].error).toBe("Provider down");
    expect(next[0].errorRaw).toBe(raw);
  });

  it("extractErrorMessage falls back for empty and oversized bodies", () => {
    expect(extractErrorMessage("")).toBe("Something went wrong. Please try again.");
    expect(extractErrorMessage("x".repeat(301))).toBe("The request failed. Please try again in a moment.");
    expect(extractErrorMessage("plain failure")).toBe("plain failure");
  });
});

describe("extractAgentRunId", () => {
  it("parses agent_run result JSON and is silent on anything else", () => {
    expect(extractAgentRunId("agent_run", JSON.stringify({ runId: "r1", status: "queued" }))).toBe("r1");
    expect(extractAgentRunId("agent_run", "not json")).toBeUndefined();
    expect(extractAgentRunId("agent_run", JSON.stringify({ runId: "" }))).toBeUndefined();
    expect(extractAgentRunId("other_tool", JSON.stringify({ runId: "r1" }))).toBeUndefined();
    expect(extractAgentRunId("agent_run", 42)).toBeUndefined();
  });
});

describe("slack buffers", () => {
  it("accumulates text with the same separator rule", () => {
    const buf = createSlackBuffers();
    appendSlackTextDelta(buf, "First.", false);
    appendSlackTextDelta(buf, "Second", true);
    expect(buf.text).toBe("First.\n\nSecond");
    appendSlackTextDelta(buf, "", true);
    expect(buf.text).toBe("First.\n\nSecond");
  });

  it("mirrors the tool-call lifecycle incl. serverLabel preservation", () => {
    const buf = createSlackBuffers();
    applySlackThinkingStart(buf);
    applySlackThinkingStart(buf); // idempotent seed
    expect(buf.thoughtGroups).toHaveLength(1);
    applySlackToolCall(buf, { id: "t1", name: "wp.list", serverLabel: "wordpress-connector" });
    applySlackToolCall(buf, { id: "t1", name: "wp.list", serverLabel: "wordpress-connector" }); // dedupe
    expect(buf.thoughtGroups[0].toolCalls).toHaveLength(1);
    applySlackToolResult(buf, { id: "t1", resultLabel: "3 posts", serverLabel: undefined });
    expect(buf.thoughtGroups[0].toolCalls[0]).toMatchObject({
      status: "completed",
      resultLabel: "3 posts",
      serverLabel: "wordpress-connector", // preserved when the event omits one
    });
    applySlackThinkingEnd(buf, 4);
    expect(buf.thoughtGroups[0].thinkingSeconds).toBe(4);
  });
});

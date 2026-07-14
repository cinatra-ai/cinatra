import { describe, expect, it } from "vitest";

import {
  CHAT_CAPTURE_MAX_MESSAGE_LENGTH,
  runChatCaptureLexicalPrefilter,
} from "../detector";

describe("chat-capture lexical pre-filter (stage 1 — zero-LLM gate)", () => {
  it("passes standing-instruction shapes", () => {
    const positives = [
      "Always answer in German.",
      "never use emojis in your replies",
      "From now on, cite your sources.",
      "Please stop prefixing answers with a summary",
      "remember that our fiscal year starts in April",
      "I prefer short bullet-point answers",
      "call me Sam, not Samuel",
      "Use tabs instead of spaces when you write code for me",
      "no, that's wrong — use the staging endpoint",
      "Make sure to include a TL;DR every time",
      "By default, respond in English",
    ];
    for (const text of positives) {
      expect(runChatCaptureLexicalPrefilter(text), text).toEqual({ pass: true });
    }
  });

  it("rejects ordinary turns (questions, one-off tasks, small talk)", () => {
    const negatives = [
      "What's the capital of France?",
      "Can you draft a blog post about our Q3 launch?",
      "thanks, that looks great!",
      "Summarize this article for me",
      "hi",
    ];
    for (const text of negatives) {
      const result = runChatCaptureLexicalPrefilter(text);
      expect(result.pass, text).toBe(false);
    }
  });

  it("rejects empty / whitespace-only input", () => {
    expect(runChatCaptureLexicalPrefilter("")).toEqual({ pass: false, reason: "empty" });
    expect(runChatCaptureLexicalPrefilter("   \n ")).toEqual({ pass: false, reason: "empty" });
  });

  it("excludes pasted content: over-length messages even when they contain instruction shapes", () => {
    const pasted = `always remember this\n${"lorem ipsum dolor sit amet ".repeat(200)}`;
    expect(pasted.length).toBeGreaterThan(CHAT_CAPTURE_MAX_MESSAGE_LENGTH);
    expect(runChatCaptureLexicalPrefilter(pasted)).toEqual({
      pass: false,
      reason: "pasted-content",
    });
  });

  it("excludes pasted content: two or more fenced code blocks", () => {
    const pasted = [
      "never mind the logs, here's the dump:",
      "```",
      "ERROR foo",
      "```",
      "```",
      "ERROR bar",
      "```",
    ].join("\n");
    expect(runChatCaptureLexicalPrefilter(pasted)).toEqual({
      pass: false,
      reason: "pasted-content",
    });
  });

  it("still passes a short instruction containing one code fence pair", () => {
    const text = "Always format SQL like this:\n```\nSELECT 1;\n```";
    expect(runChatCaptureLexicalPrefilter(text)).toEqual({ pass: true });
  });
});

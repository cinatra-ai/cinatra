import { describe, it, expect } from "vitest";
import {
  linkifyErrorText,
  isOpenAiKeyError,
  LLM_PROVIDER_SETTINGS_HREF,
} from "../agent-error-display";

describe("linkifyErrorText (#498)", () => {
  it("splits the OpenAI 401 message into text + a clickable URL, period excluded", () => {
    const msg =
      "401 Incorrect API key provided: sk-proj-****fl4A. You can find your API key at https://platform.openai.com/account/api-keys.";
    const segs = linkifyErrorText(msg);
    const link = segs.find((s) => s.kind === "link");
    expect(link).toMatchObject({
      kind: "link",
      href: "https://platform.openai.com/account/api-keys",
    });
    // the trailing period stays as text, not part of the href
    expect(segs[segs.length - 1]).toEqual({ kind: "text", value: "." });
    // lossless: segments round-trip to the original string
    expect(segs.map((s) => s.value).join("")).toBe(msg);
  });

  it("returns a single text segment when there is no URL", () => {
    expect(linkifyErrorText("plain error, no link")).toEqual([
      { kind: "text", value: "plain error, no link" },
    ]);
  });

  it("handles multiple URLs and stays lossless", () => {
    const msg = "see https://a.com and https://b.com now";
    const segs = linkifyErrorText(msg);
    expect(segs.filter((s) => s.kind === "link").map((s) => s.href)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(segs.map((s) => s.value).join("")).toBe(msg);
  });

  it("exposes the in-app provider settings route", () => {
    expect(LLM_PROVIDER_SETTINGS_HREF).toBe("/configuration/llm?modal=openai");
  });
});

describe("isOpenAiKeyError (#498)", () => {
  it("flags an OpenAI API-key failure (the CTA's exact case)", () => {
    expect(
      isOpenAiKeyError(
        "401 Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.",
      ),
    ).toBe(true);
    expect(isOpenAiKeyError("OpenAI: invalid api key")).toBe(true);
  });

  it("does NOT flag cases that would misroute to the OpenAI key modal", () => {
    // bare auth failures (often from a tool/connector, not the AI key)
    expect(isOpenAiKeyError("Tool 'github' failed: 401 Unauthorized")).toBe(false);
    expect(isOpenAiKeyError("Request failed: 401 Unauthorized")).toBe(false);
    // a tool's own API-key error — not the OpenAI provider key
    expect(isOpenAiKeyError("Tool 'github' failed: Invalid API key")).toBe(false);
    // another provider's key error — wrong modal
    expect(isOpenAiKeyError("authentication_error: invalid x-api-key")).toBe(false);
    expect(isOpenAiKeyError("Tool 'search' failed: timeout after 30s")).toBe(false);
    expect(isOpenAiKeyError("424 Failed Dependency")).toBe(false);
  });
});

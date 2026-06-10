/**
 * OpenAI hosted-shell capability facts (issue #47).
 *
 * The single shared set behind every shell-skill-delivery surface (chat
 * runner gate + llm-bridge route). Only the base gpt-5 and gpt-5-mini lack
 * hosted-shell support; unknown / empty ids are treated as supported so the
 * API stays the final arbiter for models we have no negative evidence about.
 */
import { describe, it, expect } from "vitest";
import {
  OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS,
  openAiModelSupportsShell,
} from "../providers/openai-model-capabilities";

describe("openAiModelSupportsShell", () => {
  it("rejects the hosted shell tool for base gpt-5 and gpt-5-mini", () => {
    expect(openAiModelSupportsShell("gpt-5")).toBe(false);
    expect(openAiModelSupportsShell("gpt-5-mini")).toBe(false);
  });

  it("accepts hosted-shell-capable models (gpt-5.4 / gpt-5.5 families)", () => {
    expect(openAiModelSupportsShell("gpt-5.5")).toBe(true);
    expect(openAiModelSupportsShell("gpt-5.4")).toBe(true);
    expect(openAiModelSupportsShell("gpt-5.4-mini")).toBe(true);
  });

  it("treats unknown and empty model ids as supported (API is the arbiter)", () => {
    expect(openAiModelSupportsShell("")).toBe(true);
    expect(openAiModelSupportsShell("some-future-model")).toBe(true);
  });

  it("keeps the incompatible set to exactly the documented two models", () => {
    // Adding a model here must be a deliberate, doc-backed decision — the
    // chat runner and llm-bridge both degrade skill delivery off this set.
    expect([...OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS].sort()).toEqual([
      "gpt-5",
      "gpt-5-mini",
    ]);
  });
});

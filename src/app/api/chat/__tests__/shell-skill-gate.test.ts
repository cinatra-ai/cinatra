/**
 * Chat shell-skill delivery gate (issue #47).
 *
 * The chat runner must NEVER attach the native `type:"shell"` skill tool to
 * an OpenAI request whose model rejects it — OpenAI 400s the whole turn
 * ("Tool 'shell' is not supported with gpt-5"), which made chat unusable when
 * the connection's defaultModel was gpt-5 (legacy persisted value from before
 * the gpt-5.5 default, or the free-text model input on /setup/ai).
 *
 * The gate keys on adapter.defaultModel because runChatTurn passes no
 * per-request model: the adapter default IS the model the request uses.
 */
import { describe, it, expect } from "vitest";
import { shouldDeliverChatShellSkillTools } from "../shell-skill-gate";

describe("shouldDeliverChatShellSkillTools", () => {
  it("blocks shell skill delivery for shell-incompatible OpenAI models", () => {
    expect(
      shouldDeliverChatShellSkillTools({ provider: "openai", defaultModel: "gpt-5" }),
    ).toBe(false);
    expect(
      shouldDeliverChatShellSkillTools({ provider: "openai", defaultModel: "gpt-5-mini" }),
    ).toBe(false);
  });

  it("allows shell skill delivery for hosted-shell-capable OpenAI models", () => {
    // gpt-5.5 is DEFAULT_OPENAI_MODEL_ID — the out-of-box path must deliver.
    expect(
      shouldDeliverChatShellSkillTools({ provider: "openai", defaultModel: "gpt-5.5" }),
    ).toBe(true);
    expect(
      shouldDeliverChatShellSkillTools({ provider: "openai", defaultModel: "gpt-5.4" }),
    ).toBe(true);
    // Unknown ids stay deliverable — the API is the final arbiter.
    expect(
      shouldDeliverChatShellSkillTools({ provider: "openai", defaultModel: "some-future-model" }),
    ).toBe(true);
  });

  it("never gates non-OpenAI providers (their boundaries enforce delivery)", () => {
    expect(
      shouldDeliverChatShellSkillTools({ provider: "anthropic", defaultModel: "gpt-5" }),
    ).toBe(true);
    expect(
      shouldDeliverChatShellSkillTools({ provider: "gemini", defaultModel: "gpt-5" }),
    ).toBe(true);
  });
});

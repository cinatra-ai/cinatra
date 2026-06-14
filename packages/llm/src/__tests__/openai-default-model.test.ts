/**
 * Pins the OpenAI provider adapter's model resolution:
 *
 *   adapter.defaultModel = connection.defaultModel ?? DEFAULT_MODEL
 *
 * where DEFAULT_MODEL is the canonical "gpt-5.5" — NEVER the shell-incompatible
 * base "gpt-5". The operator-configured `connection.defaultModel` (persisted via
 * /setup/ai + /configuration/llm into openai_connection.defaultModel) must win;
 * when absent the adapter falls back to the canonical default.
 *
 * Regression guard for the gpt-5 default elimination: openai.ts previously
 * defined `const DEFAULT_MODEL = "gpt-5"`, which silently dispatched chat/agent
 * turns on the shell-incompatible base model whenever a connection carried no
 * defaultModel.
 */
import { describe, it, expect, vi } from "vitest";

// The adapter constructor calls `new OpenAI(...)`; stub the SDK so no network
// client is built. Model resolution does not touch the SDK at all.
vi.mock("openai", () => ({
  default: class {
    constructor(_opts: unknown) {}
  },
}));

// Provider surfaces resolve to "absent" — the adapter's log-writer lookup
// no-ops; model resolution is independent of the surface.
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

import { createOpenAIProviderAdapter } from "../providers/openai";

// NOTE: this test does NOT import `@cinatra-ai/agents/llm-provider-policy`.
// `@cinatra-ai/llm` must not depend on `@cinatra-ai/agents` (the agents package
// depends on llm — importing it back would be circular and is the reason the
// "gpt-5.5" literal is duplicated in openai.ts). Because of that boundary the
// two layers cannot share a single runtime equality assertion; instead each
// side independently pins its own literal to "gpt-5.5": this test locks the
// `@cinatra-ai/llm` adapter default, and the agents-side
// `llm-provider-policy.test.ts` locks `DEFAULT_OPENAI_MODEL_ID`. The lock-step
// comment on `DEFAULT_MODEL` in openai.ts records the invariant the two literals
// must satisfy.

describe("createOpenAIProviderAdapter — model resolution", () => {
  it("falls back to the canonical default (gpt-5.5), NEVER base gpt-5, when no defaultModel is configured", () => {
    const adapter = createOpenAIProviderAdapter({ apiKey: "sk-test" });
    expect(adapter.defaultModel).toBe("gpt-5.5");
    expect(adapter.defaultModel).not.toBe("gpt-5");
  });

  it("honors the operator-configured connection.defaultModel when set", () => {
    const adapter = createOpenAIProviderAdapter({
      apiKey: "sk-test",
      defaultModel: "gpt-5.4",
    });
    expect(adapter.defaultModel).toBe("gpt-5.4");
  });

  it("honors an explicitly-configured base gpt-5 (operator choice still wins over the canonical fallback)", () => {
    // gpt-5 remains a selectable model id; if the operator pins it, honor it.
    // The fix only removes gpt-5 as a SILENT default, not as a valid choice.
    const adapter = createOpenAIProviderAdapter({
      apiKey: "sk-test",
      defaultModel: "gpt-5",
    });
    expect(adapter.defaultModel).toBe("gpt-5");
  });
});

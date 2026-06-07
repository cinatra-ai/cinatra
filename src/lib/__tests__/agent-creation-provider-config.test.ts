// Regression locks for standing provider-selection invariants:
//
//   1. OpenAI stays the resolved GLOBAL default LLM provider. Anthropic is
//      ALWAYS only selectable per-purpose and can NEVER become the global
//      default — enforced at the `writeDefaultLlmProviderToDatabase`
//      chokepoint via `isGlobalDefaultLlmProviderEligible`.
//   2. The agent-creation Anthropic pin is PLUMBING ONLY:
//      `isAgentCreationPinActive()` is inert (always false) until the
//      governance and sync paths activate it.
//
// Imports the functions via relative path because the root vitest config
// stubs `@/lib/database` to a no-op shim (same pattern as
// derive-skill-package-identity.test.ts).

import { describe, expect, it } from "vitest";

// Relative import bypasses the @/lib/database alias stub.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import {
  isGlobalDefaultLlmProviderEligible,
  isAgentCreationPinActive,
} from "../database";

describe("standing invariant — OpenAI stays the global default", () => {
  it("openai is eligible to be the global default LLM provider", () => {
    expect(isGlobalDefaultLlmProviderEligible("openai")).toBe(true);
  });

  it("gemini is eligible to be the global default LLM provider", () => {
    expect(isGlobalDefaultLlmProviderEligible("gemini")).toBe(true);
  });

  it("anthropic is NEVER eligible to be the global default (invariant 1)", () => {
    expect(isGlobalDefaultLlmProviderEligible("anthropic")).toBe(false);
  });

  it("unknown / tampered provider strings are rejected (fail-closed)", () => {
    expect(isGlobalDefaultLlmProviderEligible("")).toBe(false);
    expect(isGlobalDefaultLlmProviderEligible("claude")).toBe(false);
    expect(isGlobalDefaultLlmProviderEligible("ANTHROPIC")).toBe(false);
    expect(isGlobalDefaultLlmProviderEligible("openai ")).toBe(false);
  });
});

describe("agent-creation pin remains inert until activation", () => {
  it("isAgentCreationPinActive() is false until activated", () => {
    expect(isAgentCreationPinActive()).toBe(false);
  });
});

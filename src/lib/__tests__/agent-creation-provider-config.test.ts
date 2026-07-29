// Regression locks for standing provider-selection invariants:
//
//   1. Only a provider whose `cinatra.llmProvider` ABI v2 declaration sets
//      `defaultCapable` may be the resolved GLOBAL default LLM provider —
//      enforced at the `writeDefaultLlmProviderToDatabase` chokepoint via
//      `isGlobalDefaultLlmProviderEligible`. (Pre-S6 this was a hardcoded
//      {openai,gemini} set that barred Anthropic architecturally; cinatra#2093
//      un-fenced it. The fail-closed rejection of undeclared/tampered provider
//      strings — the part that carries the safety — is unchanged.)
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

describe("standing invariant — the global default is declaration-derived", () => {
  it("openai is eligible to be the global default LLM provider", () => {
    expect(isGlobalDefaultLlmProviderEligible("openai")).toBe(true);
  });

  it("gemini is eligible to be the global default LLM provider", () => {
    expect(isGlobalDefaultLlmProviderEligible("gemini")).toBe(true);
  });

  // RETIRED INVARIANT (cinatra#2093, epic #2086 S6). Anthropic being barred
  // from the global default was the pre-S6 architecture, deliberately undone:
  // eligibility now DERIVES from the `cinatra.llmProvider` ABI v2
  // `defaultCapable` flag, which Anthropic declares. The invariant that
  // SURVIVES — and is the one that ever mattered for safety — is the
  // fail-closed rejection of undeclared/tampered provider strings, covered
  // below and unchanged.
  it("anthropic IS eligible to be the global default (S6 un-fencing)", () => {
    expect(isGlobalDefaultLlmProviderEligible("anthropic")).toBe(true);
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

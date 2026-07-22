// llm-providers S4.x (cinatra#1964) — the `llm-skill-delivery-adapter` HOST
// RESOLVER's VALIDATION rules: versioned surface, and the
// malformed/collision-!=-absent fail-closed rule (a valid claimant must not
// mask a malformed sibling), mirroring the request-translation
// `llm-provider-adapter` resolver (llm-provider-adapter-surfaces.test.ts).
//
// The resolver TRUSTS its registrants — first-party-only enforcement lives
// UPSTREAM at the `ctx.capabilities` RESERVED_SYSTEM_CAPABILITY port (covered by
// extension-host-context-reserved-system-capabilities.test.ts). These tests use
// the low-level registry directly to exercise the resolver's validation.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION } from "@cinatra-ai/sdk-extensions";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { getLlmSkillDeliveryAdapterSurface } from "@/lib/llm-provider-surfaces";

const OPENAI_PKG = "@cinatra-ai/openai-connector";
const CAP = "llm-skill-delivery-adapter";

function validSurface(providerId: string) {
  return {
    abiVersion: LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION,
    providerId,
    createSkillDeliveryAdapter: vi.fn(() => ({ provider: providerId, deliver: vi.fn() })),
  };
}

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("getLlmSkillDeliveryAdapterSurface (llm-providers S4.x)", () => {
  it("returns null when NO registration claims the provider (caller falls back to the in-core adapter)", () => {
    expect(getLlmSkillDeliveryAdapterSurface("openai")).toBeNull();
  });

  it("returns the surface for a valid registration claiming the provider", () => {
    const impl = validSurface("openai");
    registerCapabilityProvider(CAP, { packageName: OPENAI_PKG, impl });
    expect(getLlmSkillDeliveryAdapterSurface("openai")).toBe(impl);
  });

  it("does not return another provider's surface (provider isolation)", () => {
    registerCapabilityProvider(CAP, {
      packageName: "@cinatra-ai/gemini-connector",
      impl: validSurface("gemini"),
    });
    expect(getLlmSkillDeliveryAdapterSurface("openai")).toBeNull();
  });

  it("throws (fail closed) when a claiming surface has an unknown abiVersion", () => {
    registerCapabilityProvider(CAP, {
      packageName: OPENAI_PKG,
      impl: { ...validSurface("openai"), abiVersion: 999 },
    });
    expect(() => getLlmSkillDeliveryAdapterSurface("openai")).toThrow(/malformed|abiVersion/i);
  });

  it("throws (fail closed) when createSkillDeliveryAdapter is not callable", () => {
    registerCapabilityProvider(CAP, {
      packageName: OPENAI_PKG,
      impl: {
        abiVersion: LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION,
        providerId: "openai",
        createSkillDeliveryAdapter: "nope",
      },
    });
    expect(() => getLlmSkillDeliveryAdapterSurface("openai")).toThrow(
      /malformed|createSkillDeliveryAdapter/i,
    );
  });

  it("throws (fail closed) — a VALID claimant must NOT mask a malformed sibling for the same provider", () => {
    // Valid one is registered FIRST (a naive find(valid) would return it and
    // silently mask the broken sibling).
    registerCapabilityProvider(CAP, {
      packageName: OPENAI_PKG,
      impl: validSurface("openai"),
    });
    registerCapabilityProvider(CAP, {
      packageName: "@cinatra-ai/openai-connector-shadow",
      impl: { ...validSurface("openai"), abiVersion: 999 },
    });
    expect(() => getLlmSkillDeliveryAdapterSurface("openai")).toThrow(/malformed|abiVersion/i);
  });

  it("throws (fail closed) on ambiguous ownership — TWO valid claimants for one provider", () => {
    registerCapabilityProvider(CAP, {
      packageName: OPENAI_PKG,
      impl: validSurface("openai"),
    });
    registerCapabilityProvider(CAP, {
      packageName: "@cinatra-ai/openai-connector-2",
      impl: validSurface("openai"),
    });
    expect(() => getLlmSkillDeliveryAdapterSurface("openai")).toThrow(/ambiguous|Multiple/i);
  });

  it("does NOT poison a healthy provider when a DIFFERENT provider's registration is malformed", () => {
    registerCapabilityProvider(CAP, {
      packageName: "@cinatra-ai/anthropic-connector",
      impl: { ...validSurface("anthropic"), abiVersion: 999 },
    });
    expect(getLlmSkillDeliveryAdapterSurface("openai")).toBeNull();
    // …and the malformed provider itself still fails closed when resolved.
    expect(() => getLlmSkillDeliveryAdapterSurface("anthropic")).toThrow(/malformed|abiVersion/i);
  });
});

// llm-providers S4 (cinatra#1715) — the `llm-provider-adapter` HOST RESOLVER's
// VALIDATION rules: versioned surface, and the malformed/collision-!=-absent
// fail-closed rule (incl. the Codex round-2 "a valid claimant must not mask a
// malformed sibling" fix).
//
// The resolver TRUSTS its registrants — first-party-only enforcement lives
// UPSTREAM at the `ctx.capabilities` RESERVED_SYSTEM_CAPABILITY port (covered by
// extension-host-context-reserved-system-capabilities.test.ts). These tests use
// the low-level registry directly to exercise the resolver's validation.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { LLM_PROVIDER_ADAPTER_ABI_VERSION } from "@cinatra-ai/sdk-extensions";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { getLlmProviderAdapterSurface } from "@/lib/llm-provider-surfaces";

const OPENAI_PKG = "@cinatra-ai/openai-connector";

function validSurface(providerId: string) {
  return {
    abiVersion: LLM_PROVIDER_ADAPTER_ABI_VERSION,
    providerId,
    createAdapter: vi.fn(async () => ({ provider: providerId })),
  };
}

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("getLlmProviderAdapterSurface (llm-providers S4)", () => {
  it("returns null when NO registration claims the provider (caller falls back to the in-core factory)", () => {
    expect(getLlmProviderAdapterSurface("openai")).toBeNull();
  });

  it("returns the surface for a valid registration claiming the provider", () => {
    const impl = validSurface("openai");
    registerCapabilityProvider("llm-provider-adapter", { packageName: OPENAI_PKG, impl });
    expect(getLlmProviderAdapterSurface("openai")).toBe(impl);
  });

  it("does not return another provider's surface (provider isolation)", () => {
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: "@cinatra-ai/gemini-connector",
      impl: validSurface("gemini"),
    });
    expect(getLlmProviderAdapterSurface("openai")).toBeNull();
  });

  it("throws (fail closed) when a claiming surface has an unknown abiVersion", () => {
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: OPENAI_PKG,
      impl: { ...validSurface("openai"), abiVersion: 999 },
    });
    expect(() => getLlmProviderAdapterSurface("openai")).toThrow(/malformed|abiVersion/i);
  });

  it("throws (fail closed) when a claiming surface's createAdapter is not callable", () => {
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: OPENAI_PKG,
      impl: {
        abiVersion: LLM_PROVIDER_ADAPTER_ABI_VERSION,
        providerId: "openai",
        createAdapter: "nope",
      },
    });
    expect(() => getLlmProviderAdapterSurface("openai")).toThrow(/malformed|createAdapter/i);
  });

  it("throws (fail closed) — a VALID claimant must NOT mask a malformed sibling for the same provider (Codex round-2)", () => {
    // Valid one is registered FIRST (a naive find(valid) would return it and
    // silently mask the broken sibling).
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: OPENAI_PKG,
      impl: validSurface("openai"),
    });
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: "@cinatra-ai/openai-connector-shadow",
      impl: { ...validSurface("openai"), abiVersion: 999 },
    });
    expect(() => getLlmProviderAdapterSurface("openai")).toThrow(/malformed|abiVersion/i);
  });

  it("throws (fail closed) on ambiguous ownership — TWO valid claimants for one provider", () => {
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: OPENAI_PKG,
      impl: validSurface("openai"),
    });
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: "@cinatra-ai/openai-connector-2",
      impl: validSurface("openai"),
    });
    expect(() => getLlmProviderAdapterSurface("openai")).toThrow(/ambiguous|Multiple/i);
  });

  it("does NOT poison a healthy provider when a DIFFERENT provider's registration is malformed", () => {
    registerCapabilityProvider("llm-provider-adapter", {
      packageName: "@cinatra-ai/anthropic-connector",
      impl: { ...validSurface("anthropic"), abiVersion: 999 },
    });
    expect(getLlmProviderAdapterSurface("openai")).toBeNull();
    // …and the malformed provider itself still fails closed when resolved.
    expect(() => getLlmProviderAdapterSurface("anthropic")).toThrow(/malformed|abiVersion/i);
  });
});

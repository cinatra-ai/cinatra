// cinatra#2094 F10 — the exact-binding failure must NAME the stored provider.
//
// S7's block C measured the two load-bearing halves of the S6 contract as
// holding — the failure IS visible and there IS no silent hop — and the NAMING
// half as failing: "the string `anthropic` appears nowhere in the rendered page".
//
// The reason was not the UI. `/api/assistants/chat` rejects a turn BEFORE the
// durable stream exists when no runtime is available, and that guard was a
// BOOLEAN (`hasConfiguredLlmRuntime`) turned into the fixed string
// "No LLM provider configured." — the exact useless generic
// `BoundDefaultProviderUnavailableError` exists to replace. Under the shipped
// EXACT binding the resolver walks ONLY the stored provider, so a stored default
// that is down fails at that guard, and the producer's throwing resolver — the
// only thing that could have named the provider — was never reached.
//
// These tests pin the naming at the source: the guard's reason now comes from the
// error class itself, so there is ONE wording and it always carries the provider.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let storedProvider = "anthropic";
let failoverPolicy: "exact" | "ordered" = "exact";
/** Providers whose connector-registered adapter surface resolves an adapter. */
let availableProviders = new Set<string>();

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => null,
  getLlmProviderAdapterSurface: (provider: string) =>
    availableProviders.has(provider)
      ? { createAdapter: async () => ({ provider }) }
      : null,
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: () => storedProvider,
  readLlmProviderFailoverPolicyFromDatabase: () => failoverPolicy,
  readDefaultImageProviderFromDatabase: () => null,
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  loadExternalMcpToolboxByServerId: vi.fn(async () => null),
}));
vi.mock("../mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(),
  buildExternalMcpServerTools: vi.fn(),
}));

import {
  BoundDefaultProviderUnavailableError,
  describeLlmRuntimeUnavailability,
  hasConfiguredLlmRuntime,
} from "../registry";

const ORIG_FLAG = process.env.CINATRA_TEST_LLM_PROVIDER;

beforeEach(() => {
  delete process.env.CINATRA_TEST_LLM_PROVIDER;
  storedProvider = "anthropic";
  failoverPolicy = "exact";
  availableProviders = new Set<string>();
});
afterEach(() => {
  if (ORIG_FLAG === undefined) delete process.env.CINATRA_TEST_LLM_PROVIDER;
  else process.env.CINATRA_TEST_LLM_PROVIDER = ORIG_FLAG;
});

describe("describeLlmRuntimeUnavailability — F10 provider naming", () => {
  it("NAMES the stored provider when it is the unavailable one", async () => {
    // The S7 block-C arrangement exactly: stored default anthropic with no
    // Anthropic adapter, and a perfectly usable OpenAI left in place as a
    // failover target that exact binding must NOT take.
    availableProviders.add("openai");

    const reason = await describeLlmRuntimeUnavailability();

    expect(reason).not.toBeNull();
    expect(reason).toContain("anthropic");
    // The wording is the error class's own — not a second copy that can drift.
    expect(reason).toBe(new BoundDefaultProviderUnavailableError("anthropic", "exact").message);
    // The generic that S7 saw must be gone.
    expect(reason).not.toBe("No LLM provider configured.");
  });

  it("returns null when the stored provider IS available", async () => {
    availableProviders.add("anthropic");
    expect(await describeLlmRuntimeUnavailability()).toBeNull();
  });

  it("names the stored provider under the ORDERED policy too, once nothing resolves", async () => {
    failoverPolicy = "ordered";
    const reason = await describeLlmRuntimeUnavailability();
    expect(reason).toContain("anthropic");
    expect(reason).toBe(new BoundDefaultProviderUnavailableError("anthropic", "ordered").message);
  });

  it("returns null under ORDERED failover when a NON-stored provider resolves", async () => {
    failoverPolicy = "ordered";
    availableProviders.add("openai");
    expect(await describeLlmRuntimeUnavailability()).toBeNull();
  });

  it("agrees with hasConfiguredLlmRuntime on EVERY arrangement (decision parity)", async () => {
    const arrangements: Array<{
      stored: string;
      policy: "exact" | "ordered";
      available: string[];
    }> = [
      { stored: "anthropic", policy: "exact", available: [] },
      { stored: "anthropic", policy: "exact", available: ["openai"] },
      { stored: "anthropic", policy: "exact", available: ["anthropic"] },
      { stored: "openai", policy: "exact", available: ["openai", "anthropic"] },
      { stored: "anthropic", policy: "ordered", available: [] },
      { stored: "anthropic", policy: "ordered", available: ["openai"] },
    ];
    for (const arrangement of arrangements) {
      storedProvider = arrangement.stored;
      failoverPolicy = arrangement.policy;
      availableProviders = new Set(arrangement.available);
      const configured = await hasConfiguredLlmRuntime();
      const reason = await describeLlmRuntimeUnavailability();
      expect(reason === null, JSON.stringify(arrangement)).toBe(configured);
    }
  });

  // The cross-package invariant this fix depends on, pinned HERE because this is
  // where the wording lives. The chat renderer's `extractErrorMessage` replaces
  // any message longer than 300 chars with a generic "The request failed…" —
  // designed for raw HTTP error bodies. If this wording ever grows past that cap
  // the provider name silently disappears from the banner again, which is exactly
  // the F10 symptom. Fail here rather than in the UI.
  it("stays inside the chat renderer's 300-char normalizer cap (F10 drift pin)", () => {
    for (const policy of ["exact", "ordered"] as const) {
      for (const provider of ["anthropic", "openai", "gemini"] as const) {
        const { message } = new BoundDefaultProviderUnavailableError(provider, policy);
        expect(message.length, `${provider}/${policy} = ${message.length} chars`).toBeLessThanOrEqual(300);
        expect(message).toContain(provider);
      }
    }
  });

  it("keeps the scripted-provider seam: never reports unavailable, never reads the DB", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    // No provider adapter registered at all — the pre-S6 blind spot #1919 fixed.
    expect(await describeLlmRuntimeUnavailability()).toBeNull();
    expect(await hasConfiguredLlmRuntime()).toBe(true);
  });
});

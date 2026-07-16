/**
 * llm-providers S1 (#1712) — regression contract for the extension-declared
 * provider capability + model-catalog model.
 *
 * Two things are locked here:
 *
 *   1. BEHAVIOR-IDENTICAL: the build-known declaration catalog reproduces the
 *      pre-S1 hardcoded matrix (capabilities + model allowlists + defaults)
 *      EXACTLY, and the historical `llm-provider-policy` exports still derive
 *      the same answers from it. S1 changes the *source of truth* (imperative
 *      switch → declared data), not the answers.
 *
 *   2. FAIL-CLOSED live resolver: the effective (live) resolver = declaration ∩
 *      activated surface ∩ adapter readiness; any absent factor forces false —
 *      the AC-4 regression cases (no-declaration, inactive-connector) plus
 *      native_mcp status handling (unsupported/dormant never satisfy).
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/llm-provider-declaration.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_MODEL_IDS,
  BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS,
  DEFAULT_OPENAI_MODEL_ID,
  LLM_CAPABILITIES,
  LLM_PROVIDER_ABI_VERSION,
  LLM_PROVIDERS,
  LlmProviderDeclarationSchema,
  canProviderSatisfyCapability,
  declarationSatisfiesCapability,
  resolveEffectiveProviderCapability,
  type EffectiveCapabilityFactors,
  type LlmProviderDeclaration,
} from "../llm-provider-policy";

// The pre-S1 hardcoded truth, transcribed verbatim from the imperative switch
// + ALLOWED_MODEL_IDS that S1 replaced. If S1 drifts behavior, one of these
// fails.
const HISTORICAL_CAPABILITY_MATRIX: Record<string, Record<string, boolean>> = {
  openai: { media_input: false, function_tools: true, native_mcp: true },
  anthropic: { media_input: false, function_tools: true, native_mcp: true },
  gemini: { media_input: true, function_tools: true, native_mcp: false },
};

const HISTORICAL_ALLOWED_MODEL_IDS: Record<string, readonly string[]> = {
  openai: [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  anthropic: [
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
  ],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-1.5-pro"],
};

const HISTORICAL_DEFAULTS: Record<string, string> = {
  openai: "gpt-5.5",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-flash",
};

describe("build-known declaration catalog", () => {
  it("every provider has a schema-valid declaration at the current ABI", () => {
    for (const provider of LLM_PROVIDERS) {
      const decl = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider];
      expect(decl).toBeDefined();
      expect(decl.abiVersion).toBe(LLM_PROVIDER_ABI_VERSION);
      expect(decl.provider).toBe(provider);
      // Round-trips through the leaf schema a connector manifest must satisfy.
      expect(() => LlmProviderDeclarationSchema.parse(decl)).not.toThrow();
    }
  });

  it("reproduces the pre-S1 capability matrix EXACTLY (declaration projection)", () => {
    for (const provider of LLM_PROVIDERS) {
      for (const capability of LLM_CAPABILITIES) {
        expect(
          declarationSatisfiesCapability(
            BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider],
            capability,
          ),
        ).toBe(HISTORICAL_CAPABILITY_MATRIX[provider][capability]);
      }
    }
  });

  it("reproduces the pre-S1 model allowlists + defaults EXACTLY", () => {
    for (const provider of LLM_PROVIDERS) {
      const decl = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS[provider];
      expect(decl.models.allowed).toEqual(HISTORICAL_ALLOWED_MODEL_IDS[provider]);
      expect(decl.models.default).toBe(HISTORICAL_DEFAULTS[provider]);
      // The default is always a member of its own allowlist.
      expect(decl.models.allowed).toContain(decl.models.default);
    }
  });
});

describe("derived llm-provider-policy exports stay behavior-identical", () => {
  it("canProviderSatisfyCapability matches the historical matrix", () => {
    for (const provider of LLM_PROVIDERS) {
      for (const capability of LLM_CAPABILITIES) {
        expect(canProviderSatisfyCapability(provider, capability)).toBe(
          HISTORICAL_CAPABILITY_MATRIX[provider][capability],
        );
      }
    }
  });

  it("ALLOWED_MODEL_IDS is derived from the catalog and unchanged", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(ALLOWED_MODEL_IDS[provider]).toEqual(HISTORICAL_ALLOWED_MODEL_IDS[provider]);
    }
  });

  it('DEFAULT_OPENAI_MODEL_ID stays "gpt-5.5" and is a member of the openai allowlist', () => {
    expect(DEFAULT_OPENAI_MODEL_ID).toBe("gpt-5.5");
    expect(ALLOWED_MODEL_IDS.openai).toContain(DEFAULT_OPENAI_MODEL_ID);
  });
});

describe("native_mcp status is fail-closed", () => {
  it("only status 'native' satisfies native_mcp; 'unsupported' and 'dormant' do not", () => {
    const base: LlmProviderDeclaration = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai;

    const native: LlmProviderDeclaration = {
      ...base,
      capabilities: { ...base.capabilities, native_mcp: { status: "native" } },
    };
    const unsupported: LlmProviderDeclaration = {
      ...base,
      capabilities: { ...base.capabilities, native_mcp: { status: "unsupported" } },
    };
    const dormant: LlmProviderDeclaration = {
      ...base,
      capabilities: { ...base.capabilities, native_mcp: { status: "dormant" } },
    };

    expect(declarationSatisfiesCapability(native, "native_mcp")).toBe(true);
    expect(declarationSatisfiesCapability(unsupported, "native_mcp")).toBe(false);
    // Dormant = translator present but declaration not flipped → provably false
    // through every intermediate deployment (the epic's Gemini ordering).
    expect(declarationSatisfiesCapability(dormant, "native_mcp")).toBe(false);
  });
});

describe("fail-closed live resolver (declaration ∩ surface ∩ adapter)", () => {
  const readyOpenai: EffectiveCapabilityFactors = {
    declaration: BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai,
    surfaceActivated: true,
    adapterReady: true,
  };

  it("all factors present → equals the declaration answer", () => {
    for (const capability of LLM_CAPABILITIES) {
      expect(resolveEffectiveProviderCapability(readyOpenai, capability)).toBe(
        declarationSatisfiesCapability(BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai, capability),
      );
    }
  });

  it("no declaration (unknown / uninstalled provider) → false (AC-4 no-declaration)", () => {
    expect(
      resolveEffectiveProviderCapability(
        { declaration: undefined, surfaceActivated: true, adapterReady: true },
        "native_mcp",
      ),
    ).toBe(false);
  });

  it("declared+capable but surface inactive → false (AC-4 inactive-connector)", () => {
    expect(
      resolveEffectiveProviderCapability(
        { ...readyOpenai, surfaceActivated: false },
        "native_mcp",
      ),
    ).toBe(false);
  });

  it("declared+capable+active but adapter not ready → false", () => {
    expect(
      resolveEffectiveProviderCapability({ ...readyOpenai, adapterReady: false }, "native_mcp"),
    ).toBe(false);
  });

  it("an extension that declares nothing new gets nothing new (fail-closed default)", () => {
    // Gemini declares native_mcp unsupported: even fully active + ready it can
    // never acquire native_mcp through the live resolver.
    const gemini: EffectiveCapabilityFactors = {
      declaration: BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.gemini,
      surfaceActivated: true,
      adapterReady: true,
    };
    expect(resolveEffectiveProviderCapability(gemini, "native_mcp")).toBe(false);
    expect(resolveEffectiveProviderCapability(gemini, "media_input")).toBe(true);
  });
});

describe("declaration schema fails closed on malformed manifest blocks", () => {
  it("rejects an unknown top-level key (.strict)", () => {
    const decl = { ...BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai, bogus: 1 };
    expect(() => LlmProviderDeclarationSchema.parse(decl)).toThrow();
  });

  it("rejects a wrong ABI version", () => {
    const decl = { ...BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai, abiVersion: 99 };
    expect(() => LlmProviderDeclarationSchema.parse(decl)).toThrow();
  });

  it("rejects a default outside the allowlist", () => {
    const base = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai;
    const decl = { ...base, models: { default: "not-in-list", allowed: base.models.allowed } };
    expect(() => LlmProviderDeclarationSchema.parse(decl)).toThrow();
  });

  it("rejects an unknown native_mcp status", () => {
    const base = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.openai;
    const decl = {
      ...base,
      capabilities: { ...base.capabilities, native_mcp: { status: "maybe" } },
    };
    expect(() => LlmProviderDeclarationSchema.parse(decl)).toThrow();
  });
});

describe("the build-known catalog is DEEP-frozen (capability truth is immutable)", () => {
  it("nested capability + model mutation is refused at every depth", () => {
    const gemini = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS.gemini;
    expect(Object.isFrozen(gemini)).toBe(true);
    expect(Object.isFrozen(gemini.capabilities)).toBe(true);
    expect(Object.isFrozen(gemini.capabilities.native_mcp)).toBe(true);
    expect(Object.isFrozen(gemini.models)).toBe(true);
    expect(Object.isFrozen(gemini.models.allowed)).toBe(true);

    // A cast-away attempt to flip Gemini's native_mcp on (the exact border
    // hazard) throws in strict mode and leaves the declared truth intact.
    expect(() => {
      (gemini.capabilities.native_mcp as { status: string }).status = "native";
    }).toThrow();
    expect(gemini.capabilities.native_mcp.status).toBe("unsupported");
    expect(declarationSatisfiesCapability(gemini, "native_mcp")).toBe(false);

    expect(() => {
      (gemini.models.allowed as string[]).push("gemini-3.5-pro");
    }).toThrow();
  });
});

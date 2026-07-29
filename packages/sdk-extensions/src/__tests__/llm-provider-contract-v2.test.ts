/**
 * cinatra.llmProvider ABI v2 CONFORMANCE (cinatra#2093, epic #2086 S6 AC4):
 * "All three connectors declare ABI v2; conformance tests cover both flags +
 * the probe member."
 *
 * Three concerns, deliberately separated:
 *  1. the two new declaration flags and their cross-field subset rule;
 *  2. the flag-matrix projections the un-fencing derives from (this is the
 *     thing that replaced four hardcoded `["openai","gemini"]` lists — if it
 *     silently changed, Anthropic would be re-fenced or an undeclared provider
 *     would be promoted, and nothing else in the tree would notice);
 *  3. the TRANSITIONAL v1 acceptance path + its retirement ratchet, which is
 *     the part most likely to be forgotten and quietly become permanent.
 *
 * The `probeNativeSkills` SURFACE member is covered where it lives — it is a
 * runtime member on `LlmProviderSurface`, not a manifest claim (a manifest can
 * only state an intent; whether the EFFECTIVE stored MCP mode accepts
 * `container.skills` is a live property of the connection). See
 * `llm-provider-surface-probe.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDER_ABI_VERSION,
  LLM_PROVIDER_ABI_VERSION_V1_LEGACY,
  LLM_PROVIDERS,
  LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST,
  BUILD_KNOWN_LLM_PROVIDER_FLAGS,
  LlmProviderDeclarationSchema,
  parseLlmProvider,
  validateLlmProviderForPublish,
  declarationIsDefaultCapable,
  declarationIsWizardEligible,
  providersWithDefaultCapable,
  providersWithWizardEligible,
  buildKnownDefaultCapableProviders,
  buildKnownWizardEligibleProviders,
  type LlmProviderDeclaration,
} from "../llm-provider-contract";

/** A valid v2 declaration; `over` patches any field. */
const v2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  abiVersion: LLM_PROVIDER_ABI_VERSION,
  provider: "anthropic",
  capabilities: {
    function_tools: true,
    media_input: false,
    native_mcp: { status: "native", approval: "unsupported" },
  },
  models: { default: "claude-sonnet-4-6", allowed: ["claude-sonnet-4-6"] },
  defaultCapable: true,
  wizardEligible: true,
  ...over,
});

/** The retiring v1 shape (v2 minus the flags). */
const v1 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  abiVersion: LLM_PROVIDER_ABI_VERSION_V1_LEGACY,
  provider: "gemini",
  capabilities: {
    function_tools: true,
    media_input: true,
    native_mcp: { status: "unsupported" },
  },
  models: { default: "gemini-3.5-flash", allowed: ["gemini-3.5-flash"] },
  ...over,
});

describe("ABI v2 — the two setup-time flags are REQUIRED", () => {
  it("the ABI version is 2 and the legacy literal is 1", () => {
    expect(LLM_PROVIDER_ABI_VERSION).toBe(2);
    expect(LLM_PROVIDER_ABI_VERSION_V1_LEGACY).toBe(1);
  });

  it("a v2 declaration missing defaultCapable is rejected", () => {
    const { defaultCapable: _omit, ...rest } = v2();
    expect(LlmProviderDeclarationSchema.safeParse(rest).success).toBe(false);
  });

  it("a v2 declaration missing wizardEligible is rejected", () => {
    const { wizardEligible: _omit, ...rest } = v2();
    expect(LlmProviderDeclarationSchema.safeParse(rest).success).toBe(false);
  });

  it("non-boolean flags are rejected (no truthiness coercion)", () => {
    expect(LlmProviderDeclarationSchema.safeParse(v2({ defaultCapable: "true" })).success).toBe(false);
    expect(LlmProviderDeclarationSchema.safeParse(v2({ wizardEligible: 1 })).success).toBe(false);
    expect(LlmProviderDeclarationSchema.safeParse(v2({ defaultCapable: null })).success).toBe(false);
  });

  it("all four flag combinations parse EXCEPT the incoherent wizardEligible-without-defaultCapable", () => {
    expect(LlmProviderDeclarationSchema.safeParse(v2({ defaultCapable: true, wizardEligible: true })).success).toBe(true);
    expect(LlmProviderDeclarationSchema.safeParse(v2({ defaultCapable: true, wizardEligible: false })).success).toBe(true);
    expect(LlmProviderDeclarationSchema.safeParse(v2({ defaultCapable: false, wizardEligible: false })).success).toBe(true);
    // The subset rule: the wizard's only act is committing the stored default,
    // so offering a provider that can never BE the default is incoherent.
    expect(LlmProviderDeclarationSchema.safeParse(v2({ defaultCapable: false, wizardEligible: true })).success).toBe(false);
  });

  it("the strict grammar still fails closed on an unknown top-level key", () => {
    expect(LlmProviderDeclarationSchema.safeParse(v2({ probeNativeSkills: true })).success).toBe(false);
  });

  it("the rejection diagnostic never echoes a received value (sanitizer holds for the new fields)", () => {
    const r = parseLlmProvider(v2({ defaultCapable: "s3cr3t-value" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic).toContain("defaultCapable");
      expect(r.diagnostic).not.toContain("s3cr3t-value");
    }
  });
});

describe("ABI v2 — the flag predicates", () => {
  const parse = (input: Record<string, unknown>): LlmProviderDeclaration => {
    const r = LlmProviderDeclarationSchema.safeParse(input);
    if (!r.success) throw new Error("fixture should parse");
    return r.data;
  };

  it("declarationIsDefaultCapable reads the flag exactly", () => {
    expect(declarationIsDefaultCapable(parse(v2({ defaultCapable: true })))).toBe(true);
    expect(declarationIsDefaultCapable(parse(v2({ defaultCapable: false, wizardEligible: false })))).toBe(false);
  });

  it("declarationIsWizardEligible RE-ASSERTS the subset rule at read time", () => {
    // A declaration that bypassed schema validation (hand-built literal, test
    // fixture, a future looser parse) must still not be wizard-eligible while
    // it is not default-capable.
    const smuggled = { ...parse(v2()), defaultCapable: false } as LlmProviderDeclaration;
    expect(smuggled.wizardEligible).toBe(true);
    expect(declarationIsWizardEligible(smuggled)).toBe(false);
  });

  it("providersWith* project a catalog in LLM_PROVIDERS order and skip absent entries", () => {
    const catalog = {
      openai: parse(v2({ provider: "openai", defaultCapable: true, wizardEligible: true })),
      gemini: parse(v2({ provider: "gemini", defaultCapable: true, wizardEligible: false })),
    };
    expect(providersWithDefaultCapable(catalog)).toEqual(["openai", "gemini"]);
    expect(providersWithWizardEligible(catalog)).toEqual(["openai"]);
    expect(providersWithDefaultCapable({})).toEqual([]);
  });
});

describe("ABI v2 — the RATIFIED build-known flag matrix (the un-fencing's authority)", () => {
  it("matches the matrix ratified in cinatra#2093: OpenAI true/true, Anthropic true/true, Gemini true/false", () => {
    expect(BUILD_KNOWN_LLM_PROVIDER_FLAGS).toEqual({
      openai: { defaultCapable: true, wizardEligible: true },
      anthropic: { defaultCapable: true, wizardEligible: true },
      gemini: { defaultCapable: true, wizardEligible: false },
    });
  });

  it("ANTHROPIC IS UN-FENCED: it is default-capable and wizard-eligible", () => {
    // The single assertion that would have been FALSE before S6, in all four
    // fenced sites at once.
    expect(buildKnownDefaultCapableProviders()).toContain("anthropic");
    expect(buildKnownWizardEligibleProviders()).toContain("anthropic");
  });

  it("Gemini stays admin-configured: default-capable but NOT offered by the wizard", () => {
    expect(buildKnownDefaultCapableProviders()).toContain("gemini");
    expect(buildKnownWizardEligibleProviders()).not.toContain("gemini");
  });

  it("the wizard-eligible set is a strict subset of the default-capable set", () => {
    const defaults = new Set(buildKnownDefaultCapableProviders());
    for (const p of buildKnownWizardEligibleProviders()) expect(defaults.has(p)).toBe(true);
  });

  it("the flag table covers EVERY provider in the closed vocabulary (no undeclared provider)", () => {
    for (const p of LLM_PROVIDERS) expect(BUILD_KNOWN_LLM_PROVIDER_FLAGS[p]).toBeDefined();
    expect(Object.keys(BUILD_KNOWN_LLM_PROVIDER_FLAGS).sort()).toEqual([...LLM_PROVIDERS].sort());
  });

  it("the flag table is frozen (a consumer cannot flip eligibility at runtime)", () => {
    expect(Object.isFrozen(BUILD_KNOWN_LLM_PROVIDER_FLAGS)).toBe(true);
    expect(Object.isFrozen(BUILD_KNOWN_LLM_PROVIDER_FLAGS.anthropic)).toBe(true);
  });
});

describe("v1 RETIREMENT RATCHET (transitional — cinatra#2093)", () => {
  it("the allowlist contains ONLY gemini (the one provider with a still-pinned v1 release)", () => {
    expect([...LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST]).toEqual(["gemini"]);
  });

  it("every allowlisted provider has a flag entry, and the shim assigns EXACTLY those flags", () => {
    // The ratchet's core guarantee: the compat shim can never invent a
    // capability the real v2 declaration does not grant.
    for (const provider of LLM_PROVIDER_V1_RETIREMENT_ALLOWLIST) {
      const flags = BUILD_KNOWN_LLM_PROVIDER_FLAGS[provider];
      expect(flags, `${provider} must have a flag entry`).toBeDefined();
      const r = parseLlmProvider(v1({ provider }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.declaration.defaultCapable).toBe(flags.defaultCapable);
        expect(r.declaration.wizardEligible).toBe(flags.wizardEligible);
      }
    }
  });

  it("HOST parse accepts an allowlisted v1 block and MIGRATES it to v2, flagged as migrated", () => {
    const r = parseLlmProvider(v1({ provider: "gemini" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.migratedFromV1).toBe(true);
      expect(r.declaration.abiVersion).toBe(LLM_PROVIDER_ABI_VERSION);
      // The v1 CONTENT survives — this is why the shim exists at all: dropping
      // the declaration would strand the model catalog on stale build-known
      // values for the whole pin-advance window.
      expect(r.declaration.models.default).toBe("gemini-3.5-flash");
    }
  });

  it("a native v2 block is NOT flagged as migrated", () => {
    const r = parseLlmProvider(v2());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.migratedFromV1).toBeUndefined();
  });

  it("a v1 block from a NON-allowlisted provider is dropped exactly like a malformed one", () => {
    for (const provider of ["openai", "anthropic"]) {
      const r = parseLlmProvider(v1({ provider }));
      expect(r.ok, `${provider} v1 must not be accepted`).toBe(false);
    }
  });

  it("a MALFORMED v1 block is not rescued by the allowlist", () => {
    // The shim re-parses through the v2 schema, so v1 content that was never
    // valid stays invalid — the shim gets no privileged path.
    expect(parseLlmProvider(v1({ models: { default: "z", allowed: ["a"] } })).ok).toBe(false);
    expect(parseLlmProvider(v1({ capabilities: { function_tools: true, media_input: true, native_mcp: { status: "maybe" } } })).ok).toBe(false);
  });

  it("PUBLISH is fail-closed on v1 even for an allowlisted provider — no new v1 can enter the ecosystem", () => {
    // The one door the ratchet exists to close: a RELEASE is exactly the moment
    // a connector can and must carry v2.
    expect(validateLlmProviderForPublish(v1({ provider: "gemini" })).valid).toBe(false);
    expect(validateLlmProviderForPublish(v2()).valid).toBe(true);
  });

  it("publish rejects the incoherent flag combination too", () => {
    expect(validateLlmProviderForPublish(v2({ defaultCapable: false, wizardEligible: true })).valid).toBe(false);
  });
});

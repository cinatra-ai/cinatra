// cinatra.llmProvider v1 leaf schema + tolerant parse (cinatra#1712, epic #1711
// S1 AC1).
//
// The LLM-provider declaration surface — the PUBLIC, host-neutral MIRROR of the
// host declaration model in `@cinatra-ai/agents`'s `llm-provider-policy.ts`.
// Pins the canonical v1 shape the conformance gate consumes: valid v1, the
// strict object grammar at every level, the provider/status/approval
// vocabularies, the models.default ∈ models.allowed cross-field rule, and the
// sanitized tolerant-parse degradation contract. (The leaf ↔ host byte-parity
// drift-guard lives in `@cinatra-ai/agents` — the only package that may import
// both.)
import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDER_ABI_VERSION,
  LLM_PROVIDERS,
  LLM_CAPABILITIES,
  NATIVE_MCP_STATUSES,
  MCP_APPROVAL_MODES,
  parseLlmProvider,
  validateLlmProviderForPublish,
  declarationSatisfiesCapability,
  type LlmProviderDeclaration,
} from "../llm-provider-contract";

const decl = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  abiVersion: LLM_PROVIDER_ABI_VERSION,
  provider: "anthropic",
  capabilities: {
    function_tools: true,
    media_input: false,
    native_mcp: { status: "native", approval: "unsupported" },
  },
  models: {
    default: "claude-sonnet-4-6",
    allowed: ["claude-sonnet-4-6", "claude-opus-4-7"],
  },
  ...over,
});

describe("cinatra.llmProvider v1 — constants + vocabulary", () => {
  it("the ABI version is 1", () => {
    expect(LLM_PROVIDER_ABI_VERSION).toBe(1);
  });
  it("declares the closed provider vocabulary (openai/anthropic/gemini)", () => {
    expect([...LLM_PROVIDERS]).toEqual(["openai", "anthropic", "gemini"]);
  });
  it("declares the closed capability vocabulary", () => {
    expect([...LLM_CAPABILITIES]).toEqual(["media_input", "function_tools", "native_mcp"]);
  });
  it("declares the native_mcp status + approval vocabularies", () => {
    expect([...NATIVE_MCP_STATUSES]).toEqual(["native", "unsupported", "dormant"]);
    expect([...MCP_APPROVAL_MODES]).toEqual(["auto_execute", "approval_required", "unsupported"]);
  });
});

describe("parseLlmProvider — valid v1", () => {
  it("accepts a minimal native-MCP provider declaration", () => {
    const r = parseLlmProvider(decl());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.declaration.abiVersion).toBe(1);
      expect(r.declaration.provider).toBe("anthropic");
      expect(r.declaration.capabilities.native_mcp.status).toBe("native");
    }
  });
  it("accepts an optional transports list on native_mcp", () => {
    const r = parseLlmProvider(
      decl({ capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", transports: ["http", "stdio"], approval: "approval_required" } } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.declaration.capabilities.native_mcp.transports).toEqual(["http", "stdio"]);
  });
  it("accepts native_mcp with only a status (transports + approval optional)", () => {
    expect(parseLlmProvider(decl({ provider: "gemini", capabilities: { function_tools: true, media_input: true, native_mcp: { status: "unsupported" } }, models: { default: "gemini-2.5-flash", allowed: ["gemini-2.5-flash"] } })).ok).toBe(true);
  });
});

describe("parseLlmProvider — rejections (fail-closed verdict; degrades at host)", () => {
  it("rejects a wrong abiVersion", () => {
    expect(parseLlmProvider(decl({ abiVersion: 2 })).ok).toBe(false);
  });
  it("rejects an unknown provider", () => {
    expect(parseLlmProvider(decl({ provider: "mistral" })).ok).toBe(false);
  });
  it("rejects an unknown native_mcp status", () => {
    expect(parseLlmProvider(decl({ capabilities: { function_tools: true, media_input: false, native_mcp: { status: "maybe" } } })).ok).toBe(false);
  });
  it("rejects an unknown approval mode", () => {
    expect(parseLlmProvider(decl({ capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", approval: "sometimes" } } })).ok).toBe(false);
  });
  it("rejects a non-boolean capability flag", () => {
    expect(parseLlmProvider(decl({ capabilities: { function_tools: "yes", media_input: false, native_mcp: { status: "native" } } })).ok).toBe(false);
  });
  it("rejects a missing capability key (all three are required)", () => {
    expect(parseLlmProvider(decl({ capabilities: { function_tools: true, native_mcp: { status: "native" } } })).ok).toBe(false);
  });
  it("rejects an empty models.allowed", () => {
    expect(parseLlmProvider(decl({ models: { default: "x", allowed: [] } })).ok).toBe(false);
  });
  it("rejects an empty transports array (nonempty when present)", () => {
    expect(parseLlmProvider(decl({ capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", transports: [] } } })).ok).toBe(false);
  });
  it("rejects models.default NOT in models.allowed (the cross-field rule)", () => {
    expect(parseLlmProvider(decl({ models: { default: "gpt-9", allowed: ["claude-sonnet-4-6"] } })).ok).toBe(false);
  });
  it("rejects an extraneous key at every strict level (top / capabilities / native_mcp / models)", () => {
    expect(parseLlmProvider(decl({ extra: true })).ok).toBe(false);
    expect(parseLlmProvider(decl({ capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native" }, extra: 1 } })).ok).toBe(false);
    expect(parseLlmProvider(decl({ capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", extra: 1 } } })).ok).toBe(false);
    expect(parseLlmProvider(decl({ models: { default: "claude-sonnet-4-6", allowed: ["claude-sonnet-4-6"], extra: 1 } })).ok).toBe(false);
  });
});

describe("parseLlmProvider — sanitized diagnostics + never-throws", () => {
  it("never echoes a received value (only path + zod code)", () => {
    const secret = "SUPER-SECRET-SMUGGLED-MODEL-ID";
    const r = parseLlmProvider(decl({ models: { default: secret, allowed: ["ok"] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic).not.toContain(secret);
      expect(r.diagnostic).toMatch(/cinatra\.llmProvider is invalid/);
    }
  });
  it("never throws on arbitrary garbage input", () => {
    for (const garbage of [null, undefined, 42, "str", [], { provider: 1 }, { abiVersion: 1 }]) {
      expect(() => parseLlmProvider(garbage)).not.toThrow();
      expect(parseLlmProvider(garbage).ok).toBe(false);
    }
  });
});

describe("validateLlmProviderForPublish — fail-closed wrapper", () => {
  it("valid block → { valid: true }", () => {
    expect(validateLlmProviderForPublish(decl())).toEqual({ valid: true, errors: [] });
  });
  it("invalid block → { valid: false } with the sanitized diagnostic as an error", () => {
    const r = validateLlmProviderForPublish(decl({ provider: "nope" }));
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/cinatra\.llmProvider is invalid/);
  });
});

describe("declarationSatisfiesCapability — fail-closed on native_mcp", () => {
  const parsed = (o: Record<string, unknown> = {}): LlmProviderDeclaration => {
    const r = parseLlmProvider(decl(o));
    if (!r.ok) throw new Error(`fixture invalid: ${r.diagnostic}`);
    return r.declaration;
  };
  it("only native status satisfies native_mcp; dormant + unsupported do not", () => {
    expect(declarationSatisfiesCapability(parsed(), "native_mcp")).toBe(true);
    for (const status of ["dormant", "unsupported"]) {
      expect(
        declarationSatisfiesCapability(parsed({ capabilities: { function_tools: true, media_input: false, native_mcp: { status } } }), "native_mcp"),
      ).toBe(false);
    }
  });
  it("reads media_input / function_tools straight off the declared booleans", () => {
    expect(declarationSatisfiesCapability(parsed(), "function_tools")).toBe(true);
    expect(declarationSatisfiesCapability(parsed(), "media_input")).toBe(false);
    expect(declarationSatisfiesCapability(parsed({ capabilities: { function_tools: false, media_input: true, native_mcp: { status: "unsupported" } } }), "media_input")).toBe(true);
  });
});

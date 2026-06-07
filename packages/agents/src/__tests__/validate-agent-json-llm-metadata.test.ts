/**
 * Contract tests for the LLM provider/model/capability declaration scan inside
 * `validateOasAgentJson`.
 *
 * Locks the stable OAS-LLM-00X identifiers:
 *   OAS-LLM-001  Zod-detected structural violation inside metadata.cinatra.llm
 *   OAS-LLM-002  preferredModel not in ALLOWED_MODEL_IDS[preferredProvider]
 *   OAS-LLM-003  preferredModel set without preferredProvider
 *   OAS-LLM-004  capabilityRequired:"media_input" without preferredProvider:"gemini"
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/validate-agent-json-llm-metadata.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  scanOasForLlmMetadata,
  validateOasAgentJson,
  type ReviewFinding,
} from "../validate-agent-json";

// ---------------------------------------------------------------------------
// Minimal valid OAS Flow 26.1.0 fixture. Tests mutate only
// `metadata.cinatra.llm` to assert provider/model/capability semantics.
// ---------------------------------------------------------------------------

type OasFixture = Record<string, unknown>;

function buildBaseOas(llm?: Record<string, unknown>): OasFixture {
  const cinatra: Record<string, unknown> = { type: "node" };
  if (llm !== undefined) cinatra.llm = llm;
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    description: "Test fixture for LLM metadata validation",
    metadata: { cinatra },
    nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
    },
  };
}

// Extract the LLM findings (code starts with OAS-LLM-). Each failure fixture
// below should produce EXACTLY ONE LLM finding.
function llmFindings(parsed: OasFixture): ReviewFinding[] {
  return scanOasForLlmMetadata(parsed);
}

// Helper: assert the integrated validateOasAgentJson surface also sees the
// finding (formatted as a string with the canonical code embedded).
function validatorErrors(parsed: OasFixture): string[] {
  return validateOasAgentJson(parsed);
}

// ---------------------------------------------------------------------------
// PASS cases — no LLM-scoped findings, no surface-level OAS-LLM error strings.
// ---------------------------------------------------------------------------

describe("scanOasForLlmMetadata — positive cases", () => {
  it("accepts OAS without metadata.cinatra.llm (back-compat)", () => {
    const fixture = buildBaseOas(/* llm intentionally omitted */);
    expect(llmFindings(fixture)).toEqual([]);
    expect(validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"))).toEqual([]);
  });

  it("accepts gemini + gemini-2.5-flash + media_input", () => {
    const fixture = buildBaseOas({
      preferredProvider: "gemini",
      preferredModel: "gemini-2.5-flash",
      capabilityRequired: "media_input",
    });
    expect(llmFindings(fixture)).toEqual([]);
    expect(validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"))).toEqual([]);
  });

  it("accepts anthropic + claude-sonnet-4-6 (no capability declared)", () => {
    const fixture = buildBaseOas({
      preferredProvider: "anthropic",
      preferredModel: "claude-sonnet-4-6",
    });
    expect(llmFindings(fixture)).toEqual([]);
    expect(validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"))).toEqual([]);
  });

  it("accepts provider-only declaration (model and capability omitted)", () => {
    const fixture = buildBaseOas({ preferredProvider: "openai" });
    expect(llmFindings(fixture)).toEqual([]);
    expect(validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FAIL OAS-LLM-002 — cross-provider model
// ---------------------------------------------------------------------------

describe("scanOasForLlmMetadata — OAS-LLM-002 (model not in provider allowlist)", () => {
  it.each([
    ["openai", "claude-sonnet-4-6"],
    ["gemini", "gpt-5"],
  ])(
    "rejects %s + %s with code OAS-LLM-002",
    (preferredProvider, preferredModel) => {
      const fixture = buildBaseOas({ preferredProvider, preferredModel });
      const findings = llmFindings(fixture);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe("OAS-LLM-002");
      // Surface validator output carries the stable code in the formatted string.
      const errs = validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"));
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/OAS-LLM-002/);
    },
  );
});

// ---------------------------------------------------------------------------
// FAIL OAS-LLM-003 — preferredModel without preferredProvider
// ---------------------------------------------------------------------------

describe("scanOasForLlmMetadata — OAS-LLM-003 (model without provider)", () => {
  it("rejects { preferredModel: 'gpt-5' } with no preferredProvider", () => {
    const fixture = buildBaseOas({ preferredModel: "gpt-5" });
    const findings = llmFindings(fixture);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("OAS-LLM-003");
    const errs = validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/OAS-LLM-003/);
  });
});

// ---------------------------------------------------------------------------
// FAIL OAS-LLM-004 — capabilityRequired:"media_input" without gemini
// ---------------------------------------------------------------------------

describe("scanOasForLlmMetadata — OAS-LLM-004 (media_input requires gemini)", () => {
  it("rejects { preferredProvider: 'openai', capabilityRequired: 'media_input' }", () => {
    const fixture = buildBaseOas({
      preferredProvider: "openai",
      capabilityRequired: "media_input",
    });
    const findings = llmFindings(fixture);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("OAS-LLM-004");
    const errs = validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/OAS-LLM-004/);
  });
});

// ---------------------------------------------------------------------------
// FAIL OAS-LLM-001 — Zod-detected structural violations, all normalized
// to the stable canonical ID so user surfaces never expose raw Zod error codes.
// ---------------------------------------------------------------------------

describe("scanOasForLlmMetadata — OAS-LLM-001 (Zod structural, normalized)", () => {
  it("rejects unknown preferredProvider with code OAS-LLM-001", () => {
    const fixture = buildBaseOas({ preferredProvider: "cohere" });
    const findings = llmFindings(fixture);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("OAS-LLM-001");
    const errs = validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/OAS-LLM-001/);
  });

  it("rejects unknown capabilityRequired with code OAS-LLM-001", () => {
    const fixture = buildBaseOas({ capabilityRequired: "vision" });
    const findings = llmFindings(fixture);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("OAS-LLM-001");
    const errs = validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/OAS-LLM-001/);
  });

  it("rejects unknown extra key under llm (.strict()) with code OAS-LLM-001", () => {
    const fixture = buildBaseOas({ preferredProvider: "openai", unknownExtra: "x" });
    const findings = llmFindings(fixture);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("OAS-LLM-001");
    const errs = validatorErrors(fixture).filter((e) => e.includes("OAS-LLM-"));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/OAS-LLM-001/);
  });
});

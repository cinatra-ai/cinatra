// DRIFT GUARD — the `@cinatra-ai/sdk-extensions/llm-provider-contract` LEAF is
// the EXACT public mirror of the host `cinatra.llmProvider` declaration model in
// `packages/agents/src/llm-provider-policy.ts` (cinatra#1712, epic #1711 S1
// AC1).
//
// The leaf is a true LEAF: it re-declares the schema/vocabulary rather than
// importing this host module (importing `@cinatra-ai/agents` from
// `@cinatra-ai/sdk-extensions` would invert the orchestration → agents
// layering). `@cinatra-ai/agents` is the ONE package that may import BOTH, so
// this is where the two are proven byte-for-byte equivalent: same ABI version,
// same closed vocabularies, IDENTICAL accept/reject verdict on a battery of
// inputs, and the build-known connector catalog parses cleanly under the leaf.
// A change to either side that breaks the mirror turns this red — the leaf and
// the host model can never silently drift.
import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDER_ABI_VERSION as HOST_ABI,
  LLM_PROVIDERS as HOST_PROVIDERS,
  LLM_CAPABILITIES as HOST_CAPS,
  NATIVE_MCP_STATUSES as HOST_STATUSES,
  MCP_APPROVAL_MODES as HOST_APPROVALS,
  LlmProviderDeclarationSchema as HostSchema,
  BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS,
  declarationSatisfiesCapability as hostSatisfies,
} from "../llm-provider-policy";
import {
  LLM_PROVIDER_ABI_VERSION as LEAF_ABI,
  LLM_PROVIDERS as LEAF_PROVIDERS,
  LLM_CAPABILITIES as LEAF_CAPS,
  NATIVE_MCP_STATUSES as LEAF_STATUSES,
  MCP_APPROVAL_MODES as LEAF_APPROVALS,
  LlmProviderDeclarationSchema as LeafSchema,
  parseLlmProvider,
  declarationSatisfiesCapability as leafSatisfies,
} from "@cinatra-ai/sdk-extensions/llm-provider-contract";

describe("cinatra.llmProvider leaf ↔ host model — vocabulary parity", () => {
  it("the ABI version literal is identical", () => {
    expect(LEAF_ABI).toBe(HOST_ABI);
  });
  it("the provider / capability / native_mcp-status / approval vocabularies are identical", () => {
    expect([...LEAF_PROVIDERS]).toEqual([...HOST_PROVIDERS]);
    expect([...LEAF_CAPS]).toEqual([...HOST_CAPS]);
    expect([...LEAF_STATUSES]).toEqual([...HOST_STATUSES]);
    expect([...LEAF_APPROVALS]).toEqual([...HOST_APPROVALS]);
  });
});

// A battery spanning valid catalogs + every rejection axis (bad abiVersion,
// unknown provider/status/approval, non-boolean caps, missing key, empty
// arrays, default∉allowed, extraneous keys at each strict level, garbage). The
// two schemas MUST agree on EVERY one — the mirror's core guarantee.
const BATTERY: unknown[] = [
  ...Object.values(BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS),
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", transports: ["http"], approval: "approval_required" } }, models: { default: "a", allowed: ["a", "b"] } },
  { abiVersion: 2, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native" } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "mistral", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native" } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "maybe" } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", approval: "sometimes" } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: "yes", media_input: false, native_mcp: { status: "native" } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, native_mcp: { status: "native" } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native" } }, models: { default: "a", allowed: [] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", transports: [] } }, models: { default: "a", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native" } }, models: { default: "z", allowed: ["a"] } },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native" } }, models: { default: "a", allowed: ["a"] }, extra: true },
  { abiVersion: 1, provider: "openai", capabilities: { function_tools: true, media_input: false, native_mcp: { status: "native", extra: 1 } }, models: { default: "a", allowed: ["a"] } },
  null,
  undefined,
  42,
  "str",
  [],
  {},
];

describe("cinatra.llmProvider leaf ↔ host model — accept/reject parity", () => {
  it.each(BATTERY.map((input, i) => [i, input]))("input #%i: host and leaf agree on accept/reject", (_i, input) => {
    const hostOk = HostSchema.safeParse(input).success;
    const leafOk = parseLlmProvider(input).ok;
    expect(leafOk).toBe(hostOk);
  });

  it("the LeafSchema and HostSchema are usable interchangeably (both accept every build-known declaration)", () => {
    for (const d of Object.values(BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS)) {
      expect(LeafSchema.safeParse(d).success).toBe(true);
      expect(HostSchema.safeParse(d).success).toBe(true);
    }
  });
});

describe("cinatra.llmProvider leaf ↔ host model — capability-resolution parity", () => {
  it("declarationSatisfiesCapability agrees for every build-known provider × capability", () => {
    for (const d of Object.values(BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS)) {
      const parsed = parseLlmProvider(d);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      for (const cap of HOST_CAPS) {
        expect(leafSatisfies(parsed.declaration, cap)).toBe(hostSatisfies(d, cap));
      }
    }
  });
});

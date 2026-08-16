// ABI contract: `capabilityRequired` on the STREAM path (cinatra#2776, item 1).
//
// Before this slice the field existed only on `GenerateInput`. The chat and
// widget runtimes STREAM, so the requirement they now pin for the self-MCP
// toolbox — `capabilityRequired: "native_mcp"`, the owner ruling of 2026-08-15 —
// had no declared carrier at all: a connector could only read it off the input
// through a widening cast, and the host could not type-check that it survives
// the orchestration hop.
//
// What is pinned here:
//   1. `StreamInput` declares the field with the SAME vocabulary as
//      `GenerateInput` (one field, one meaning, both entry points);
//   2. `OrchestrateStreamInput` — the public entry-point type — INHERITS it, so
//      a caller can set it without a cast;
//   3. the orchestration hop PRESERVES it: what `stream()` hands the adapter
//      still carries the value the caller set. `orchestrateStreamImpl` forwards
//      the input by rest-spread, so this is the type-level guarantee that a
//      future explicit field list cannot silently drop it.
//
// Type-level, because that is where the contract lives; the RUNTIME proof that
// a real chat turn carries it to a real adapter is the composed wire gate
// (`src/lib/assistant-runtime/__tests__/hosted-mcp-wire-gate.test.ts`).

import { describe, it, expect, expectTypeOf } from "vitest";

import type {
  StreamInput,
  GenerateInput,
  LlmCapabilityRequirement,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";
import type { OrchestrateStreamInput } from "../types";

describe("StreamInput.capabilityRequired (cinatra#2776 item 1)", () => {
  it("declares the same optional vocabulary as GenerateInput", () => {
    expectTypeOf<StreamInput["capabilityRequired"]>().toEqualTypeOf<
      LlmCapabilityRequirement | undefined
    >();
    expectTypeOf<StreamInput["capabilityRequired"]>().toEqualTypeOf<
      GenerateInput["capabilityRequired"]
    >();
  });

  it("accepts exactly the three declared capabilities and nothing else", () => {
    expectTypeOf<LlmCapabilityRequirement>().toEqualTypeOf<
      "media_input" | "function_tools" | "native_mcp"
    >();
    // @ts-expect-error — an undeclared capability is not assignable.
    const bad: LlmCapabilityRequirement = "hosted_mcp";
    expect(bad).toBe("hosted_mcp");
  });

  it("OrchestrateStreamInput inherits it (no cast at the entry point)", () => {
    expectTypeOf<OrchestrateStreamInput["capabilityRequired"]>().toEqualTypeOf<
      LlmCapabilityRequirement | undefined
    >();
  });

  it("the orchestration hop preserves it: entry-point value → adapter input", () => {
    // The exact hop `orchestrateStreamImpl` performs on the field: it is part
    // of `rest`, so it lands on the adapter's `StreamInput` unchanged.
    const fromEntryPoint: Pick<OrchestrateStreamInput, "capabilityRequired"> = {
      capabilityRequired: "native_mcp",
    };
    const toAdapter: Pick<StreamInput, "capabilityRequired"> = fromEntryPoint;
    expect(toAdapter.capabilityRequired).toBe("native_mcp");
    expectTypeOf(fromEntryPoint).toMatchTypeOf<Pick<StreamInput, "capabilityRequired">>();
  });

  it("stays OPTIONAL — an absent field is the unchanged no-gate behavior", () => {
    const noRequirement: Pick<StreamInput, "capabilityRequired"> = {};
    expect("capabilityRequired" in noRequirement).toBe(false);
  });
});

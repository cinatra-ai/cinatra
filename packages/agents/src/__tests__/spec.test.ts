/**
 * Type-smoke tests for CinatraAgentSpec / CinatraHandoff.
 *
 * These tests verify the TS types compose with concrete Zod schemas AND that
 * inferred types propagate correctly through the generics. They also exercise
 * handoff inputFilter narrowing at runtime. Run with:
 *   pnpm vitest run src/__tests__/spec.test.ts
 * from `packages/agent-builder/`.
 *
 * No DB, no React, no server-only imports.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import type {
  CinatraAgentSpec,
  CinatraHandoff,
  CinatraAgentProvider,
} from "../spec";

describe("CinatraAgentSpec", () => {
  it("composes with real Zod schemas and infers input/output types", () => {
    const inputSchema = z.object({ prompt: z.string() });
    const outputSchema = z.object({ text: z.string(), count: z.number() });

    const spec: CinatraAgentSpec<typeof inputSchema, typeof outputSchema> = {
      name: "echo",
      instructions: "echo back",
      inputSchema,
      outputSchema,
      tools: [],
      provider: "openai",
      hitlRequired: false,
    };

    // Runtime sanity — the schemas actually validate.
    expect(spec.inputSchema.parse({ prompt: "hi" })).toEqual({ prompt: "hi" });
    expect(spec.outputSchema.parse({ text: "ok", count: 1 })).toEqual({
      text: "ok",
      count: 1,
    });

    // Type-level checks.
    expectTypeOf<z.infer<typeof spec.inputSchema>>().toEqualTypeOf<{
      prompt: string;
    }>();
    expectTypeOf<z.infer<typeof spec.outputSchema>>().toEqualTypeOf<{
      text: string;
      count: number;
    }>();
  });

  it("handoff inputFilter narrows parent output correctly", () => {
    type ParentOut = { count: number; label: string };
    const handoff: CinatraHandoff<ParentOut> = {
      agent: {
        name: "child",
        instructions: "child",
        inputSchema: z.object({ n: z.number() }),
        outputSchema: z.object({}),
        tools: [],
      },
      condition: (out) => out.count > 0,
      inputFilter: (out) => ({ n: out.count }),
    };

    const narrowed = handoff.inputFilter({ count: 7, label: "x" });
    expect(narrowed).toEqual({ n: 7 });
    expect(handoff.condition?.({ count: 3, label: "y" })).toBe(true);
    expect(handoff.condition?.({ count: 0, label: "y" })).toBe(false);
  });

  it("provider literal union accepts known values", () => {
    // store.ts tolerates "langgraph" on the read path; the spec.ts type is
    // restricted to the values callers may SET.
    const providers: CinatraAgentProvider[] = [
      "openai",
      "anthropic",
      "gemini",
      "default",
    ];
    expect(providers).toHaveLength(4);
  });
});

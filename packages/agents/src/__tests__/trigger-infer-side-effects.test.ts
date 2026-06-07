/**
 * Unit tests for compile-time side-effects inference.
 *
 * Pure-logic tests for `trigger-infer-side-effects.ts`:
 *   - inferStepSideEffects: pattern matching against riskClass + author override
 *   - deriveTriggerMode: runtime → "full" | "start-only" mapping
 *   - collectGatedSteps: walks approvalPolicy.steps[], emits a flat GatedStep[]
 *
 * No DB, no Redis, no React. Vitest picks this up via the src/__tests__
 * recursive include in vitest.config.ts. Invoke explicitly:
 *   pnpm exec vitest run src/__tests__/trigger-infer-side-effects.test.ts
 * from packages/agent-builder/.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import {
  inferStepSideEffects,
  deriveTriggerMode,
  collectGatedSteps,
  SIDE_EFFECT_PATTERNS,
  type GatedStep,
  type TriggerMode,
  type InferenceCompiledOas,
} from "../trigger-infer-side-effects";

describe("inferStepSideEffects — pattern matching against riskClass", () => {
  it("matches *_send suffix → true (gmail_email_send)", () => {
    expect(inferStepSideEffects("gmail_email_send")).toBe(true);
  });

  it("matches *_publish suffix → true (linkedin_post_publish)", () => {
    expect(inferStepSideEffects("linkedin_post_publish")).toBe(true);
  });

  it("matches *_post suffix → true (crm_record_post)", () => {
    expect(inferStepSideEffects("crm_record_post")).toBe(true);
  });

  it("matches *_delete suffix → true (contact_record_delete)", () => {
    expect(inferStepSideEffects("contact_record_delete")).toBe(true);
  });

  it("non-matching riskClass → false (scrape_source_list)", () => {
    expect(inferStepSideEffects("scrape_source_list")).toBe(false);
  });

  it("substring match prohibited; suffix only (posts_research → false)", () => {
    // "posts_research" contains "_post" as a substring but not as a suffix.
    expect(inferStepSideEffects("posts_research")).toBe(false);
  });

  it("override true wins over no-pattern-match (anything → true)", () => {
    expect(inferStepSideEffects("anything", true)).toBe(true);
  });

  it("override false wins over pattern match (gmail_email_send → false)", () => {
    expect(inferStepSideEffects("gmail_email_send", false)).toBe(false);
  });

  it("SIDE_EFFECT_PATTERNS exposes all four canonical regexes", () => {
    expect(SIDE_EFFECT_PATTERNS).toHaveLength(4);
    expect(SIDE_EFFECT_PATTERNS.some((rx) => rx.test("foo_send"))).toBe(true);
    expect(SIDE_EFFECT_PATTERNS.some((rx) => rx.test("foo_publish"))).toBe(true);
    expect(SIDE_EFFECT_PATTERNS.some((rx) => rx.test("foo_post"))).toBe(true);
    expect(SIDE_EFFECT_PATTERNS.some((rx) => rx.test("foo_delete"))).toBe(true);
  });
});

describe("deriveTriggerMode — runtime → mode mapping", () => {
  it("wayflow → full", () => {
    expect(deriveTriggerMode("wayflow")).toBe("full");
  });

  it("cinatra-linear → full", () => {
    expect(deriveTriggerMode("cinatra-linear")).toBe("full");
  });

  it("langgraph → start-only", () => {
    expect(deriveTriggerMode("langgraph")).toBe("start-only");
  });

  it("autogen → start-only", () => {
    expect(deriveTriggerMode("autogen")).toBe("start-only");
  });

  it("oasAdapter → start-only", () => {
    expect(deriveTriggerMode("oasAdapter")).toBe("start-only");
  });

  it("unknown runtime string → start-only (conservative default)", () => {
    expect(deriveTriggerMode("unknown-type")).toBe("start-only");
  });

  it("undefined → full (DESIGN.md default)", () => {
    expect(deriveTriggerMode(undefined)).toBe("full");
  });
});

describe("collectGatedSteps — walks approvalPolicy.steps[] (single-level only)", () => {
  it("16: single side-effect step → one GatedStep with agentPath=[RootAgent], inferredOrManual=inferred", () => {
    const oas: InferenceCompiledOas = {
      packageName: null,
      approvalPolicy: {
        steps: [
          {
            stepNumber: 1,
            riskClass: "gmail_email_send",
            description: "Send email",
          },
        ],
      },
    };
    const out = collectGatedSteps(oas);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      stepNumber: 1,
      agentPath: ["RootAgent"],
      toolName: "gmail_email_send",
      inferredOrManual: "inferred",
      label: "Send email",
    });
  });

  it("17: same step but sideEffects: false author override → empty list", () => {
    const oas: InferenceCompiledOas = {
      packageName: null,
      approvalPolicy: {
        steps: [
          {
            stepNumber: 1,
            riskClass: "gmail_email_send",
            description: "Send email (dry-run preview)",
            sideEffects: false,
          },
        ],
      },
    };
    expect(collectGatedSteps(oas)).toEqual([]);
  });

  it("18: non-matching riskClass with sideEffects: true → one GatedStep, inferredOrManual=manual", () => {
    const oas: InferenceCompiledOas = {
      packageName: null,
      approvalPolicy: {
        steps: [
          {
            stepNumber: 2,
            riskClass: "scrape_run",
            sideEffects: true,
            description: "Scrape with side effect",
          },
        ],
      },
    };
    const out = collectGatedSteps(oas);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      stepNumber: 2,
      agentPath: ["RootAgent"],
      toolName: "scrape_run",
      inferredOrManual: "manual",
    });
  });

  it("19: childAgent step with NO sideEffects annotation → empty list (opaque-boundary rule, Q3 RESOLVED)", () => {
    const oas: InferenceCompiledOas = {
      packageName: null,
      approvalPolicy: {
        steps: [
          {
            stepNumber: 1,
            childAgent: { packageName: "@cinatra/email-sub-agent", inputMapping: {} },
            description: "Delegate to email sub-agent",
          },
        ],
      },
    };
    expect(collectGatedSteps(oas)).toEqual([]);
  });

  it("20: childAgent step WITH sideEffects: true → one GatedStep with toolName=(opaque), agentPath=[Root, ChildPkg]", () => {
    const oas: InferenceCompiledOas = {
      packageName: null,
      approvalPolicy: {
        steps: [
          {
            stepNumber: 3,
            childAgent: { packageName: "@cinatra/email-sub-agent", inputMapping: {} },
            sideEffects: true,
            description: "Delegate (annotated as side-effect)",
          },
        ],
      },
    };
    const out = collectGatedSteps(oas);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      stepNumber: 3,
      agentPath: ["RootAgent", "@cinatra/email-sub-agent"],
      toolName: "(opaque)",
      inferredOrManual: "manual",
    });
  });

  it("21: empty approvalPolicy.steps[] → []", () => {
    expect(
      collectGatedSteps({ packageName: null, approvalPolicy: { steps: [] } }),
    ).toEqual([]);
  });

  it("22: agentPath uses oas.packageName when available", () => {
    const oas: InferenceCompiledOas = {
      packageName: "@cinatra-ai/email-outreach-agent",
      approvalPolicy: {
        steps: [
          {
            stepNumber: 1,
            riskClass: "gmail_email_send",
          },
        ],
      },
    };
    const out = collectGatedSteps(oas);
    expect(out[0]?.agentPath).toEqual(["@cinatra-ai/email-outreach-agent"]);
  });

  it("handles a mixed list (gated + non-gated + opaque) deterministically and preserves stepNumber", () => {
    const oas: InferenceCompiledOas = {
      packageName: "@cinatra/multi-step-agent",
      approvalPolicy: {
        steps: [
          { stepNumber: 1, riskClass: "scrape_source_list" }, // skip
          { stepNumber: 2, riskClass: "gmail_email_send", description: "Send" }, // include (inferred)
          {
            stepNumber: 3,
            childAgent: { packageName: "@cinatra/sub", inputMapping: {} },
          }, // skip (opaque, no sideEffects)
          {
            stepNumber: 4,
            riskClass: "x",
            sideEffects: true,
            description: "Manual",
          }, // include (manual override)
        ],
      },
    };
    const out = collectGatedSteps(oas);
    expect(out.map((g) => g.stepNumber)).toEqual([2, 4]);
    expect(out[0]?.inferredOrManual).toBe("inferred");
    expect(out[1]?.inferredOrManual).toBe("manual");
  });

  it("falls back to step.name → step-${stepNumber} when description missing for label", () => {
    const oas: InferenceCompiledOas = {
      packageName: null,
      approvalPolicy: {
        steps: [
          { stepNumber: 7, riskClass: "thing_send", name: "send-thing" },
          { stepNumber: 8, riskClass: "other_send" },
        ],
      },
    };
    const out = collectGatedSteps(oas);
    expect(out[0]?.label).toBe("send-thing");
    expect(out[1]?.label).toBe("step-8");
    expect(out[0]?.stepId).toBe("send-thing");
    expect(out[1]?.stepId).toBe("step-8");
  });
});

describe("type-level guarantees", () => {
  it("GatedStep has the documented shape", () => {
    expectTypeOf<GatedStep>().toEqualTypeOf<{
      stepId: string;
      stepNumber: number;
      agentPath: string[];
      label: string;
      toolName: string;
      inferredOrManual: "inferred" | "manual";
    }>();
  });

  it("TriggerMode is the discriminated union 'full' | 'start-only'", () => {
    expectTypeOf<TriggerMode>().toEqualTypeOf<"full" | "start-only">();
  });
});

// ---------------------------------------------------------------------------
// Task 2 — type-level + structural assertions on CompiledAgentOas
// ---------------------------------------------------------------------------
import type { CompiledAgentOas, CompileOasResult } from "../oas-compiler";

describe("Task 2: CompiledAgentOas type extensions + discriminated-union shape", () => {
  it("23: success-path CompiledAgentOas has triggerMode + gatedSteps INSIDE .value", () => {
    // Structural assertion against a fabricated success-path object — proves
    // the type accepts the new fields and locates them in the right place.
    const fake: CompileOasResult = {
      ok: true,
      value: {
        approvalPolicy: { steps: [] },
        inputSchema: {},
        outputSchema: null,
        prompt: null,
        packageName: "@cinatra/test-agent",
        packageVersion: "1.0.0",
        agentDependencies: {},
        type: "flow",
        compiledPlan: [],
        hitlScreens: [],
        llmConfig: null,
        toolboxes: [],
        agentSpecVersion: "26.1.0",
        triggerMode: "full",
        gatedSteps: [
          {
            stepId: "send-1",
            stepNumber: 1,
            agentPath: ["@cinatra/test-agent"],
            label: "Send",
            toolName: "gmail_email_send",
            inferredOrManual: "inferred",
          },
        ],
        // Sibling cinatra.json metadata.
        cinatraConfig: null,
      },
    };
    if (fake.ok) {
      expect(fake.value.triggerMode).toBe("full");
      expect(fake.value.gatedSteps).toHaveLength(1);
      // The fields are NOT at the wrapper level (TS would also catch this):
      expect((fake as Record<string, unknown>).triggerMode).toBeUndefined();
      expect((fake as Record<string, unknown>).gatedSteps).toBeUndefined();
    }
  });

  it("24: error-path CompileOasResult has NO triggerMode/gatedSteps", () => {
    const fake: CompileOasResult = { ok: false, error: "boom" };
    // Discriminated union: only the success branch has these fields.
    expect((fake as Record<string, unknown>).triggerMode).toBeUndefined();
    expect((fake as Record<string, unknown>).gatedSteps).toBeUndefined();
  });

  it("25: type-only — CompiledAgentOas['triggerMode'] is TriggerMode and gatedSteps is GatedStep[]", () => {
    expectTypeOf<CompiledAgentOas["triggerMode"]>().toEqualTypeOf<TriggerMode>();
    expectTypeOf<CompiledAgentOas["gatedSteps"]>().toEqualTypeOf<GatedStep[]>();
  });
});

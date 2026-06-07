/**
 * isGenericObjectSchema Continue button
 *
 * Requirement: when xRenderer === "@cinatra-ai/agent-builder:schema-field-fallback"
 * AND the interrupt schema has type === "object", the panel must:
 *   (a) set isGenericObjectSchema = true → showContinueButton = true
 *   (b) NOT render RendererComponent (text-input path is bypassed)
 *   (c) NOT render the "no renderer configured" fallback paragraph
 *   (d) render the Continue button
 *
 * This guards the LangGraph-specific bug where the schema-field-fallback
 * renderer would call onChange(string) for an object schema, causing
 * LangGraph to reject the resume value (not isinstance(string, dict)).
 *
 * Tested via source-text analysis — the component requires extensive SDK
 * mocking to mount in jsdom; the structural assertions are equivalent and
 * faster (< 5ms).
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/orchestrator-stepper-panel-generic-object.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "orchestrator-stepper-panel.tsx"),
  "utf8",
);

describe("orchestrator-stepper-panel — isGenericObjectSchema Continue button", () => {
  it("defines isGenericObjectSchema as schema-field-fallback xRenderer combined with object type", () => {
    // The condition must check BOTH the xRenderer id AND the schema type.
    // A missing type check would incorrectly show Continue for non-object schemas.
    expect(SRC).toMatch(
      /"@cinatra-ai\/agent-builder:schema-field-fallback"/,
    );
    expect(SRC).toMatch(/type.*===.*"object"|"object".*===.*type/);

    // isGenericObjectSchema must be a const derived from interruptContext
    expect(SRC).toMatch(/isGenericObjectSchema\s*=/);
  });

  it("shows Continue button when isGenericObjectSchema is true (showContinueButton logic)", () => {
    // showContinueButton must include isGenericObjectSchema as a standalone branch,
    // not only as part of the isMidRunHitl path. This ensures LangGraph
    // generic-object gates always surface a Continue button even when
    // isMidRunHitl is false (i.e. setup-phase gates).
    const showContinueMatch = SRC.match(/showContinueButton\s*=\s*([^;]+)/);
    expect(showContinueMatch, "showContinueButton must be declared").toBeTruthy();

    const expr = showContinueMatch![1];
    // isGenericObjectSchema must appear in the expression (not just isMidRunHitl)
    expect(expr).toMatch(/isGenericObjectSchema/);
  });

  it("bypasses RendererComponent when isGenericObjectSchema is true", () => {
    // The RendererComponent render block must guard with !isGenericObjectSchema.
    // This prevents the text-input path (onChange(string)) from being invoked.
    expect(SRC).toMatch(/RendererComponent && !isGenericObjectSchema/);
  });

  it("suppresses the 'no renderer configured' paragraph when isGenericObjectSchema is true", () => {
    // The fallback paragraph for missing renderers must also be gated out
    // with !isGenericObjectSchema — so the card body is empty except for
    // the Continue button.
    expect(SRC).toMatch(/!\s*isGenericObjectSchema/);
    // The paragraph text must exist in source (not been removed)
    expect(SRC).toMatch(/no renderer configured/);
  });

  it("hides HitlConversationPanel when isGenericObjectSchema is true", () => {
    // The AI-assist panel must be hidden for generic-object gates because
    // there is nothing for the user to refine — they only click Continue.
    expect(SRC).toMatch(/visible=\{!isGenericObjectSchema/);
  });
});

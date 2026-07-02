/**
 * Empty-string xRenderer guard in AG UI stream handler.
 *
 * Requirement:
 *   When an SSE INTERRUPT event arrives with xRenderer: "" (empty string),
 *   the stream handler must normalize it to the fallback renderer ID
 *   "@cinatra-ai/agent-builder:schema-field-fallback" before calling
 *   setInterruptContext. A non-empty xRenderer must pass through unchanged.
 *
 * Why this matters:
 *   The isGenericObjectSchema check in orchestrator-stepper-panel.tsx compares
 *   interruptContext.xRenderer === "@cinatra-ai/agent-builder:schema-field-fallback".
 *   If an empty string arrives and is stored verbatim, that check evaluates to
 *   false, the Continue button is NOT shown, and the text-input path fires —
 *   causing LangGraph to reject the resume value with "not isinstance(string, dict)".
 *
 * The null-coalescing operator (??) does NOT handle empty string (only null/undefined).
 *   Correct guard: `interruptEvent.xRenderer || "@cinatra-ai/agent-builder:schema-field-fallback"`
 *   Wrong pattern: `interruptEvent.xRenderer ?? "@cinatra-ai/agent-builder:schema-field-fallback"`
 *
 * Tested via source-text analysis against use-ag-ui-run-stream.ts — the correct
 * guard must appear in the INTERRUPT case handler before setInterruptContext.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/langgraph-stream-xrenderer-fallback.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

const SRC = readFileSync(
  join(__dirname, "..", "use-ag-ui-run-stream.ts"),
  "utf8",
);

// Isolate the INTERRUPT case block for focused assertions.
const INTERRUPT_BLOCK = (() => {
  const start = SRC.indexOf('case "INTERRUPT"');
  const end = SRC.indexOf('case "RESUME"', start);
  return start !== -1 && end !== -1 ? SRC.slice(start, end) : "";
})();

describe("use-ag-ui-run-stream — empty-string xRenderer fallback guard", () => {
  it("INTERRUPT case block is present in the source", () => {
    expect(INTERRUPT_BLOCK, 'case "INTERRUPT" block must exist in use-ag-ui-run-stream.ts').not.toBe("");
  });

  it("xRenderer stored in setInterruptContext is guarded against empty string with || operator", () => {
    // The || operator normalizes both null/undefined AND empty string "".
    // The ?? operator only normalizes null/undefined — leaving "" verbatim.
    //
    // Correct: interruptEvent.xRenderer || "@cinatra-ai/agent-builder:schema-field-fallback"
    // Wrong:   interruptEvent.xRenderer ?? "@cinatra-ai/agent-builder:schema-field-fallback"
    //          interruptEvent.xRenderer  (no guard at all)
    //
    // We assert the || fallback form is present in the INTERRUPT block.
    const hasOrFallback = /interruptEvent\.xRenderer\s*\|\|/.test(INTERRUPT_BLOCK) ||
      /xRenderer\s*:\s*\(\s*interruptEvent\.xRenderer\s*\|\|/.test(INTERRUPT_BLOCK) ||
      /xRenderer\s*=\s*interruptEvent\.xRenderer\s*\|\|/.test(INTERRUPT_BLOCK);

    expect(
      hasOrFallback,
      "The INTERRUPT handler must use '||' (not '??') to normalize empty-string xRenderer to the fallback ID. " +
        "Found INTERRUPT block:\n" + INTERRUPT_BLOCK.slice(0, 500),
    ).toBe(true);
  });

  it("the fallback ID is referenced in the INTERRUPT case handler (via the centralized constant)", () => {
    // The normalization must produce the canonical fallback id. Since the id is
    // now centralized in ./agent-builder-ids (identity-surface ruling), the
    // handler references the imported SCHEMA_FIELD_FALLBACK_RENDERER_ID constant
    // rather than the inline literal — accept either form so the test pins the
    // BEHAVIOR (fallback normalization), not a particular spelling.
    const referencesFallback =
      /SCHEMA_FIELD_FALLBACK_RENDERER_ID/.test(INTERRUPT_BLOCK) ||
      INTERRUPT_BLOCK.includes(`"${SCHEMA_FIELD_FALLBACK_RENDERER_ID}"`);
    expect(
      referencesFallback,
      "INTERRUPT handler must reference the schema-field-fallback id (constant SCHEMA_FIELD_FALLBACK_RENDERER_ID or its literal) as the fallback. " +
        "Found INTERRUPT block:\n" + INTERRUPT_BLOCK.slice(0, 500),
    ).toBe(true);
    // And the centralized constant must still resolve to the canonical string.
    expect(SCHEMA_FIELD_FALLBACK_RENDERER_ID).toBe("@cinatra-ai/agent-builder:schema-field-fallback");
  });

  it("non-empty xRenderer is not overwritten (positive-control: xRenderer is not hardcoded to fallback)", () => {
    // The guard must be conditional — a non-empty xRenderer from the SSE event
    // must pass through unchanged. This rules out a naive "always use fallback" fix.
    //
    // Detecting this structurally: if the INTERRUPT block contains the fallback
    // ID BUT the guard is || (short-circuit), then a non-empty xRenderer will
    // take the left branch and pass through. This is already implied by the
    // || guard check above — we assert the raw xRenderer field is still read.
    expect(INTERRUPT_BLOCK).toMatch(/interruptEvent\.xRenderer/);
  });
});

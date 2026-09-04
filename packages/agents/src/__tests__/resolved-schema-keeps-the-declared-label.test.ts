/**
 * THE RESOLVED SCHEMA CARRIES THE LABEL THE COMPILED ONE CARRIES
 * (cinatra#3047 fix leg 8, convergence).
 *
 * `oas-compiler.ts` reads `metadata.cinatra.inputTitles` and writes the mapped
 * label into the compiled property's `title` (`oas-compiler.ts`, "title is the
 * field identifier (camelCase); inputTitles maps it to a human-readable
 * label"). `resolveTemplateInputSchema` — the path an agent whose stored
 * `input_schema` is empty resolves through, which is the very case that module
 * exists for — wrote NO title at all, so every display name an agent declared
 * was lost on that path and the rail fell back to the generic step label.
 *
 * The module's own rule for the `x-` presentation hints says why that cannot
 * stand: "The two pipelines must agree: a row with an empty DB inputSchema
 * resolves through HERE, and a hint that survived only one of the paths would
 * render one form on a freshly compiled template and a different one on a
 * derived template." A label is read the same way.
 *
 * AND ONLY A MAPPED LABEL IS WRITTEN. An unmapped field carries no title
 * rather than its own key restated, which is what `run-input-steps.ts` reads
 * to tell a display name from a machine field key.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/resolved-schema-keeps-the-declared-label.test.ts
 */
import { describe, expect, it } from "vitest";

import { __testOnly } from "../input-schema-resolver";
import { RUN_INPUT_STEP_FALLBACK_LABEL, buildRunInputSteps } from "../run-input-steps";

/** A start node shaped exactly as an agent's own OAS declares one. */
function oasWith(inputTitles: Record<string, string> | undefined) {
  return {
    component_type: "Flow",
    start_node: { $component_ref: "start" },
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        metadata: {
          cinatra: {
            required: ["spec"],
            hidden: [],
            ...(inputTitles ? { inputTitles } : {}),
          },
        },
        inputs: [{ title: "spec", type: "string" }],
      },
    },
  };
}

describe("the resolved input schema and the display name", () => {
  it("carries the label the agent mapped its field to", () => {
    const resolved = __testOnly.deriveFullSchemaFromOas(
      oasWith({ spec: "Specification" }),
    )!;

    expect(resolved.properties.spec).toMatchObject({ title: "Specification" });
    const steps = buildRunInputSteps({
      required: resolved.required,
      properties: resolved.properties,
      inputParams: {},
      atInputMoment: true,
    });
    expect(steps[0]!.label).toBe("Specification");
  });

  it("stores the mapped label trimmed — the form it was checked in", () => {
    // Codex convergence, fix leg 8: the mapping was validated after a trim and
    // stored raw, so the label read back was not the string that was checked.
    const resolved = __testOnly.deriveFullSchemaFromOas(
      oasWith({ spec: "  Specification  " }),
    )!;

    expect(resolved.properties.spec).toMatchObject({ title: "Specification" });
  });

  it("writes NO title for a field the agent mapped nothing to", () => {
    const resolved = __testOnly.deriveFullSchemaFromOas(oasWith(undefined))!;

    expect(resolved.properties.spec).not.toHaveProperty("title");
    const steps = buildRunInputSteps({
      required: resolved.required,
      properties: resolved.properties,
      inputParams: {},
      atInputMoment: true,
    });
    // The step takes the tab's own name — never the field key "spec".
    expect(steps[0]!.label).toBe(RUN_INPUT_STEP_FALLBACK_LABEL);
    expect(steps[0]!.label).not.toBe("spec");
  });
});

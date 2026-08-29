/**
 * ENABLER 0.16 (compiler half) — THE COMPILER FLAGS AN AGENT WHOSE STEPS SAVE TO
 * A TYPE IT NEITHER DECLARES NOR DEPENDS ON
 * (`PLAN: Agents Lifecycle (C)` §4.1, cinatra#3028 / epic #3023).
 *
 * THE PLAN'S SENTENCE, VERBATIM: "The unowned-type refusal, at both ends: the
 * save boundary refuses a type that no installed extension and not the host
 * owns, with a named reason; and the compiler flags an agent whose steps save to
 * a type it neither declares nor depends on — the dynamic-type namespace
 * resolves nowhere by design."
 *
 * The save-boundary half lives in
 * `src/lib/artifacts/__tests__/enabler-0-16-unowned-type-refusal.test.ts`; this
 * file is the compiler half, which reads the OAS and nothing else.
 */
import { describe, expect, it } from "vitest";

import { scanOasForUndeclaredTypeSaves } from "../validate-oas-runtime-invariants";

describe("0.16 — the compiler flags a step that saves an undeclared type", () => {
  /** A minimal OAS with ONE passthrough `objects_save` node saving `typeId`. */
  function oasSaving(typeId: string): Record<string, unknown> {
    return {
      component_type: "Flow",
      id: "flow-1",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: { component_type: "StartNode", id: "start", inputs: [] },
        save: {
          component_type: "ApiNode",
          id: "save",
          url: "/api/agents/passthrough",
          data: { tool: "objects_save", typeHint: typeId },
          inputs: [],
        },
        end: { component_type: "EndNode", id: "end", outputs: [] },
      },
      data_flow_connections: [],
    };
  }

  it("flags a save to the dynamic namespace with the named reason", () => {
    const findings = scanOasForUndeclaredTypeSaves(
      oasSaving("@dynamic/types:blog-pipeline-selected-idea"),
      { produces: ["@cinatra-ai/blog-post-artifact"] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.code).toBe("OAS-RUNTIME-013");
    expect(findings[0]!.message).toContain("@dynamic/types:blog-pipeline-selected-idea");
    expect(findings[0]!.message).toContain("dynamic-namespace");
  });

  it("flags a save to a type the agent neither declares nor depends on", () => {
    const findings = scanOasForUndeclaredTypeSaves(
      oasSaving("@cinatra-ai/linkedin-artifact:post"),
      { produces: ["@cinatra-ai/blog-post-artifact"], dependsOn: [] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("@cinatra-ai/linkedin-artifact");
  });

  it("passes a save to a type the agent declares it produces", () => {
    expect(
      scanOasForUndeclaredTypeSaves(oasSaving("@cinatra-ai/blog-post-artifact:post"), {
        produces: ["@cinatra-ai/blog-post-artifact"],
      }),
    ).toEqual([]);
  });

  it("passes a save to a type the agent depends on", () => {
    expect(
      scanOasForUndeclaredTypeSaves(oasSaving("@cinatra-ai/blog-idea-artifact:idea"), {
        produces: [],
        dependsOn: ["@cinatra-ai/blog-idea-artifact"],
      }),
    ).toEqual([]);
  });

  it("says nothing when the agent's declarations are unknown", () => {
    expect(
      scanOasForUndeclaredTypeSaves(oasSaving("@dynamic/types:whatever"), {
        produces: null,
        dependsOn: null,
      }),
    ).toEqual([]);
  });
});


/**
 * Unit contract for `normalizeOasDocumentForExport` (cinatra#2645).
 *
 * The export boundary must repair the two wayflow-exporter artifacts the
 * import compiler rejects:
 *   1. absent `metadata.cinatra.type` on a Flow document (derived: Flow ->
 *      "flow"),
 *   2. `description: null` for absent optional descriptions (removed,
 *      recursively — edges of both kinds, ports, nodes, nested subflows).
 *
 * Also pins minimality: a valid document is reported unchanged (so
 * agent_export keeps shipping the original bytes), string descriptions and
 * the schema-tolerated `from_branch: null` survive, and the repair is
 * idempotent and non-mutating.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compiler-export-normalize.test.ts
 */
import { describe, expect, it } from "vitest";

import { normalizeOasDocumentForExport, validateOasFlowStructural } from "../oas-compiler";

/**
 * Structural replica of the real defective export from #2645
 * (a wayflow-style Flow: Start -> LlmNode -> End; `metadata.cinatra` carries
 * label/summary/hitlScreens/packageName/packageSlug but NO `type`; every
 * connection serializes its absent description as `null`).
 */
function buildDefectiveWayflowFlow(): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "wayflow-drafter",
    name: "Wayflow Drafter",
    description: "A drafter agent exported by the wayflow-style writer.",
    metadata: {
      cinatra: {
        label: "Wayflow Drafter",
        summary: "Drafts things.",
        hitlScreens: [],
        packageName: "@cinatra-test/wayflow-drafter-agent",
        packageSlug: "wayflow-drafter-agent",
      },
    },
    inputs: [
      { type: "string", title: "topic", description: "The topic." },
      { type: "string", title: "tone", default: "friendly", description: null },
    ],
    outputs: [{ type: "string", title: "draft", description: "The draft." }],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "draft" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      {
        id: "start_to_draft",
        name: "start_to_draft",
        metadata: {},
        description: null,
        from_branch: null,
        component_type: "ControlFlowEdge",
        from_node: { $component_ref: "start" },
        to_node: { $component_ref: "draft" },
      },
      {
        id: "draft_to_end",
        name: "draft_to_end",
        metadata: {},
        description: null,
        from_branch: null,
        component_type: "ControlFlowEdge",
        from_node: { $component_ref: "draft" },
        to_node: { $component_ref: "end" },
      },
    ],
    data_flow_connections: [
      {
        id: "topic_to_draft",
        name: "topic_to_draft",
        metadata: {},
        description: null,
        component_type: "DataFlowEdge",
        source_node: { $component_ref: "start" },
        source_output: "topic",
        destination_node: { $component_ref: "draft" },
        destination_input: "topic",
      },
      {
        id: "draft_to_end_data",
        name: "draft_to_end_data",
        metadata: {},
        description: null,
        component_type: "DataFlowEdge",
        source_node: { $component_ref: "draft" },
        source_output: "output",
        destination_node: { $component_ref: "end" },
        destination_input: "draft",
      },
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "start",
        description: null,
        inputs: [{ type: "string", title: "topic", description: "The topic." }],
      },
      draft: {
        component_type: "LlmNode",
        id: "draft",
        name: "draft",
        description: null,
        prompt_template: "Draft about {{topic}}.",
        inputs: [{ type: "string", title: "topic", description: null }],
        outputs: [{ type: "string", title: "output", description: null }],
      },
      end: {
        component_type: "EndNode",
        id: "end",
        name: "end",
        description: null,
        outputs: [{ type: "string", title: "draft", description: "The draft." }],
      },
    },
  };
}

function collectNullDescriptionPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectNullDescriptionPaths(item, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const rec = value as Record<string, unknown>;
  const own = rec.description === null && "description" in rec ? [`${path}.description`] : [];
  return own.concat(
    Object.entries(rec).flatMap(([k, v]) => collectNullDescriptionPaths(v, `${path}.${k}`)),
  );
}

describe("metadata.cinatra.type derivation", () => {
  it("derives \"flow\" from component_type Flow when type is absent, preserving sibling keys", () => {
    const result = normalizeOasDocumentForExport(buildDefectiveWayflowFlow());
    expect(result.changed).toBe(true);
    const cinatra = (result.doc.metadata as { cinatra: Record<string, unknown> }).cinatra;
    expect(cinatra.type).toBe("flow");
    expect(cinatra.label).toBe("Wayflow Drafter");
    expect(cinatra.summary).toBe("Drafts things.");
    expect(cinatra.packageName).toBe("@cinatra-test/wayflow-drafter-agent");
    expect(cinatra.packageSlug).toBe("wayflow-drafter-agent");
  });

  it("creates metadata.cinatra when the document has no metadata at all", () => {
    const doc = buildDefectiveWayflowFlow();
    delete doc.metadata;
    const result = normalizeOasDocumentForExport(doc);
    expect(result.changed).toBe(true);
    expect(
      (result.doc.metadata as { cinatra: Record<string, unknown> }).cinatra.type,
    ).toBe("flow");
  });

  it("never overwrites an existing valid enum value", () => {
    const doc = buildDefectiveWayflowFlow();
    ((doc.metadata as Record<string, unknown>).cinatra as Record<string, unknown>).type = "leaf";
    const result = normalizeOasDocumentForExport(doc);
    expect(
      (result.doc.metadata as { cinatra: Record<string, unknown> }).cinatra.type,
    ).toBe("leaf");
  });

  it("repairs an invalid (non-enum) type value the same way as an absent one", () => {
    const doc = buildDefectiveWayflowFlow();
    ((doc.metadata as Record<string, unknown>).cinatra as Record<string, unknown>).type = "Flow";
    const result = normalizeOasDocumentForExport(doc);
    expect(
      (result.doc.metadata as { cinatra: Record<string, unknown> }).cinatra.type,
    ).toBe("flow");
  });

  it("does not inject a type into a non-Flow document", () => {
    const doc: Record<string, unknown> = {
      component_type: "Agent",
      id: "a",
      name: "A",
      system_prompt: "x",
    };
    const result = normalizeOasDocumentForExport(doc);
    expect(result.changed).toBe(false);
    expect(result.doc.metadata).toBeUndefined();
  });
});

describe("null-description removal", () => {
  it("removes every description: null — edges of both kinds, ports, nodes", () => {
    const defective = buildDefectiveWayflowFlow();
    expect(collectNullDescriptionPaths(defective).length).toBeGreaterThan(0);

    const result = normalizeOasDocumentForExport(defective);
    expect(collectNullDescriptionPaths(result.doc)).toEqual([]);
    // Removed means ABSENT, not empty string.
    const edge = (result.doc.control_flow_connections as Array<Record<string, unknown>>)[0];
    expect("description" in edge).toBe(false);
  });

  it("preserves string descriptions and the schema-tolerated from_branch: null", () => {
    const result = normalizeOasDocumentForExport(buildDefectiveWayflowFlow());
    const inputs = result.doc.inputs as Array<Record<string, unknown>>;
    expect(inputs[0].description).toBe("The topic.");
    const edge = (result.doc.control_flow_connections as Array<Record<string, unknown>>)[0];
    expect(edge.from_branch).toBeNull();
    expect(edge.metadata).toEqual({});
  });
});

describe("minimality + safety", () => {
  it("reports a valid document unchanged and returns the original reference", () => {
    const valid = normalizeOasDocumentForExport(buildDefectiveWayflowFlow()).doc;
    const second = normalizeOasDocumentForExport(valid);
    expect(second.changed).toBe(false);
    expect(second.repairs).toEqual([]);
    expect(second.doc).toBe(valid);
  });

  it("never mutates the input document", () => {
    const defective = buildDefectiveWayflowFlow();
    const before = JSON.stringify(defective);
    normalizeOasDocumentForExport(defective);
    expect(JSON.stringify(defective)).toBe(before);
  });
});

describe("compiler agreement (the #2645 contract)", () => {
  it("the defective document fails validateOasFlowStructural with exactly the issue's two error classes", () => {
    const errors = validateOasFlowStructural(buildDefectiveWayflowFlow());
    expect(errors.some((e) => e.includes("metadata.cinatra.type"))).toBe(true);
    expect(
      errors.some((e) => e.includes("control_flow_connections") && e.includes("description")),
    ).toBe(true);
    expect(
      errors.some((e) => e.includes("data_flow_connections") && e.includes("description")),
    ).toBe(true);
  });

  it("the normalized document passes validateOasFlowStructural clean", () => {
    const result = normalizeOasDocumentForExport(buildDefectiveWayflowFlow());
    expect(validateOasFlowStructural(result.doc)).toEqual([]);
  });
});

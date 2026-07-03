// cinatra#924 — artifacts parity gates (Layer 2 + Layer 3).
//
// Pins the RATCHET: an un-migrated agent shape (declares `cinatra.produces`,
// has no binding) produces WARNING-only findings and ZERO blockers from the
// advisory Layer-3 surface — so wiring the scanner into /api/oas-lint/scan-all
// (which re-stamps to the blocker-authorized policy source) can never red the
// fleet. Also pins each of OAS-RUNTIME-009..012 (pos + neg) and the Layer-2
// publish contract.

import { describe, it, expect } from "vitest";

import { scanOasForArtifactParityFindings } from "../validate-oas-runtime-invariants";
import { evaluateProducesMaterializationContract } from "../verdaccio/package-contract";

const ARTIFACT = "@cinatra-ai/blog-post-artifact";

// A valid EndNode output binding (the #923 grammar) targeting ARTIFACT.
function validBindingOas(extension = ARTIFACT): Record<string, unknown> {
  return {
    $referenced_components: {
      end: {
        component_type: "EndNode",
        id: "end",
        outputs: [
          { title: "draft", type: "string" },
          { title: "title", type: "string" },
          {
            title: "artifact",
            type: "string",
            cinatra: {
              artifact: {
                extension,
                contentFrom: "draft",
                declaredMime: "text/markdown",
                titleFrom: "title",
              },
            },
          },
        ],
      },
    },
  };
}

// A produces-declaring agent with NO binding (the un-migrated fleet shape:
// blog-draft-writer / blog-idea-generator).
function unmigratedOas(): Record<string, unknown> {
  return {
    $referenced_components: {
      end: {
        component_type: "EndNode",
        id: "end",
        outputs: [{ title: "draft", type: "string" }],
      },
    },
  };
}

// A passthrough `objects_save` write node inside a Flow. `selectedIdeaJson` is
// DFE-sourced; `other` is consumed but neither sourced nor defaulted.
function flowWithWriteNode(): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "flow",
    inputs: [],
    start_node: { $component_ref: "start" },
    data_flow_connections: [
      {
        component_type: "DataFlowEdge",
        source_node: { $component_ref: "start" },
        source_output: "seed",
        destination_node: { $component_ref: "writer" },
        destination_input: "selectedIdeaJson",
      },
    ],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", inputs: [] },
      writer: {
        component_type: "ApiNode",
        id: "writer",
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        http_method: "POST",
        data: {
          tool: "objects_save",
          input: {
            selectedIdeaJson: "{{ selectedIdeaJson }}",
            other: "{{ other }}",
          },
        },
        inputs: [
          { title: "selectedIdeaJson", type: "string" },
          { title: "other", type: "string" },
        ],
      },
      end: { component_type: "EndNode", id: "end", outputs: [] },
    },
  };
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code);
}

describe("scanOasForArtifactParityFindings — ratchet (Layer 3 is advisory)", () => {
  it("emits ONLY warnings and ZERO blockers for an un-migrated produces shape", () => {
    const findings = scanOasForArtifactParityFindings(unmigratedOas(), {
      produces: [ARTIFACT],
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
    expect(findings.some((f) => f.severity === "blocker")).toBe(false);
  });

  it("never emits a blocker even when the binding annotation is malformed", () => {
    // binding.extension ∉ produces — a grammar error the COMPILE gate blocks;
    // Layer 3 mirrors it as advisory ONLY.
    const findings = scanOasForArtifactParityFindings(validBindingOas("@x/nope"), {
      produces: [ARTIFACT],
    });
    expect(findings.some((f) => f.code === "OAS-RUNTIME-009")).toBe(true);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });
});

describe("scanOasForArtifactParityFindings — OAS-RUNTIME-009 (produces ⇒ edge)", () => {
  it("warns when a produces entry has no materialization edge", () => {
    const findings = scanOasForArtifactParityFindings(unmigratedOas(), {
      produces: [ARTIFACT],
    });
    const nine = findings.filter((f) => f.code === "OAS-RUNTIME-009");
    expect(nine).toHaveLength(1);
    expect(nine[0].message).toContain(ARTIFACT);
  });

  it("is silent when a valid EndNode binding covers the produces entry", () => {
    const findings = scanOasForArtifactParityFindings(validBindingOas(), {
      produces: [ARTIFACT],
    });
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-009")).toHaveLength(0);
  });

  it("is silent when a valid artifact_materialize node covers the produces entry", () => {
    const oas = {
      $referenced_components: {
        mat: {
          component_type: "ApiNode",
          id: "mat",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: {
            tool: "artifact_materialize",
            input: {
              extension: ARTIFACT,
              content: "{{ draft }}",
              title: "{{ title }}",
              declaredMime: "text/markdown",
              node_id: "mat",
            },
          },
        },
      },
    };
    const findings = scanOasForArtifactParityFindings(oas, { produces: [ARTIFACT] });
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-009")).toHaveLength(0);
  });

  it("skips the coverage check when produces is unknown (null)", () => {
    const findings = scanOasForArtifactParityFindings(unmigratedOas(), {
      produces: null,
    });
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-009")).toHaveLength(0);
  });
});

describe("scanOasForArtifactParityFindings — OAS-RUNTIME-010 (passthrough write DFE)", () => {
  it("warns on a write-node input with no sourcing DataFlowEdge and no default", () => {
    const findings = scanOasForArtifactParityFindings(flowWithWriteNode());
    const ten = findings.filter((f) => f.code === "OAS-RUNTIME-010");
    expect(ten).toHaveLength(1);
    expect(ten[0].message).toContain('"other"');
    expect(ten[0].severity).toBe("warning");
  });

  it("does not warn for a DFE-sourced input", () => {
    const findings = scanOasForArtifactParityFindings(flowWithWriteNode());
    const ten = findings.filter((f) => f.code === "OAS-RUNTIME-010");
    expect(ten.some((f) => f.message.includes('"selectedIdeaJson"'))).toBe(false);
  });

  it("does not warn for a defaulted input", () => {
    const oas = flowWithWriteNode();
    const writer = (oas.$referenced_components as Record<string, { inputs: Array<Record<string, unknown>> }>)
      .writer;
    // give `other` a default → self-satisfying, no edge required
    writer.inputs = [
      { title: "selectedIdeaJson", type: "string" },
      { title: "other", type: "string", default: "" },
    ];
    const findings = scanOasForArtifactParityFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-010")).toHaveLength(0);
  });
});

describe("scanOasForArtifactParityFindings — OAS-RUNTIME-011 (riskClass mislabel)", () => {
  function nodeWith(riskClass: string, tool: string): Record<string, unknown> {
    return {
      $referenced_components: {
        n: {
          component_type: "ApiNode",
          id: "n",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: { tool, input: {} },
          metadata: { cinatra: { riskClass } },
        },
      },
    };
  }

  it("warns on read_only + a write tool (objects_save)", () => {
    const findings = scanOasForArtifactParityFindings(nodeWith("read_only", "objects_save"));
    const eleven = findings.filter((f) => f.code === "OAS-RUNTIME-011");
    expect(eleven).toHaveLength(1);
    expect(eleven[0].severity).toBe("warning");
    expect(eleven[0].message).toContain("objects_save");
  });

  it("does NOT warn on an accurate write label (write_safe)", () => {
    const findings = scanOasForArtifactParityFindings(nodeWith("write_safe", "objects_save"));
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-011")).toHaveLength(0);
  });

  it("does NOT warn on read_only + a read tool (objects_classify)", () => {
    const findings = scanOasForArtifactParityFindings(nodeWith("read_only", "objects_classify"));
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-011")).toHaveLength(0);
  });
});

describe("scanOasForArtifactParityFindings — OAS-RUNTIME-012 (legacy prose)", () => {
  it("warns when a prompt field instructs objects_save / artifact_authoring_emit", () => {
    const oas = {
      $referenced_components: {
        agent: {
          component_type: "LlmAgent",
          id: "agent",
          system_prompt: "When done, call objects_save to persist the draft.",
        },
      },
    };
    const findings = scanOasForArtifactParityFindings(oas);
    const twelve = findings.filter((f) => f.code === "OAS-RUNTIME-012");
    expect(twelve).toHaveLength(1);
    expect(twelve[0].severity).toBe("warning");
  });

  it("does NOT flag a structural data.tool selection as prose", () => {
    const oas = {
      $referenced_components: {
        writer: {
          component_type: "ApiNode",
          id: "writer",
          url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
          data: { tool: "objects_save", input: {} },
          // a `description` documents intent — it is not an LLM instruction
          description: "Deterministic seam that calls objects_save.",
        },
      },
    };
    const findings = scanOasForArtifactParityFindings(oas);
    expect(findings.filter((f) => f.code === "OAS-RUNTIME-012")).toHaveLength(0);
  });
});

describe("evaluateProducesMaterializationContract — Layer 2 publish contract", () => {
  it("returns no findings when a valid binding covers produces", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [ARTIFACT],
      oasDoc: validBindingOas(),
    });
    expect(findings).toHaveLength(0);
  });

  it("WARNS (never blocks) on a produces entry with no materialization edge", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [ARTIFACT],
      oasDoc: unmigratedOas(),
    });
    expect(codes(findings)).toContain("ARTIFACT-CONTRACT-PRODUCES-UNMATERIALIZED");
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("BLOCKS on a malformed binding annotation (binding.extension ∉ produces)", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [ARTIFACT], // OAS binds "@x/nope" instead
      oasDoc: validBindingOas("@x/nope"),
    });
    expect(codes(findings)).toContain("ARTIFACT-CONTRACT-BINDING");
    expect(findings.some((f) => f.severity === "blocker")).toBe(true);
  });

  it("returns no findings for an empty produces declaration", () => {
    const findings = evaluateProducesMaterializationContract({
      produces: [],
      oasDoc: unmigratedOas(),
    });
    expect(findings).toHaveLength(0);
  });
});

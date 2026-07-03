import { describe, it, expect } from "vitest";

import {
  ARTIFACT_MATERIALIZE_TOOL,
  collectArtifactMaterializeNodesFromOasDocument,
} from "../artifact-binding";

// ---------------------------------------------------------------------------
// Compile-time collector for deterministic `artifact_materialize` passthrough
// nodes (cinatra#925). Statics only: literal tool/extension/declaredMime/
// node_id grammar, node_id ↔ ApiNode-id equality (the ledger output
// identity), produces parity (fail-closed against a KNOWN set), and the
// literal-tool rule on EVERY passthrough-route ApiNode (the dynamic-tool
// bypass — codex round 0 of the #925 lane).
// ---------------------------------------------------------------------------

const EXT = "@cinatra-ai/blog-post-artifact";

function validInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    extension: EXT,
    content: "{{ draft }}",
    title: "{{ title }}",
    declaredMime: "text/markdown",
    node_id: "persist_draft",
    ...overrides,
  };
}

function docWithApiNode(node: Record<string, unknown>): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "flow",
    $referenced_components: { persist_draft: node },
  };
}

function materializeNode(opts?: {
  input?: Record<string, unknown>;
  data?: unknown;
  id?: string;
  url?: string;
}): Record<string, unknown> {
  return {
    component_type: "ApiNode",
    id: opts?.id ?? "persist_draft",
    name: "Persist draft",
    url: opts?.url ?? "{{CINATRA_BASE_URL}}/api/agents/passthrough",
    data:
      opts?.data !== undefined
        ? opts.data
        : {
            tool: ARTIFACT_MATERIALIZE_TOOL,
            agent_run_id: "{{ cinatra_run_id }}",
            input: opts?.input ?? validInput(),
          },
  };
}

describe("collectArtifactMaterializeNodesFromOasDocument", () => {
  it("collects a valid node whose extension is in produces", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode()),
      { produces: [EXT] },
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toEqual([
      { nodeId: "persist_draft", extension: EXT, declaredMime: "text/markdown" },
    ]);
  });

  it("skips the produces check when the set is unknown (null)", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode()),
      { produces: null },
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  it("fails closed on an EMPTY known produces set", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode()),
      { produces: [] },
    );
    expect(result.nodes).toEqual([]);
    expect(result.errors.join("\n")).toContain("cinatra.produces");
  });

  it("rejects an extension not declared in produces", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode()),
      { produces: ["@cinatra-ai/other-artifact"] },
    );
    expect(result.nodes).toEqual([]);
    expect(result.errors[0]).toContain(EXT);
    expect(result.errors[0]).toContain("cinatra.produces");
  });

  it("rejects a templated (non-literal) extension", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ input: validInput({ extension: "{{ ext }}" }) })),
    );
    expect(result.errors[0]).toContain("literal artifact-extension package name");
  });

  it("rejects a non-authorable declaredMime", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ input: validInput({ declaredMime: "image/png" }) }),
      ),
    );
    expect(result.errors[0]).toContain("not text-authorable");
  });

  it("rejects node_id that does not equal the ApiNode's own id", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ input: validInput({ node_id: "other_node" }) })),
    );
    expect(result.nodes).toEqual([]);
    expect(result.errors[0]).toContain('"other_node" must equal this ApiNode\'s id ("persist_draft")');
  });

  it("rejects a templated node_id", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ input: validInput({ node_id: "{{ node }}" }) }),
      ),
    );
    expect(result.errors[0]).toContain("node_id");
    expect(result.errors[0]).toContain("literal");
  });

  it("rejects missing content/title", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ input: validInput({ content: undefined, title: "" }) }),
      ),
    );
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join("\n")).toContain("input.content");
    expect(result.errors.join("\n")).toContain("input.title");
  });

  it("rejects a templated contentJsonField", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ input: validInput({ contentJsonField: "{{ f }}" }) }),
      ),
    );
    expect(result.errors[0]).toContain("contentJsonField");
  });

  it("accepts a literal contentJsonField", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ input: validInput({ contentJsonField: "body" }) }),
      ),
      { produces: [EXT] },
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  it("rejects a missing/non-object data.input", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ data: { tool: ARTIFACT_MATERIALIZE_TOOL } }),
      ),
    );
    expect(result.errors[0]).toContain("data.input");
  });

  it("rejects a templated data.tool on ANY passthrough node (dynamic-tool bypass)", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({ data: { tool: "{{ toolName }}", input: {} } }),
      ),
    );
    expect(result.errors[0]).toContain("must be a literal string");
  });

  it("passes an object-shaped passthrough node with a literal OTHER tool untouched", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          data: { tool: "objects_save", input: { _shape: "x" } },
        }),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toEqual([]);
  });

  it("validates a JSON-STRING data block that parses to an object", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          data: JSON.stringify({
            tool: ARTIFACT_MATERIALIZE_TOOL,
            input: validInput(),
          }),
        }),
      ),
      { produces: [EXT] },
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  it("rejects ANY unparseable string data block (dynamic-payload bypass)", () => {
    // A block that mentions the tool...
    let result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          data: '{"tool": "artifact_materialize", "input": {{ mangled }}',
        }),
      ),
    );
    expect(result.errors[0]).toContain("statically validatable");

    // ...and a fully-templated block that could RESOLVE to the tool at run
    // time with every static check skipped (codex round 1).
    result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ data: "{{ passthrough_payload }}" })),
    );
    expect(result.errors[0]).toContain("statically validatable");
  });

  it("ignores non-passthrough ApiNodes entirely", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
          data: { tool: "{{ dynamic }}" },
        }),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toEqual([]);
  });

  it("walks FlowNode subflows", () => {
    const doc = {
      component_type: "Flow",
      id: "flow",
      $referenced_components: {
        child: {
          component_type: "FlowNode",
          id: "child",
          subflow: {
            component_type: "Flow",
            id: "sub",
            $referenced_components: {
              persist_draft: materializeNode({
                input: validInput({ node_id: "other" }),
              }),
            },
          },
        },
      },
    };
    const result = collectArtifactMaterializeNodesFromOasDocument(doc);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("node_id");
  });
});

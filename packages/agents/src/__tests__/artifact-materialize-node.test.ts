import { describe, it, expect } from "vitest";

import {
  ARTIFACT_MATERIALIZE_TOOL,
  collectArtifactMaterializeNodesFromOasDocument,
  MATERIALIZE_LIST_NODE_ID_PREFIX,
  MAX_MATERIALIZE_LIST_VALUE_CHARS,
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

// ---------------------------------------------------------------------------
// THE SAME-ARTIFACT REVISION's call grammar (cinatra#3030, item 0.30;
// convergence round). The runtime shaper accepts an APPEND — a call naming the
// artifact it revises AND the revision it read, with no title, since the
// artifact already carries one. The compiler must accept exactly the same
// calls, or the road is unreachable from a published package.
// ---------------------------------------------------------------------------
describe("the append call grammar", () => {
  function appendInput(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      extension: EXT,
      content: "{{ picture_section }}",
      declaredMime: "text/markdown",
      node_id: "persist_draft",
      artifactId: "{{ draft_artifact_id }}",
      baseRepresentationRevisionId: "{{ draft_revision_id }}",
      ...overrides,
    };
  }

  it("accepts an append that names the artifact and the revision it read, without a title", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ input: appendInput() })),
      { produces: [EXT] },
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  it("refuses an artifactId without the revision it read", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          input: appendInput({ baseRepresentationRevisionId: undefined, title: "{{ title }}" }),
        }),
      ),
      { produces: [EXT] },
    );
    expect(result.errors.join("\n")).toMatch(/baseRepresentationRevisionId/);
  });

  it("refuses a base revision without the artifact it revises", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          input: appendInput({ artifactId: undefined, title: "{{ title }}" }),
        }),
      ),
      { produces: [EXT] },
    );
    expect(result.errors.join("\n")).toMatch(/artifactId/);
  });

  it("still requires a title on a CREATE (the control)", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(
        materializeNode({
          input: {
            extension: EXT,
            content: "{{ draft }}",
            declaredMime: "text/markdown",
            node_id: "persist_draft",
          },
        }),
      ),
      { produces: [EXT] },
    );
    expect(result.errors.join("\n")).toMatch(/title/);
  });
});

describe("the list call grammar (cinatra#3089)", () => {
  const listInput = (overrides?: Record<string, unknown>) =>
    validInput({ title: undefined, memberContentField: "body", memberTitleField: "subject", ...overrides });

  it("accepts a list call that names both member fields and carries no top-level title", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ input: listInput() })),
      { produces: [EXT] },
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  it("refuses a list call that also carries a top-level title", () => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ input: listInput({ title: "{{ title }}" }) })),
      { produces: [EXT] },
    );
    expect(result.nodes).toHaveLength(0);
    expect(result.errors.join("\n")).toMatch(/input\.title: cannot be combined with a list call/);
  });
});

describe("the list call refusals the runtime shaper applies, decided at compile time (cinatra#3089)", () => {
  const listInput = (overrides?: Record<string, unknown>) =>
    validInput({ title: undefined, memberContentField: "body", memberTitleField: "subject", ...overrides });
  const compileErrors = (input: Record<string, unknown>, id = "persist_draft") => {
    const result = collectArtifactMaterializeNodesFromOasDocument(
      docWithApiNode(materializeNode({ id, input })),
      { produces: [EXT] },
    );
    if (result.errors.length > 0) expect(result.nodes).toHaveLength(0);
    return result.errors.join("\n");
  };

  it("refuses a node whose id and node_id are under the reserved list prefix", () => {
    const id = `${MATERIALIZE_LIST_NODE_ID_PREFIX}persist_draft`;
    expect(compileErrors(validInput({ node_id: id }), id)).toMatch(/input\.node_id: .*reserved ledger namespace/);
  });

  it("refuses a member field name that is blank or padded", () => {
    expect(compileErrors(listInput({ memberTitleField: " subject" }))).toMatch(/input\.memberTitleField: /);
    expect(compileErrors(listInput({ memberContentField: "  " }))).toMatch(/input\.memberContentField: /);
  });

  it("refuses memberDataFields that is not an array of field names", () => {
    expect(compileErrors(listInput({ memberDataFields: "contactId" }))).toMatch(/input\.memberDataFields: must be an array/);
    expect(compileErrors(listInput({ memberDataFields: ["contactId", "campaignId "] }))).toMatch(/input\.memberDataFields\[1\]: /);
  });

  it("refuses memberData that is not an object of non-blank string values within the limit", () => {
    expect(compileErrors(listInput({ memberData: ["x"] }))).toMatch(/input\.memberData: must be an object/);
    expect(compileErrors(listInput({ memberData: { campaignId: 7 } }))).toMatch(/input\.memberData\.campaignId: /);
    expect(compileErrors(listInput({ memberData: { campaignId: " " } }))).toMatch(/input\.memberData\.campaignId: /);
    expect(
      compileErrors(listInput({ memberData: { campaignId: "x".repeat(MAX_MATERIALIZE_LIST_VALUE_CHARS + 1) } })),
    ).toMatch(/input\.memberData\.campaignId: /);
    expect(compileErrors(listInput({ memberData: { " campaignId": "c-1" } }))).toMatch(/input\.memberData: field name/);
    expect(compileErrors(listInput({ memberData: { campaignId: "{{ campaign_id }}" } }))).toBe("");
  });

  it("refuses the reserved typed field runId as a member field or a call-wide value", () => {
    expect(compileErrors(listInput({ memberDataFields: ["runId"] }))).toMatch(/cannot set the typed field "runId"/);
    expect(compileErrors(listInput({ memberData: { runId: "r-1" } }))).toMatch(/cannot set the typed field "runId"/);
  });

  it("refuses a typed field that is both a member field and a call-wide value", () => {
    expect(compileErrors(listInput({ memberDataFields: ["campaignId"], memberData: { campaignId: "c-1" } }))).toMatch(
      /"campaignId" is both a member field and a call-wide value/,
    );
  });

  it("refuses memberDataFields or memberData on a call that is not a list call", () => {
    expect(compileErrors(validInput({ memberDataFields: ["contactId"] }))).toMatch(/input\.memberDataFields: belongs to a list call/);
    expect(compileErrors(validInput({ memberData: { campaignId: "c-1" } }))).toMatch(/input\.memberData: belongs to a list call/);
  });
});

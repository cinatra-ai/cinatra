import { describe, it, expect } from "vitest";

import {
  ARTIFACT_MATERIALIZE_TOOL,
  collectArtifactMaterializeNodesFromOasDocument,
} from "../artifact-binding";

// ---------------------------------------------------------------------------
// cinatra#3089 — the compile check of the `artifact_materialize` LIST MODE:
// `memberContentField` and `memberTitleField` are literals, given together, and
// replace the top-level title; a list call is never an append and never takes
// `contentJsonField`.
// ---------------------------------------------------------------------------

const EXT = "@cinatra-ai/email-artifacts";

function listInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    extension: EXT,
    content: "{{ drafts_json }}",
    memberContentField: "body",
    memberTitleField: "subject",
    declaredMime: "text/markdown",
    node_id: "file_drafts",
    ...overrides,
  };
}

function docWith(input: Record<string, unknown>): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "flow",
    $referenced_components: {
      file_drafts: {
        component_type: "ApiNode",
        id: "file_drafts",
        name: "File drafts",
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        data: { tool: ARTIFACT_MATERIALIZE_TOOL, agent_run_id: "{{ cinatra_run_id }}", input },
      },
    },
  };
}

const collect = (input: Record<string, unknown>) =>
  collectArtifactMaterializeNodesFromOasDocument(docWith(input), { produces: [EXT] });

describe("collectArtifactMaterializeNodesFromOasDocument — list mode (cinatra#3089)", () => {
  // red-first-expect: expected [ Array(1) ] to deeply equal []
  it("accepts a list call with both literal member fields and no title", () => {
    const result = collect(listInput());
    expect(result.errors).toEqual([]);
    expect(result.nodes).toEqual([{ nodeId: "file_drafts", extension: EXT, declaredMime: "text/markdown" }]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it.each([
    ["memberContentField", "memberTitleField"],
    ["memberTitleField", "memberContentField"],
  ])("refuses %s given without %s", (_given, missing) => {
    const input = listInput();
    delete input[missing];
    const result = collect(input);
    expect(result.nodes).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining(`data.input.${missing}: a list call names the content AND the title`),
    ]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it.each(["memberContentField", "memberTitleField"])("refuses a templated %s", (field) => {
    const result = collect(listInput({ [field]: "{{ f }}" }));
    expect(result.nodes).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining(`data.input.${field}: when present, must be a literal field name`),
    ]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it.each([
    ["memberContentField", " "],
    ["memberContentField", " body "],
    ["memberTitleField", ""],
    ["memberTitleField", "subject\t"],
  ])("refuses %s %j: the runtime reads the property by exactly this name", (field, name) => {
    const result = collect(listInput({ [field]: name }));
    expect(result.nodes).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining(`data.input.${field}: when present, must be a literal field name with no surrounding whitespace`),
    ]);
  });

  // red-first-expect: to contain 'data.input.
  it.each([
    ["title", { title: "{{ title }}" }],
    ["contentJsonField", { contentJsonField: "body" }],
    ["artifactId", { artifactId: "{{ a }}", baseRepresentationRevisionId: "{{ r }}" }],
  ])("refuses a list call combined with %s", (field, extra) => {
    const result = collect(listInput(extra));
    expect(result.errors.join("\n")).toContain(`data.input.${field}: cannot be combined with a list call`);
    expect(result.nodes).toEqual([]);
  });

  it("still requires a title on a single call", () => {
    const input = listInput();
    delete input.memberContentField;
    delete input.memberTitleField;
    const result = collect(input);
    expect(result.errors).toEqual([expect.stringContaining("data.input.title: must be a non-empty string")]);
  });
});

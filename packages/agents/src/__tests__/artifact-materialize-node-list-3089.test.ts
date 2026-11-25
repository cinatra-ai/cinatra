import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  ARTIFACT_MATERIALIZE_TOOL,
  collectArtifactMaterializeNodesFromOasDocument,
  readApiNodeDataObject,
} from "../artifact-binding";
import { compileOasAgentJson } from "../oas-compiler";
import { checkRegenerateDeclaration } from "../verdaccio/package-contract";

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

/** `siblings` are the response fields beside `input` in the node's `data` (the
 *  route reads them from the same data block); `dataAsText` writes the whole
 *  block as JSON text, the second form the compile check supports. */
function docWith(
  input: Record<string, unknown>,
  siblings: Record<string, unknown> = {},
  dataAsText = false,
): Record<string, unknown> {
  const data = { tool: ARTIFACT_MATERIALIZE_TOOL, agent_run_id: "{{ cinatra_run_id }}", input, ...siblings };
  return {
    component_type: "Flow",
    id: "flow",
    $referenced_components: {
      file_drafts: {
        component_type: "ApiNode",
        id: "file_drafts",
        name: "File drafts",
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        data: dataAsText ? JSON.stringify(data) : data,
      },
    },
  };
}

const collect = (input: Record<string, unknown>, siblings: Record<string, unknown> = {}, dataAsText = false) =>
  collectArtifactMaterializeNodesFromOasDocument(docWith(input, siblings, dataAsText), { produces: [EXT] });

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

  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("refuses a title field and a content field that name the same member field, in %s", (_name, dataAsText) => {
    const result = collect(listInput({ memberContentField: "body", memberTitleField: "body" }), {}, dataAsText);
    expect(result.nodes).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining(
        "data.input.memberTitleField: artifact_materialize: memberContentField and memberTitleField name the same member field",
      ),
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

// ---------------------------------------------------------------------------
// cinatra#3089 — the response fields of a list node. A list filing files one
// artifact per member and has no single id, so a node that declares
// `result_id_field` can never run; it does not compile either. The refusal is
// the route's own (the same code and sentence, one definition).
// ---------------------------------------------------------------------------

const LIST_ID_REFUSAL =
  "artifact_materialize: a list call files one artifact per member and has no single id; " +
  "remove result_id_field and read artifacts (or reviewTargets) from the answer";

const SINGLE_INPUT = (): Record<string, unknown> => {
  const input = listInput({ title: "{{ title }}" });
  delete input.memberContentField;
  delete input.memberTitleField;
  return input;
};

describe("a list call and the response fields of its node (cinatra#3089)", () => {
  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("refuses a list call whose node also declares result_id_field, in %s", (_name, dataAsText) => {
    const result = collect(
      listInput(),
      { result_input_passthrough: true, result_id_field: "artifactId" },
      dataAsText,
    );
    expect(result.errors).toEqual([expect.stringContaining(`data.result_id_field: ${LIST_ID_REFUSAL}`)]);
    expect(result.nodes).toEqual([]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("refuses a list call with result_id_field and no passthrough flag, in %s", (_name, dataAsText) => {
    const result = collect(listInput(), { result_id_field: "artifactId" }, dataAsText);
    expect(result.errors).toEqual([expect.stringContaining("data.result_id_field:")]);
    expect(result.nodes).toEqual([]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal [ StringContaining
  it("refuses a list call that names an empty result_id_field (the route refuses any value)", () => {
    const result = collect(listInput(), { result_id_field: null });
    expect(result.errors).toEqual([expect.stringContaining("data.result_id_field:")]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal []
  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("keeps a list call with result_input_passthrough and no result_id_field valid, in %s", (_name, dataAsText) => {
    const result = collect(listInput(), { result_input_passthrough: true }, dataAsText);
    expect(result.errors).toEqual([]);
    expect(result.nodes).toEqual([{ nodeId: "file_drafts", extension: EXT, declaredMime: "text/markdown" }]);
  });

  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("keeps a single filing with both keys valid, in %s", (_name, dataAsText) => {
    const result = collect(
      SINGLE_INPUT(),
      { result_input_passthrough: true, result_id_field: "artifactId" },
      dataAsText,
    );
    expect(result.errors).toEqual([]);
    expect(result.nodes).toHaveLength(1);
  });

  // red-first-expect: to contain 'artifact_materialize: a list call fil
  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("a flow whose list node declares result_id_field does not compile, in %s", async (_name, dataAsText) => {
    const result = await compileOasAgentJson({
      packageName: PACKAGE_NAME,
      oasSourcePath: stageOas(
        fixtureWithFiling(true, dataAsText, { result_input_passthrough: true, result_id_field: "artifactId" }),
      ),
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(LIST_ID_REFUSAL);
  });

  // red-first-expect: to match object { ok: true }
  it("a flow whose list node asks for its inputs back and names no id field compiles", async () => {
    const result = await compileOasAgentJson({
      packageName: PACKAGE_NAME,
      oasSourcePath: stageOas(fixtureWithFiling(true, false, { result_input_passthrough: true })),
    });
    expect(result).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// cinatra#3089 — a list filing is never the node a Regenerate re-runs: the
// list files one artifact per member, and a Regenerate takes exactly one
// production. A `regenerate` entry whose `artifactNode` is a list filing does
// not compile; a single filing compiles as before.
// ---------------------------------------------------------------------------

const LIST_REFUSAL = "a list filing cannot be the node a Regenerate re-runs";
const PACKAGE_NAME = "@cinatra-ai/synthetic-gemini-agent";
const FILE_NODE = "call_llm_bridge";
const SELF_FILING = [{ artifactNode: FILE_NODE, step: FILE_NODE, noteInput: "user" }];

/** The synthetic fixture with its one ApiNode turned into a passthrough
 *  `artifact_materialize` node that files its own output (single or list). */
function fixtureWithFiling(
  list: boolean,
  dataAsText = false,
  siblings: Record<string, unknown> = {},
): Record<string, unknown> {
  const oas = JSON.parse(readFileSync(join(__dirname, "fixtures", "synthetic-gemini-agent.json"), "utf8"));
  for (const input of [...oas.inputs, ...oas.$referenced_components.start.inputs]) input.default ??= "";
  const node = oas.$referenced_components[FILE_NODE];
  node.url = "{{CINATRA_BASE_URL}}/api/agents/passthrough";
  const input: Record<string, unknown> = {
    extension: EXT,
    content: "{{ user }}",
    declaredMime: "text/markdown",
    node_id: FILE_NODE,
    ...(list ? { memberContentField: "body", memberTitleField: "subject" } : { title: "{{ user }}" }),
  };
  const data = { tool: ARTIFACT_MATERIALIZE_TOOL, agent_run_id: "{{ cinatra_run_id }}", input, ...siblings };
  node.data = dataAsText ? JSON.stringify(data) : data;
  return oas;
}

const NESTED_FLOW_NODE = "side_lane";

/** Adds a FlowNode whose inline subflow holds its OWN node under the id
 *  `FILE_NODE` (a list filing or a single filing). Ids inside a nested flow are
 *  local to that flow; they are never the root target of the same name. */
function withNestedFiling(oas: Record<string, unknown>, list: boolean): Record<string, unknown> {
  const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
  const input: Record<string, unknown> = {
    extension: EXT,
    content: "{{ user }}",
    declaredMime: "text/markdown",
    node_id: FILE_NODE,
    ...(list ? { memberContentField: "body", memberTitleField: "subject" } : { title: "{{ user }}" }),
  };
  const nested = {
    ...(refs[FILE_NODE] as object),
    id: FILE_NODE,
    data: { tool: ARTIFACT_MATERIALIZE_TOOL, agent_run_id: "{{ cinatra_run_id }}", input },
  };
  refs[NESTED_FLOW_NODE] = {
    component_type: "FlowNode",
    id: NESTED_FLOW_NODE,
    name: "Side lane",
    subflow: {
      component_type: "Flow",
      id: "side-lane-flow",
      name: "Side lane flow",
      start_node: { $component_ref: "side_start" },
      nodes: [{ $component_ref: "side_start" }, { $component_ref: FILE_NODE }],
      $referenced_components: {
        side_start: { component_type: "StartNode", id: "side_start", name: "Start", inputs: [] },
        [FILE_NODE]: nested,
      },
    },
  };
  return oas;
}

function stageOas(oas: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "list-regen-3089-"));
  mkdirSync(join(dir, "cinatra"));
  const oasPath = join(dir, "cinatra", "oas.json");
  writeFileSync(oasPath, JSON.stringify(oas));
  return oasPath;
}

describe("a regenerate entry and a list filing (cinatra#3089)", () => {
  // red-first-expect: to contain 'REGENERATE_DECLARATION_INVALID'
  it("a flow whose regenerate entry names a list filing node does not compile", async () => {
    const result = await compileOasAgentJson({
      packageName: PACKAGE_NAME,
      oasSourcePath: stageOas(fixtureWithFiling(true)),
      retainedRegenerate: SELF_FILING,
    });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain("REGENERATE_DECLARATION_INVALID");
    expect(error).toContain(LIST_REFUSAL);
    expect(error).toContain("regenerating one member needs its own entry");
  });

  it("a flow whose regenerate entry names a single filing node compiles as before", async () => {
    const result = await compileOasAgentJson({
      packageName: PACKAGE_NAME,
      oasSourcePath: stageOas(fixtureWithFiling(false)),
      retainedRegenerate: SELF_FILING,
    });
    expect(result).toMatchObject({ ok: true });
  });

  // red-first-expect: expected { ok: true } to match object { ok: false }
  it.each([
    ["an object data block", false],
    ["a JSON-text data block", true],
  ])("the check refuses a list filing with %s, filed by another step too", (_name, dataAsText) => {
    const oas = fixtureWithFiling(true, dataAsText);
    expect(checkRegenerateDeclaration(oas, SELF_FILING)).toMatchObject({ ok: false });
    // The same node under another ref key, reached by its own id: still refused.
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    refs.file_list = { ...refs[FILE_NODE], id: "file_list" };
    (oas.nodes as unknown[]).push({ $component_ref: "file_list" });
    (oas.data_flow_connections as unknown[]).push({
      component_type: "DataFlowEdge",
      name: "call_text_to_file_list",
      source_node: { $component_ref: FILE_NODE },
      source_output: "text",
      destination_node: { $component_ref: "file_list" },
      destination_input: "user",
    });
    const other = checkRegenerateDeclaration(oas, [{ artifactNode: "file_list", step: FILE_NODE, noteInput: "user" }]);
    expect(other).toMatchObject({ ok: false });
    expect((other as { error: string }).error).toContain(LIST_REFUSAL);
  });

  // red-first-expect: expected { ok: true } to match object { ok: false }
  it("refuses a node that carries only one of the two member fields (fail closed)", () => {
    const oas = fixtureWithFiling(true);
    const input = ((oas.$referenced_components as Record<string, Record<string, Record<string, unknown>>>)[FILE_NODE]!
      .data as Record<string, Record<string, unknown>>).input!;
    delete input.memberTitleField;
    expect(checkRegenerateDeclaration(oas, SELF_FILING)).toMatchObject({ ok: false });
  });

  it("accepts a single filing node in the check", () => {
    expect(checkRegenerateDeclaration(fixtureWithFiling(false), SELF_FILING)).toEqual({ ok: true });
  });

  it("judges the root target by the root node, whatever a nested flow's node of the same id files", () => {
    const oas = withNestedFiling(fixtureWithFiling(false), true);
    expect(checkRegenerateDeclaration(oas, SELF_FILING)).toEqual({ ok: true });
  });

  // red-first-expect: expected { ok: false, …(1) } to match object { ok: true }
  it("a flow whose root target files one result compiles although a nested flow lists under the same id", async () => {
    const result = await compileOasAgentJson({
      packageName: PACKAGE_NAME,
      oasSourcePath: stageOas(withNestedFiling(fixtureWithFiling(false), true)),
      retainedRegenerate: SELF_FILING,
    });
    expect(result).toMatchObject({ ok: true });
  });

  // red-first-expect: expected { ok: true } to match object { ok: false }
  it("still refuses a root list target when a nested flow's node of the same id files one result", () => {
    const oas = withNestedFiling(fixtureWithFiling(true), false);
    const check = checkRegenerateDeclaration(oas, SELF_FILING);
    expect(check).toMatchObject({ ok: false });
    expect((check as { error: string }).error).toContain(LIST_REFUSAL);
  });

  it("names no nested node as a target: an id found only inside a nested flow is not a top-level node", () => {
    const oas = withNestedFiling(fixtureWithFiling(false), true);
    const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
    const nestedRefs = (refs[NESTED_FLOW_NODE]!.subflow as Record<string, Record<string, unknown>>)
      .$referenced_components!;
    nestedRefs.only_nested = { ...(nestedRefs[FILE_NODE] as object), id: "only_nested" };
    const check = checkRegenerateDeclaration(oas, [{ artifactNode: "only_nested", step: FILE_NODE, noteInput: "user" }]);
    expect(check).toMatchObject({ ok: false });
    expect((check as { error: string }).error).toContain('"only_nested" is not a top-level node of the flow');
  });
});

// ---------------------------------------------------------------------------
// cinatra#3089 — ONE reader of an ApiNode's data as an object, used by the
// compile collectors, the list-node reading and the run materializer's reading
// of which node writes: the object form and the JSON-text form of an object,
// and nothing else (what the binding refuses, the reader refuses).
// ---------------------------------------------------------------------------

describe("readApiNodeDataObject (cinatra#3089)", () => {
  const data = { tool: ARTIFACT_MATERIALIZE_TOOL, input: listInput() };

  // red-first-expect: readApiNodeDataObject) is not a function
  it("reads an object as it is and the JSON text of an object as that object", () => {
    expect(readApiNodeDataObject(data)).toBe(data);
    expect(readApiNodeDataObject(JSON.stringify(data))).toEqual(data);
  });

  // red-first-expect: readApiNodeDataObject) is not a function
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 3],
    ["an array", [data]],
    ["text that is not JSON", "{{ passthrough_payload }}"],
    ["JSON text of an array", JSON.stringify([data])],
    ["JSON text of a string", JSON.stringify("x")],
    ["JSON text of null", "null"],
  ])("refuses %s", (_name, value) => {
    expect(readApiNodeDataObject(value)).toBeNull();
  });
});

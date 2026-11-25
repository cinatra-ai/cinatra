import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  ARTIFACT_MATERIALIZE_TOOL,
  collectArtifactMaterializeNodesFromOasDocument,
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
function fixtureWithFiling(list: boolean, dataAsText = false): Record<string, unknown> {
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
  const data = { tool: ARTIFACT_MATERIALIZE_TOOL, agent_run_id: "{{ cinatra_run_id }}", input };
  node.data = dataAsText ? JSON.stringify(data) : data;
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
});

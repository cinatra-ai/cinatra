/**
 * cinatra#2484 — the compiled `inputSchema` must carry an OBJECT-typed
 * StartNode input's sub-shape.
 *
 * An object input declares `{title, summary, outline}` under
 * `json_schema.properties` (+ `json_schema.required`) — the same agentspec
 * nesting the array case uses for `json_schema.items`. Before this lift the
 * compiled property was a bare `{type:"object"}`: the Setup form had nothing to
 * build sub-fields from, degraded to ONE free-text box, and accepted a bare
 * sentence — so `input_params.idea` reached the run as a string and the write
 * step failed far from the cause.
 *
 * Mirror of the runtime path covered by
 * `input-schema-resolver-items-from-json-schema.test.ts` (the derive-from-disk
 * resolver); this file pins the PERSISTED compiled schema.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/oas-compiler-object-input-properties.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

/** Minimal valid Flow whose StartNode carries exactly the given inputs. */
function buildAgentJson(inputs: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    metadata: { cinatra: { type: "leaf" } },
    inputs,
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [{ $component_ref: "startNode" }, { $component_ref: "endNode" }],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-end",
        from_node: { $component_ref: "startNode" },
        to_node: { $component_ref: "endNode" },
      },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Start",
        inputs,
        metadata: { cinatra: { required: ["idea"] } },
      },
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas-compiler-object-input-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function compileInputs(
  inputs: Array<Record<string, unknown>>,
): Promise<Record<string, Record<string, unknown>>> {
  const agentJsonPath = path.join(tempDir, "agent.json");
  writeFileSync(agentJsonPath, JSON.stringify(buildAgentJson(inputs), null, 2));
  const result = await compileOasAgentJson({
    packageName: "@test/pkg",
    oasSourcePath: agentJsonPath,
    registryPath: path.join(tempDir, "components.json"),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("compile failed");
  return (
    result.value.inputSchema as { properties: Record<string, Record<string, unknown>> }
  ).properties;
}

describe("oas-compiler — object input sub-shape (cinatra#2484)", () => {
  it("lifts `json_schema.properties` + `json_schema.required` onto the compiled property", async () => {
    const properties = await compileInputs([
      {
        title: "idea",
        type: "object",
        json_schema: {
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            outline: { type: "array", items: { type: "string" } },
          },
          required: ["title"],
        },
      },
    ]);
    const idea = properties.idea;
    expect(idea.type).toBe("object");
    expect(idea.properties).toEqual({
      title: { type: "string" },
      summary: { type: "string" },
      outline: { type: "array", items: { type: "string" } },
    });
    expect(idea.required).toEqual(["title"]);
  });

  it("accepts the flat top-level `properties` shape and prefers it when both are present", async () => {
    const properties = await compileInputs([
      {
        title: "idea",
        type: "object",
        properties: { top: { type: "string" } },
        json_schema: { properties: { nested: { type: "string" } } },
      },
    ]);
    expect(properties.idea.properties).toEqual({ top: { type: "string" } });
  });

  it("leaves a SCHEMA-LESS object input bare — the renderer's validation leg owns it", async () => {
    // blog-draft-writer@0.1.2's `idea`: type "object", no json_schema at all.
    const properties = await compileInputs([{ title: "idea", type: "object" }]);
    expect(properties.idea.type).toBe("object");
    expect(properties.idea.properties).toBeUndefined();
    expect(properties.idea.required).toBeUndefined();
  });

  it("never injects `properties` into a non-object input", async () => {
    const properties = await compileInputs([
      { title: "idea", type: "object" },
      {
        title: "notes",
        type: "string",
        json_schema: { properties: { a: { type: "string" } } },
      },
    ]);
    expect(properties.notes.properties).toBeUndefined();
  });
});

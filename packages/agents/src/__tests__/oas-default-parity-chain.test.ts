/**
 * compile -> store -> pre-dispatch guard, for the descriptor that decides it
 * (cinatra#3003).
 *
 * The runtime starts the conversation from the FLOW's own `inputs`. If the
 * compiled schema took its `default` from the StartNode copy instead, a
 * StartNode-only default would land in the stored schema, clear the guard's
 * suspicion, and the run would still die at the runtime — the guard bypassed by
 * the very field it reads. This walks the real chain rather than asserting the
 * compiler in isolation.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { compileOasAgentJson } from "../oas-compiler";
import { findUnsatisfiableHiddenInputs } from "../input-schema-resolver";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "oas-default-parity-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/**
 * One hidden input (`ghost`) plus one visible required input. `flowDefault` and
 * `startDefault` place `"default": ""` on the Flow and StartNode descriptors
 * independently, which is the whole point of the fixture.
 */
function oasWithDefaults(flowDefault: boolean, startDefault: boolean) {
  const desc = (withDefault: boolean) => [
    { title: "visible", type: "string" },
    { title: "ghost", type: "string", ...(withDefault ? { default: "" } : {}) },
  ];
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "@acme/parity-agent",
    name: "Parity Agent",
    metadata: { cinatra: { type: "node", packageName: "@acme/parity-agent" } },
    inputs: desc(flowDefault),
    outputs: [{ title: "result", type: "string" }],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "api" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start_to_api",
        from_node: { $component_ref: "start" },
        to_node: { $component_ref: "api" },
      },
      {
        component_type: "ControlFlowEdge",
        name: "api_to_end",
        from_node: { $component_ref: "api" },
        to_node: { $component_ref: "end" },
      },
    ],
    data_flow_connections: [
      ...["visible", "ghost"].map((t) => ({
        component_type: "DataFlowEdge",
        name: `start_${t}_to_api_${t}`,
        source_node: { $component_ref: "start" },
        source_output: t,
        destination_node: { $component_ref: "api" },
        destination_input: t,
      })),
      {
        component_type: "DataFlowEdge",
        name: "api_result_to_end_result",
        source_node: { $component_ref: "api" },
        source_output: "result",
        destination_node: { $component_ref: "end" },
        destination_input: "result",
      },
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Inputs",
        metadata: { cinatra: { required: ["visible"], hidden: ["ghost"] } },
        inputs: desc(startDefault),
      },
      api: {
        component_type: "ApiNode",
        id: "api",
        name: "Call",
        inputs: [
          { title: "visible", type: "string" },
          { title: "ghost", type: "string" },
        ],
        outputs: [{ title: "result", type: "string" }],
        data: { user: "visible={{ visible }} ghost={{ ghost }}" },
        url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
        http_method: "POST",
      },
      end: {
        component_type: "EndNode",
        id: "end",
        name: "Outputs",
        inputs: [{ title: "result", type: "string" }],
        outputs: [{ title: "result", type: "string" }],
      },
    },
  };
}

async function compiledGhost(flowDefault: boolean, startDefault: boolean) {
  const p = join(dir, `oas-${flowDefault ? "f" : "x"}${startDefault ? "s" : "x"}.json`);
  await writeFile(p, JSON.stringify(oasWithDefaults(flowDefault, startDefault)), "utf8");
  const res = await compileOasAgentJson({
    packageName: "@acme/parity-agent",
    oasSourcePath: p,
  });
  expect(res.ok, `compile failed: ${res.ok ? "" : res.error}`).toBe(true);
  const schema = (res as unknown as {
    value: { inputSchema: { properties: Record<string, Record<string, unknown>> } };
  }).value.inputSchema;
  return schema.properties.ghost;
}

describe("compiled default parity — the Flow descriptor decides (cinatra#3003)", () => {
  it("a StartNode-ONLY default does not reach the compiled schema, so the guard still fires", async () => {
    const ghost = await compiledGhost(false, true);
    expect(ghost["x-hidden"]).toBe(true);
    expect("default" in ghost).toBe(false);
    // ...and the stored schema therefore keeps the suspicion alive all the way
    // to the pre-dispatch guard, which confirms it against the same Flow.
    expect(
      findUnsatisfiableHiddenInputs({
        properties: { ghost },
        alreadySupplied: {},
        packageName: "@acme/parity-agent",
      }),
    ).toEqual([{ agent: "@acme/parity-agent", input: "ghost" }]);
  });

  it("a FLOW default reaches the compiled schema and clears the guard", async () => {
    const ghost = await compiledGhost(true, true);
    expect(ghost["x-hidden"]).toBe(true);
    expect(ghost.default).toBe("");
    expect(
      findUnsatisfiableHiddenInputs({
        properties: { ghost },
        alreadySupplied: {},
        packageName: "@acme/parity-agent",
      }),
    ).toEqual([]);
  });

  it("a Flow default with no StartNode copy still reaches the compiled schema", async () => {
    const ghost = await compiledGhost(true, false);
    expect(ghost.default).toBe("");
  });
});

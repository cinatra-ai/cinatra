import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

// ---------------------------------------------------------------------------
// Compiler wiring for deterministic `artifact_materialize` passthrough nodes
// (cinatra#925). The collector grammar is covered in
// artifact-materialize-node.test.ts; here we pin that compileOasAgentJson
// (a) passes a valid node whose extension is declared in the sibling
// package.json `cinatra.produces`, (b) fails loudly on an UNDECLARED
// extension (the issue's acceptance criterion), and (c) fails on a grammar
// violation (node_id mismatch).
// ---------------------------------------------------------------------------

const EXT = "@cinatra-ai/blog-post-artifact";

function buildOas(input: Record<string, unknown>): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    metadata: { cinatra: { type: "leaf" } },
    inputs: [{ title: "topic", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [
      { $component_ref: "startNode" },
      { $component_ref: "persist" },
      { $component_ref: "endNode" },
    ],
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "start-to-persist",
        from_node: { $component_ref: "startNode" },
        to_node: { $component_ref: "persist" },
      },
      {
        component_type: "ControlFlowEdge",
        name: "persist-to-end",
        from_node: { $component_ref: "persist" },
        to_node: { $component_ref: "endNode" },
      },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Start",
        inputs: [{ title: "topic", type: "string" }],
      },
      persist: {
        component_type: "ApiNode",
        id: "persist",
        name: "Persist artifact",
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        http_method: "POST",
        data: {
          tool: "artifact_materialize",
          agent_run_id: "{{ cinatra_run_id }}",
          input,
        },
      },
      endNode: {
        component_type: "EndNode",
        id: "endNode",
        name: "End",
        outputs: [{ title: "draft", type: "string" }],
      },
    },
  };
}

const VALID_INPUT = {
  extension: EXT,
  content: "{{ draft }}",
  title: "{{ title }}",
  declaredMime: "text/markdown",
  node_id: "persist",
};

let tempDir: string;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas-materialize-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** cinatra/ package layout: <root>/package.json + <root>/cinatra/oas.json. */
function writeFixture(opts: {
  input: Record<string, unknown>;
  produces?: Array<{ extension: string }>;
}): string {
  const cinatraDir = path.join(tempDir, "cinatra");
  mkdirSync(cinatraDir, { recursive: true });
  const oasPath = path.join(cinatraDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildOas(opts.input), null, 2));
  writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify(
      {
        name: "@test/pkg",
        version: "1.0.0",
        cinatra: { produces: opts.produces ?? [{ extension: EXT }] },
      },
      null,
      2,
    ),
  );
  return oasPath;
}

async function compile(oasPath: string) {
  return compileOasAgentJson({
    packageName: "@test/pkg",
    oasSourcePath: oasPath,
    registryPath: path.join(tempDir, "components.json"),
  });
}

describe("oas-compiler — artifact_materialize passthrough nodes", () => {
  it("compiles a valid node whose extension is in cinatra.produces", async () => {
    const result = await compile(writeFixture({ input: VALID_INPUT }));
    expect(result.ok).toBe(true);
  });

  it("fails compile when the extension is NOT declared in produces", async () => {
    const result = await compile(
      writeFixture({
        input: VALID_INPUT,
        produces: [{ extension: "@cinatra-ai/other-artifact" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("artifact_materialize node validation failed");
    expect(result.error).toContain(EXT);
    expect(result.error).toContain("cinatra.produces");
  });

  it("fails compile on a node_id ≠ ApiNode-id grammar violation", async () => {
    const result = await compile(
      writeFixture({ input: { ...VALID_INPUT, node_id: "someone_else" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("artifact_materialize node validation failed");
    expect(result.error).toContain("node_id");
  });
});

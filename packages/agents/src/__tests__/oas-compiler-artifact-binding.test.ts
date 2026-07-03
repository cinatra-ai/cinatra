import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";

// ---------------------------------------------------------------------------
// Compiler wiring for declarative artifact-output bindings (cinatra#923).
//
// The grammar itself is covered in artifact-binding.test.ts; here we pin
// that compileOasAgentJson (a) passes a valid annotated OAS, (b) fails
// loudly on an invalid binding, and (c) enforces binding↔produces parity
// against the SIBLING package.json (the cinatra/ layout) — and skips parity
// when no package.json is readable.
// ---------------------------------------------------------------------------

function buildOas(binding: Record<string, unknown> | null): Record<string, unknown> {
  const draftOutput: Record<string, unknown> = { title: "draft", type: "string" };
  if (binding) draftOutput.cinatra = { artifact: binding };
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-flow",
    name: "Test Flow",
    metadata: { cinatra: { type: "leaf" } },
    inputs: [{ title: "topic", type: "string" }],
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
        inputs: [{ title: "topic", type: "string" }],
      },
      endNode: {
        component_type: "EndNode",
        id: "endNode",
        name: "End",
        outputs: [draftOutput, { title: "title", type: "string" }],
      },
    },
  };
}

const VALID_BINDING = {
  extension: "@cinatra-ai/blog-post-artifact",
  contentFrom: "draft",
  declaredMime: "text/markdown",
  titleFrom: "title",
};

let tempDir: string;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas-binding-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** cinatra/ package layout: <root>/package.json + <root>/cinatra/oas.json. */
function writeFixture(opts: {
  binding: Record<string, unknown> | null;
  packageJson?: Record<string, unknown> | null;
}): string {
  const cinatraDir = path.join(tempDir, "cinatra");
  mkdirSync(cinatraDir, { recursive: true });
  const oasPath = path.join(cinatraDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildOas(opts.binding), null, 2));
  if (opts.packageJson !== null) {
    writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        opts.packageJson ?? {
          name: "@test/pkg",
          version: "1.0.0",
          cinatra: { produces: [{ extension: VALID_BINDING.extension }] },
        },
        null,
        2,
      ),
    );
  }
  return oasPath;
}

async function compile(oasPath: string) {
  return compileOasAgentJson({
    packageName: "@test/pkg",
    oasSourcePath: oasPath,
    registryPath: path.join(tempDir, "components.json"),
  });
}

describe("oas-compiler — artifact output bindings", () => {
  it("compiles a valid binding whose extension is in cinatra.produces", async () => {
    const result = await compile(writeFixture({ binding: VALID_BINDING }));
    expect(result.ok).toBe(true);
  });

  it("fails on a malformed binding (XOR violation) with a located error", async () => {
    const result = await compile(
      writeFixture({ binding: { ...VALID_BINDING, mimeFrom: "title" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("artifact output-binding validation failed");
    expect(result.error).toContain("declaredMime / mimeFrom");
  });

  it("fails when the binding references a non-existent EndNode output", async () => {
    const result = await compile(
      writeFixture({ binding: { ...VALID_BINDING, titleFrom: "ghost" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"ghost" does not name an output of EndNode');
  });

  it("fails binding↔produces parity against the sibling package.json", async () => {
    const result = await compile(
      writeFixture({
        binding: VALID_BINDING,
        packageJson: {
          name: "@test/pkg",
          version: "1.0.0",
          cinatra: { produces: [{ extension: "@cinatra-ai/other-artifact" }] },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cinatra.produces");
  });

  it("skips parity when no sibling package.json is readable (builder path)", async () => {
    const result = await compile(
      writeFixture({ binding: VALID_BINDING, packageJson: null }),
    );
    expect(result.ok).toBe(true);
  });

  it("still compiles an un-annotated OAS (no bindings, no errors)", async () => {
    const result = await compile(writeFixture({ binding: null }));
    expect(result.ok).toBe(true);
  });
});

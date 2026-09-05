import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compileOasAgentJson, __resetRegistryCacheForTests } from "../oas-compiler";
import { producesWithoutMaterializationRoad } from "../artifact-binding";

// ---------------------------------------------------------------------------
// A PROMISE WITH NO ROAD IS NAMED, NOT SWALLOWED (cinatra#3051).
//
// Binding parity has always been checked in one direction: a binding must name
// an extension the sibling manifest's `cinatra.produces` promises. This pins the
// other direction — a promised extension that the service description wires NO
// road for (no `outputs[].cinatra.artifact` binding, no `artifact_materialize`
// node) is NAMED at compile, once, where a person installing the package can
// read it.
//
// FOUND WHILE DIAGNOSING A DIFFERENT SILENCE. The eighth proof round's empty
// runs were NOT this: that agent does declare a binding, on its EndNode
// `content` output, and its cause is pinned in
// `src/lib/artifacts/__tests__/binding-flag-disagreement-is-loud.test.ts`. This
// is the same SHAPE of fault caught on the way past — a declaration nobody can
// act on, saying so nowhere — and one agent in the fleet is in exactly this
// state today.
//
// THE COMPILE STILL SUCCEEDS. A refusal would take a working install road away
// from a package whose only fault is an unkept promise. The change is that the
// contradiction says its own name.
// ---------------------------------------------------------------------------

const PRODUCES_EXT = "@cinatra-ai/blog-post-artifact";

function buildOas(opts: { bindOutput?: boolean }): Record<string, unknown> {
  const outputs: Array<Record<string, unknown>> = [
    { title: "title", type: "string" },
    opts.bindOutput
      ? {
          title: "content",
          type: "string",
          cinatra: {
            artifact: {
              extension: PRODUCES_EXT,
              titleFrom: "title",
              contentFrom: "content",
              declaredMime: "text/markdown",
            },
          },
        }
      : { title: "content", type: "string" },
  ];
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "road-flow",
    name: "Road Flow",
    metadata: { cinatra: { type: "leaf" } },
    inputs: [{ title: "topic", type: "string" }],
    outputs,
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
        outputs,
      },
    },
  };
}

let tempDir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "produces-road-"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(opts: { bindOutput?: boolean; manifestProduces?: unknown }): string {
  const cinatraDir = path.join(tempDir, "cinatra");
  mkdirSync(cinatraDir, { recursive: true });
  const oasPath = path.join(cinatraDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildOas({ bindOutput: opts.bindOutput }), null, 2));
  writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify(
      {
        name: "@test/road-agent",
        version: "1.0.0",
        cinatra:
          opts.manifestProduces === undefined ? {} : { produces: opts.manifestProduces },
      },
      null,
      2,
    ),
  );
  return oasPath;
}

async function compile(oasPath: string) {
  return compileOasAgentJson({
    oasSourcePath: oasPath,
    packageName: "@test/road-agent",
    packageVersion: "1.0.0",
  } as Parameters<typeof compileOasAgentJson>[0]);
}

function warnings(): string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

describe("the compiler names a cinatra.produces entry it wired no road for", () => {
  it("NAMES the unkept promise — the exact shape the eighth proof round hit", async () => {
    const oasPath = writeFixture({
      bindOutput: false,
      manifestProduces: [{ extension: PRODUCES_EXT }],
    });
    const res = await compile(oasPath);

    // The package still installs. The point is that it no longer does so in
    // silence.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hasArtifactBindings).toBe(false);

    const named = warnings().filter((line) => line.includes("[artifact-binding]"));
    expect(named.length).toBe(1);
    expect(named[0]).toContain("@test/road-agent");
    expect(named[0]).toContain(PRODUCES_EXT);
    expect(named[0]).toContain("outputs[].cinatra.artifact");
    expect(named[0]).toContain("artifact_materialize");
    expect(named[0]).toContain("opens no review gate");
  });

  it("says NOTHING when the promise has a road — one bound output is a road", async () => {
    const oasPath = writeFixture({
      bindOutput: true,
      manifestProduces: [{ extension: PRODUCES_EXT }],
    });
    const res = await compile(oasPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hasArtifactBindings).toBe(true);
    expect(warnings().filter((line) => line.includes("[artifact-binding]"))).toEqual([]);
  });

  it("says NOTHING when nothing was promised — an unpromised agent owes nothing", async () => {
    const oasPath = writeFixture({ bindOutput: false, manifestProduces: undefined });
    const res = await compile(oasPath);
    expect(res.ok).toBe(true);
    expect(warnings().filter((line) => line.includes("[artifact-binding]"))).toEqual([]);
  });
});

describe("producesWithoutMaterializationRoad (the pure rule)", () => {
  const road = { bindings: [], materializeNodes: [] };

  it("returns the promised extensions no road names, sorted and de-duplicated", () => {
    expect(
      producesWithoutMaterializationRoad(
        [{ extension: "@z/b" }, { extension: "@a/b" }, { extension: "@a/b" }],
        road,
      ),
    ).toEqual(["@a/b", "@z/b"]);
  });

  it("counts an output binding as a road", () => {
    expect(
      producesWithoutMaterializationRoad([{ extension: "@a/b" }], {
        bindings: [{ binding: { extension: "@a/b" } }],
        materializeNodes: [],
      }),
    ).toEqual([]);
  });

  it("counts an artifact_materialize node as a road", () => {
    expect(
      producesWithoutMaterializationRoad([{ extension: "@a/b" }], {
        bindings: [],
        materializeNodes: [{ extension: "@a/b" }],
      }),
    ).toEqual([]);
  });

  it("does not let a road for ONE extension cover another", () => {
    expect(
      producesWithoutMaterializationRoad([{ extension: "@a/b" }, { extension: "@c/d" }], {
        bindings: [{ binding: { extension: "@a/b" } }],
        materializeNodes: [],
      }),
    ).toEqual(["@c/d"]);
  });

  it("is silent on an unknown or empty produces set — nothing promised, nothing unkept", () => {
    expect(producesWithoutMaterializationRoad(null, road)).toEqual([]);
    expect(producesWithoutMaterializationRoad(undefined, road)).toEqual([]);
    expect(producesWithoutMaterializationRoad([], road)).toEqual([]);
  });
});
